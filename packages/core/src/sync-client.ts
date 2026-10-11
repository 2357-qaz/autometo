// Sync client shared by web and TUI: talks to the AuTomeDo server over HTTP.
import type { Store } from './store';
import type { AppState } from './types';
import { applyResponse, newSyncMeta, prepareSync, reconcile, withRecord, type ConflictNote, type DeleteGuard, type SyncMeta, type SyncRecord, type SyncRequest, type SyncResponse } from './sync';
import * as ops from './ops';

export interface SyncConfig {
  url: string; // e.g. https://automedo.example.com
  token: string;
}

/** Where a client keeps its sync config + bookkeeping (localStorage, a file, …). */
export interface SyncStorage {
  loadConfig(): SyncConfig | null;
  saveConfig(c: SyncConfig | null): void;
  loadMeta(): SyncMeta | null;
  /**
   * Change the meta and durably store it TOGETHER with the store's current state in
   * one atomic write (see createDocPersistence). It must also be the meta that the
   * store's local edits are recorded into, so an update never drops one of them.
   */
  updateMeta(fn: (m: SyncMeta) => SyncMeta): void;
}

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt: number | null;
  error: string | null;
  /** Local changes the server has not acknowledged yet. */
  pending: number;
  /** Sync is paused: the server wants confirmation before this mass deletion. */
  confirm: DeleteGuard | null;
  /** Concurrent edits that were merged and are waiting for the user to look at them. */
  conflicts: ConflictNote[];
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'server' | 'protocol' | 'confirm',
    readonly guard?: DeleteGuard,
  ) {
    super(message);
  }
}

/** One line for the UI: what a paused sync would delete. */
export function describeGuard(g: DeleteGuard): string {
  const names = g.workspaces.map((w) => `${w.kind === 'plan' ? '计划' : '目标'}「${w.title || '未命名'}」`);
  const shown = names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 个` : '');
  return `这次同步会删除服务器上的 ${g.deletes} 条记录${shown ? `（含${shown}）` : ''}，已暂停，等你确认`;
}

const normUrl = (u: string) => u.replace(/\/+$/, '');

const FIELD_LABEL: Record<string, string> = {
  title: '标题', note: '备注', status: '状态', phaseId: '所属阶段', parent: '所属计划', objective: '目标', goal: '阶段目标', due: '目标日期',
  nextAction: '下一步', why: '为什么', doneWhen: '完成标准', cadenceDays: 'Checkpoint 周期', dailyBudget: '每日预算', tier: '模型档位', effort: '推理强度', activeBy: '进行中的设备',
};
export const fieldLabel = (name: string) => FIELD_LABEL[name] ?? name;
const short = (v: unknown) => {
  const s = v === undefined || v === null || v === '' ? '（空）' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
};

/** One line for the UI about a merged concurrent edit. */
export function describeConflict(n: ConflictNote): string {
  switch (n.what) {
    case 'fields':
      return (n.fields ?? [])
        .map((f) => `「${n.title}」的${fieldLabel(f.name)}两边同时改了：保留了${f.kept === 'mine' ? '这台设备' : '另一台设备'}的「${short(f.kept === 'mine' ? f.mine : f.theirs)}」，另一个是「${short(f.kept === 'mine' ? f.theirs : f.mine)}」`)
        .join('；');
    case 'kept-edited':
      return `「${n.title}」在另一台设备上被删除了，但这台设备改过它，已保留`;
    case 'kept-deleted':
      return `你删除的「${n.title}」在另一台设备上被修改了，已保留`;
    case 'kept-workspace':
      return `「${n.title}」在一台设备上被删除，但另一台设备往里加了新内容，已保留`;
  }
}

/** Request timeouts (ms): a request that hangs must not block syncing forever. */
export const TIMEOUTS = { check: 10_000, sync: 30_000 };

/**
 * fetch with a deadline. The deadline holds even if the transport ignores the abort
 * signal: the late answer is simply dropped (the server side is idempotent).
 */
async function timedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new SyncError(`服务器 ${Math.round(ms / 1000)} 秒没有响应`, 'network'));
    }, ms);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: ctl.signal }), deadline]);
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new SyncError(`连不上服务器：${(e as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Authenticated no-op request: proves the URL and token without changing anything. */
export async function checkServer(cfg: SyncConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await timedFetch(fetchImpl, `${normUrl(cfg.url)}/v1/stats`, { headers: { authorization: `Bearer ${cfg.token}` } }, TIMEOUTS.check);
  if (res.status === 401) throw new SyncError('访问令牌不正确', 'auth');
  if (!res.ok) throw new SyncError(`服务器错误 ${res.status}`, 'server');
}

export async function callSync(cfg: SyncConfig, body: SyncRequest, fetchImpl: typeof fetch = fetch): Promise<SyncResponse> {
  const res = await timedFetch(
    fetchImpl,
    `${normUrl(cfg.url)}/v1/sync`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(body) },
    TIMEOUTS.sync,
  );
  if (res.status === 401) throw new SyncError('访问令牌不正确', 'auth');
  if (res.status === 409) {
    const g = (await res.json().catch(() => null)) as DeleteGuard | null;
    if (g?.error === 'confirm-delete') throw new SyncError(describeGuard(g), 'confirm', g);
  }
  if (!res.ok) throw new SyncError(`服务器错误 ${res.status}：${(await res.text()).slice(0, 200)}`, 'server');
  const json = (await res.json()) as SyncResponse;
  if (typeof json?.cursor !== 'number' || !Array.isArray(json.records)) throw new SyncError('服务器返回的数据格式不对', 'protocol');
  return json;
}

export interface SyncClientOptions {
  /** Debounce after a local change before pushing. */
  debounceMs?: number;
  /** Background pull interval. */
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Install merged state (no undo entry, not a local edit). */
  applyState?: (store: Store, next: AppState) => void;
}

const outboxSize = (m: SyncMeta | null) => (m ? Object.keys(m.outbox).length : 0);

export class SyncClient {
  private status: SyncStatus = { phase: 'off', lastSyncAt: null, error: null, pending: 0, confirm: null, conflicts: [] };
  /** Consecutive failed rounds, for retry backoff. */
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while running a round the user confirmed: exactly the deletions they were shown. */
  private allowDeleteIds: string[] | undefined;
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;

  constructor(private store: Store, private storage: SyncStorage, private opts: SyncClientOptions = {}) {
    this.status.pending = outboxSize(storage.loadMeta());
    this.status.conflicts = storage.loadMeta()?.conflicts ?? [];
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  config(): SyncConfig | null {
    return this.storage.loadConfig();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(p: Partial<SyncStatus>) {
    this.status = { ...this.status, ...p };
    this.listeners.forEach((l) => l());
  }

  /** Start background syncing if configured. */
  start() {
    this.stop();
    if (!this.storage.loadConfig()) return this.set({ phase: 'off' });
    this.set({ phase: 'idle' });
    // Only real local edits trigger a push; merged remote data does not.
    this.unsub = this.store.onLocalChange(() => {
      this.set({ pending: outboxSize(this.storage.loadMeta()) });
      this.schedule();
    });
    this.interval = setInterval(() => void this.syncNow(), this.opts.intervalMs ?? 30_000);
    void this.syncNow();
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.interval = this.timer = this.retryTimer = null;
  }

  /**
   * Connect (or switch) to a server. Nothing local changes unless it succeeds: the
   * server's data is reconciled on the side and merged into the current state (edits
   * made meanwhile included) only once the whole exchange went through.
   */
  async connect(cfg: SyncConfig): Promise<void> {
    // Nothing of the old setup may run while we switch: stop timers, wait for an in-flight round.
    this.stop();
    await this.running?.catch(() => {});
    const hadConfig = !!this.storage.loadConfig();
    const fail = (e: unknown) => {
      this.set({ error: (e as Error).message, confirm: (e as SyncError).guard ?? null });
      if (hadConfig) this.start();
      else this.set({ phase: 'off' });
      throw e;
    };
    try {
      await checkServer(cfg, this.opts.fetchImpl); // prove URL + token before anything else
      const first = this.fullSync(cfg);
      this.running = first.catch(() => {}); // concurrent syncNow calls wait for it
      await first;
    } catch (e) {
      this.running = null;
      return fail(e);
    }
    this.running = null;
    this.storage.saveConfig(cfg);
    this.start();
  }

  disconnect() {
    this.stop();
    this.storage.saveConfig(null);
    this.set({ phase: 'off', error: null, confirm: null });
  }

  schedule() {
    if (!this.storage.loadConfig()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), this.opts.debounceMs ?? 1500);
  }

  /**
   * Run one sync round. Background calls coalesce with a running round; a caller that
   * wants the error (throwOnError) waits for it and runs its own, so it sees its own result.
   */
  async syncNow(throwOnError = false): Promise<void> {
    if (this.running && !throwOnError) {
      this.again = true;
      return this.running;
    }
    while (this.running) await this.running.catch(() => {});
    this.running = this.round(throwOnError).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  /**
   * The user agrees to the deletions the server paused on: send them through, but only
   * those exact records. Resolves false if the pending deletions are no longer the ones
   * shown (the server asks again, and `confirm` shows the new set).
   */
  async confirmDeletes(): Promise<boolean> {
    const g = this.status.confirm;
    if (!g) return true;
    await this.running?.catch(() => {});
    this.allowDeleteIds = g.ids;
    try {
      await this.syncNow(true);
      return true;
    } catch (e) {
      if ((e as SyncError).kind === 'confirm') return false;
      throw e;
    } finally {
      this.allowDeleteIds = undefined;
    }
  }

  /**
   * The user does NOT want those deletions: drop them from the outbox, forget this
   * device's deletion of them and reconcile with the server, which brings them back.
   * Other pending edits are kept and still sent.
   */
  async restoreFromServer(): Promise<void> {
    await this.running?.catch(() => {});
    const ids = this.status.confirm?.ids ?? [];
    this.storage.updateMeta((m) => {
      const outbox = { ...m.outbox };
      const revs = { ...m.revs };
      for (const id of ids) {
        delete outbox[id];
        delete revs[id];
      }
      return { ...m, outbox, revs, synced: false };
    });
    this.set({ confirm: null });
    await this.syncNow(true);
  }

  /** The user has seen these conflict notes (all, if none given). */
  dismissConflicts(notes?: ConflictNote[]) {
    const drop = notes ? new Set(notes.map((n) => `${n.at}:${n.id}`)) : null;
    this.storage.updateMeta((m) => ({ ...m, conflicts: drop ? (m.conflicts ?? []).filter((n) => !drop.has(`${n.at}:${n.id}`)) : [] }));
    this.set({ conflicts: this.storage.loadMeta()?.conflicts ?? [] });
  }

  /**
   * Act on a conflict note: put this device's value of a field back ("use mine"), or
   * delete what was kept. A normal, undoable local edit that syncs like any other.
   */
  resolveConflict(note: ConflictNote, action: { field: string } | 'delete'): string {
    const label = action === 'delete' ? `删除「${note.title}」` : `采用这台设备的「${action.field}」`;
    this.store.mutate(label, (d) => {
      if (action === 'delete' && (note.kind === 'plan' || note.kind === 'goal')) {
        ops.deleteWs(d, note.id.slice(note.id.indexOf(':') + 1));
        return;
      }
      const next = withRecord(d, note.id, (r) => {
        if (action === 'delete' || !r) return action === 'delete' ? undefined : r;
        const f = note.fields?.find((x) => x.name === action.field);
        if (!f) return r;
        if (f.name === 'parent') return { ...r, parent: f.mine as string | undefined };
        const data = { ...(r.data as Record<string, unknown>) };
        if (f.mine === undefined) delete data[f.name];
        else data[f.name] = f.mine;
        return { ...r, data };
      });
      Object.assign(d, next);
    });
    if (action === 'delete' || (note.fields ?? []).length <= 1) this.dismissConflicts([note]);
    return label;
  }

  private applyRemote(next: AppState) {
    (this.opts.applyState ?? ((st, n) => st.applyExternal(n)))(this.store, next);
  }

  private metaFor(cfg: SyncConfig): SyncMeta {
    const m = this.storage.loadMeta() ?? newSyncMeta();
    // Meta belongs to one server: for another one, start that server's history afresh
    // (revisions and pending edits are this device's own and stay).
    return m.url === normUrl(cfg.url) ? m : { ...m, url: normUrl(cfg.url), cursor: 0, cursorTag: undefined, synced: false };
  }

  private request(base: SyncRequest): SyncRequest {
    return this.allowDeleteIds ? { ...base, confirmDeleteIds: this.allowDeleteIds } : base;
  }

  /** Commit a merged result: install the state first, then write meta + state together. */
  private commit(out: { state: AppState; meta: SyncMeta; changed: boolean }) {
    if (out.changed) this.applyRemote(out.state);
    this.storage.updateMeta(() => out.meta);
    const pending = outboxSize(out.meta);
    this.failures = 0;
    this.set({ phase: 'idle', lastSyncAt: Date.now(), error: null, pending, confirm: null, conflicts: out.meta.conflicts ?? [] });
    if (pending) this.schedule(); // edits made meanwhile, or merges to send back
  }

  /** Reconcile everything with the server (first contact, another server, history reset). */
  private async fullSync(cfg: SyncConfig): Promise<void> {
    this.set({ phase: 'syncing' });
    const meta0 = this.metaFor(cfg);
    const res0 = await callSync(cfg, { clientId: meta0.clientId, cursor: 0, changes: [] }, this.opts.fetchImpl);
    // Work on a snapshot: the store is not touched until the whole exchange succeeded.
    const plan = reconcile(this.store.get(), meta0, res0);
    const prepared = prepareSync(plan.state, { ...plan.meta, synced: true });
    const view = new Map<string, SyncRecord>(res0.records.map((r) => [r.id, r]));
    let res = res0;
    if (prepared.request.changes.length) {
      this.set({ pending: prepared.request.changes.length });
      res = await callSync(cfg, this.request(prepared.request), this.opts.fetchImpl);
      if (res.reset) throw new SyncError('服务器数据在同步过程中发生了变化，请重试', 'server');
      const refused = new Set((res.rejected ?? []).map((r) => r.id));
      // What the server applied is now its version; a refused change is NOT (it stays
      // pending here, and whatever the server sent back about it is merged below).
      for (const c of prepared.request.changes) if (!refused.has(c.id)) view.set(c.id, c);
      for (const r of res.records) view.set(r.id, r);
    }
    // Merge into the CURRENT state: edits made meanwhile are newer than what the server
    // has and simply stay pending.
    const out = reconcile(this.store.get(), this.metaFor(cfg), { cursor: res.cursor, cursorTag: res.cursorTag, records: [...view.values()], rejected: res === res0 ? undefined : res.rejected });
    // Conflicts already settled while planning the upload (on the snapshot) must still be
    // reported: the final merge then sees the already-merged result and finds nothing.
    const planned = (plan.meta.conflicts ?? []).slice((meta0.conflicts ?? []).length);
    const known = new Set((out.meta.conflicts ?? []).map((n) => `${n.at}:${n.id}`));
    const conflicts = [...(out.meta.conflicts ?? []), ...planned.filter((n) => !known.has(`${n.at}:${n.id}`))].slice(-50);
    this.commit({ ...out, meta: { ...out.meta, synced: true, conflicts } });
    // Refused changes were merged here: send the merge right away, like a normal round does,
    // so one sync settles it. The reconciliation itself is already committed, so a failure
    // now is not a failed connect: what is left stays pending and is retried as usual.
    if (res.rejected?.length && outboxSize(this.storage.loadMeta())) {
      try {
        await this.normalRound(cfg);
      } catch (e) {
        const err = e as SyncError;
        this.set({ phase: err.kind === 'network' ? 'offline' : 'error', error: err.message, confirm: err.guard ?? null, pending: outboxSize(this.storage.loadMeta()) });
        this.schedule();
      }
    }
  }

  private async normalRound(cfg: SyncConfig): Promise<void> {
    // Changes the server refused (edited elsewhere meanwhile) are merged here and sent
    // again right away, so one sync settles a conflict. Bounded, in case of a race.
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = this.metaFor(cfg);
      const prepared = prepareSync(this.store.get(), meta);
      this.set({ phase: 'syncing', pending: prepared.request.changes.length });
      const res = await callSync(cfg, this.request(prepared.request), this.opts.fetchImpl);
      // The server no longer knows our position (e.g. its database was restored).
      if (res.reset) return this.fullSync(cfg);
      const out = applyResponse(this.store.get(), this.metaFor(cfg), prepared.request.changes, res);
      this.commit(out);
      if (!res.rejected?.length || !Object.keys(out.meta.outbox).length) return;
    }
  }

  private async round(throwOnError: boolean) {
    const cfg = this.storage.loadConfig();
    if (!cfg) return;
    try {
      const meta = this.metaFor(cfg);
      await (meta.synced ? this.normalRound(cfg) : this.fullSync(cfg));
    } catch (e) {
      const err = e as SyncError;
      this.set({ phase: err.kind === 'network' ? 'offline' : 'error', error: err.message, confirm: err.guard ?? null, pending: outboxSize(this.storage.loadMeta()) });
      // Transient failures retry with backoff (2 s … 5 min); a wrong token or a paused
      // deletion waits for the user instead.
      if ((err.kind === 'network' || err.kind === 'server') && this.unsub) {
        this.failures += 1;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.syncNow(), Math.min(300_000, 2000 * 2 ** (this.failures - 1)));
      }
      if (throwOnError) throw e;
    }
  }
}
