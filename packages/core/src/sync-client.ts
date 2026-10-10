// Sync client shared by web and TUI: talks to the AuTomeDo server over HTTP.
import type { Store } from './store';
import type { AppState } from './types';
import { applySync, newSyncMeta, prepareSync, type DeleteGuard, type SyncMeta, type SyncResponse } from './sync';

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
   * Must durably store `m` TOGETHER with the store's current state in one atomic
   * write (see createDocPersistence) — otherwise a crash can leave a new cursor
   * next to old data, and the stale data would be pushed as if it were new.
   */
  saveMeta(m: SyncMeta): void;
}

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt: number | null;
  error: string | null;
  /** Local changes not yet acknowledged by the server (as of the last attempt). */
  pending: number;
  /** Sync is paused: the server wants confirmation before this mass deletion. */
  confirm: DeleteGuard | null;
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

/** Authenticated no-op request: proves the URL and token without changing anything. */
export async function checkServer(cfg: SyncConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${normUrl(cfg.url)}/v1/stats`, { headers: { authorization: `Bearer ${cfg.token}` } });
  } catch (e) {
    throw new SyncError(`连不上服务器：${(e as Error).message}`, 'network');
  }
  if (res.status === 401) throw new SyncError('访问令牌不正确', 'auth');
  if (!res.ok) throw new SyncError(`服务器错误 ${res.status}`, 'server');
}

export async function callSync(cfg: SyncConfig, body: unknown, fetchImpl: typeof fetch = fetch): Promise<SyncResponse> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url.replace(/\/+$/, '')}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new SyncError(`连不上服务器：${(e as Error).message}`, 'network');
  }
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
  /** Replace store contents with merged state (no undo entry). */
  applyState?: (store: Store, next: AppState) => void;
}

export class SyncClient {
  private status: SyncStatus = { phase: 'off', lastSyncAt: null, error: null, pending: 0, confirm: null };
  /** Set while running a round the user confirmed: deletions the server may accept. */
  private allowDeletes: number | undefined;
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private applying = false;

  constructor(private store: Store, private storage: SyncStorage, private opts: SyncClientOptions = {}) {}

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
    this.unsub = this.store.subscribe(() => {
      if (!this.applying) this.schedule();
    });
    this.interval = setInterval(() => void this.syncNow(), this.opts.intervalMs ?? 30_000);
    void this.syncNow();
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.interval = this.timer = null;
  }

  /**
   * Connect (or switch) to a server as a transaction: verify it first, then run the
   * first sync; if anything fails, config, sync meta and data are all put back.
   */
  async connect(cfg: SyncConfig): Promise<void> {
    // Nothing of the old setup may run while we switch: stop timers, wait for an in-flight round.
    this.stop();
    await this.running?.catch(() => {});
    const prevConfig = this.storage.loadConfig();
    const prevMeta = this.storage.loadMeta();
    const prevState = this.store.get();
    const restoreBackground = () => {
      if (prevConfig) this.start();
      else this.set({ phase: 'off' });
    };
    // 1) Prove URL + token before touching anything.
    try {
      await checkServer(cfg, this.opts.fetchImpl);
    } catch (e) {
      this.set({ error: (e as Error).message });
      restoreBackground();
      throw e;
    }
    // 2) Switch and run the first sync; roll everything back if it fails.
    this.storage.saveConfig(cfg);
    const first = this.round(true);
    this.running = first.catch(() => {}); // concurrent syncNow calls wait for it, never see the rejection
    try {
      await first;
    } catch (e) {
      this.running = null;
      if (this.store.get() !== prevState) this.applyRemote(prevState);
      // Always write the meta back (atomically with the restored state). With no previous meta,
      // a fresh one: keeping the pulled cursor/base next to restored-away data would make the
      // next sync read every pulled record as a local deletion and push tombstones for them.
      const cur = this.storage.loadMeta();
      this.storage.saveMeta(prevMeta ?? { ...newSyncMeta(cur?.clientId), lastT: cur?.lastT ?? 0 });
      this.storage.saveConfig(prevConfig);
      this.set({ phase: prevConfig ? 'idle' : 'off', error: (e as Error).message, confirm: null });
      restoreBackground();
      throw e;
    }
    this.running = null;
    this.start();
  }

  disconnect() {
    this.stop();
    this.storage.saveConfig(null);
    this.set({ phase: 'off', error: null, pending: 0, confirm: null });
  }

  /** The user agrees to the deletions the server paused on: send them through once. */
  async confirmDeletes(): Promise<void> {
    const g = this.status.confirm;
    if (!g) return;
    await this.running?.catch(() => {});
    this.allowDeletes = g.deletes;
    try {
      await this.syncNow(true);
    } finally {
      this.allowDeletes = undefined;
    }
  }

  /**
   * The user does NOT want those deletions: forget what this device thinks it has
   * synced and pull everything again (first contact), so records missing here come
   * back from the server. Server versions win over local edits of the same records.
   */
  async restoreFromServer(): Promise<void> {
    await this.running?.catch(() => {});
    const cur = this.storage.loadMeta();
    this.storage.saveMeta({ ...newSyncMeta(cur?.clientId), lastT: cur?.lastT ?? 0 });
    this.set({ confirm: null });
    await this.syncNow(true);
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

  private applyRemote(next: AppState) {
    this.applying = true;
    try {
      (this.opts.applyState ?? defaultApply)(this.store, next);
    } finally {
      this.applying = false;
    }
  }

  private async round(throwOnError: boolean) {
    const cfg = this.storage.loadConfig();
    if (!cfg) return;
    let meta = this.storage.loadMeta() ?? newSyncMeta();
    // Meta belongs to one server. If config and meta disagree (e.g. a crash in the middle
    // of switching servers), start a fresh history rather than reuse another server's cursor.
    if (meta.url && meta.url !== normUrl(cfg.url)) meta = newSyncMeta(meta.clientId);
    meta = { ...meta, url: normUrl(cfg.url) };
    try {
      // First contact with this server: pull before pushing, so this device's
      // defaults (budget, model tier…) can't overwrite what other devices set.
      if (meta.cursor === 0 && Object.keys(meta.base).length === 0) {
        this.set({ phase: 'syncing' });
        const probe = prepareSync(this.store.get(), meta);
        const pull = { ...probe, request: { ...probe.request, changes: [] } };
        const res0 = await callSync(cfg, pull.request, this.opts.fetchImpl);
        const out0 = applySync(this.store.get(), pull, res0, meta, { pullOnly: true });
        meta = out0.meta;
        // Apply first, then save meta: saveMeta writes meta + current state together.
        if (out0.changed) this.applyRemote(out0.state);
        this.storage.saveMeta(meta);
      }
    } catch (e) {
      const err = e as SyncError;
      this.set({ phase: err.kind === 'network' ? 'offline' : 'error', error: err.message });
      if (throwOnError) throw e;
      return;
    }
    const prepared = prepareSync(this.store.get(), meta);
    this.set({ phase: 'syncing', pending: prepared.request.changes.length });
    try {
      const req = this.allowDeletes ? { ...prepared.request, confirmDeletes: this.allowDeletes } : prepared.request;
      const res = await callSync(cfg, req, this.opts.fetchImpl);
      const out = applySync(this.store.get(), prepared, res, meta);
      // Apply first, then save meta: saveMeta writes meta + current state together.
      if (out.changed) this.applyRemote(out.state);
      this.storage.saveMeta(out.meta);
      this.set({ phase: 'idle', lastSyncAt: Date.now(), error: null, pending: 0, confirm: null });
    } catch (e) {
      const err = e as SyncError;
      this.set({ phase: err.kind === 'network' ? 'offline' : 'error', error: err.message, confirm: err.guard ?? null });
      if (throwOnError) throw e;
    }
  }
}

function defaultApply(store: Store, next: AppState) {
  store.mutate(null, (d) => {
    Object.assign(d, next);
  });
}
