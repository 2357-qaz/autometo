// Sync client shared by web and TUI: talks to the AuTomeDo server over HTTP.
import type { Store } from './store';
import type { AppState } from './types';
import { applySync, newSyncMeta, prepareSync, type SyncMeta, type SyncResponse } from './sync';

export interface SyncConfig {
  url: string; // e.g. https://automedo.example.com
  token: string;
}

/** Where a client keeps its sync config + bookkeeping (localStorage, a file, …). */
export interface SyncStorage {
  loadConfig(): SyncConfig | null;
  saveConfig(c: SyncConfig | null): void;
  loadMeta(): SyncMeta | null;
  saveMeta(m: SyncMeta): void;
}

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt: number | null;
  error: string | null;
  /** Local changes not yet acknowledged by the server (as of the last attempt). */
  pending: number;
}

export class SyncError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'server' | 'protocol') {
    super(message);
  }
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
  private status: SyncStatus = { phase: 'off', lastSyncAt: null, error: null, pending: 0 };
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

  /** Connect to a server: verifies the token with a first sync before saving. */
  async connect(cfg: SyncConfig): Promise<void> {
    const prev = this.storage.loadConfig();
    this.storage.saveConfig(cfg);
    // A different server means a fresh history.
    if (!prev || prev.url !== cfg.url) this.storage.saveMeta(newSyncMeta(this.storage.loadMeta()?.clientId));
    try {
      await this.syncNow(true);
      if (this.status.phase === 'error') throw new Error(this.status.error ?? '同步失败');
    } catch (e) {
      this.storage.saveConfig(prev);
      this.set({ phase: prev ? 'idle' : 'off' });
      throw e;
    }
    this.start();
  }

  disconnect() {
    this.stop();
    this.storage.saveConfig(null);
    this.set({ phase: 'off', error: null, pending: 0 });
  }

  schedule() {
    if (!this.storage.loadConfig()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), this.opts.debounceMs ?? 1500);
  }

  /** Run one sync round (coalescing concurrent calls). */
  async syncNow(throwOnError = false): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
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
        this.storage.saveMeta(meta);
        if (out0.changed) this.applyRemote(out0.state);
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
      const res = await callSync(cfg, prepared.request, this.opts.fetchImpl);
      const out = applySync(this.store.get(), prepared, res, meta);
      this.storage.saveMeta(out.meta);
      if (out.changed) this.applyRemote(out.state);
      this.set({ phase: 'idle', lastSyncAt: Date.now(), error: null, pending: 0 });
    } catch (e) {
      const err = e as SyncError;
      this.set({ phase: err.kind === 'network' ? 'offline' : 'error', error: err.message });
      if (throwOnError) throw e;
    }
  }
}

function defaultApply(store: Store, next: AppState) {
  store.mutate(null, (d) => {
    Object.assign(d, next);
  });
}
