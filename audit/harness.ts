import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../packages/server/src/app';
import { openDb } from '../packages/server/src/db';
import { createDocPersistence, createStore, emptyState, newSyncMeta, type AppState, type SyncConfig, SyncClient } from '../packages/core/src/index';

export const T0 = 1_800_000_000_000;
export function fixture(): AppState {
  const s = emptyState(T0);
  s.plans = [{ id: 'p', kind: 'plan', title: 'P', objective: '', status: 'active', createdAt: T0, updatedAt: T0,
    phases: [{ id: 'ph', title: 'phase', goal: 'original goal', status: 'active' }],
    tasks: [{ id: 't', title: 'original', status: 'pending', phaseId: 'ph', createdAt: T0 }], versions: [], log: [] }];
  s.ui.activePlanId = 'p';
  return s;
}

/** Real HTTP handler and SQLite, bound exclusively to loopback on a free port. */
export async function server() {
  const db = openDb(':memory:');
  const http = createApp({ db, token: 'isolated-audit-token' });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const cfg = { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token: 'isolated-audit-token' };
  return { db, cfg, async close() {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve()));
    db.close();
  } };
}

export function device(id: string, initial = emptyState(T0), cfg: SyncConfig | null = null, fetchImpl?: typeof fetch) {
  const disk = { text: JSON.stringify(initial), fail: false };
  let config = cfg;
  const persistence = createDocPersistence({ read: () => disk.text, write(text) {
    if (disk.fail) throw new Error('injected ENOSPC');
    disk.text = text;
  } }, () => newSyncMeta(id));
  const store = createStore(persistence.load().state, persistence.persist, 60_000);
  persistence.attach(store);
  const storage = { loadConfig: () => config, saveConfig: (c: SyncConfig | null) => { config = c; }, loadMeta: persistence.loadMeta, updateMeta: persistence.updateMeta };
  const client = new SyncClient(store, storage, { fetchImpl, intervalMs: 60_000, debounceMs: 60_000 });
  return { store, disk, persistence, storage, client, sync: () => client.syncNow(true), close() { client.stop(); store.flush(); } };
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}
export function title(d: ReturnType<typeof device>) { return d.store.get().plans[0].tasks[0].title; }
export function titles(d: ReturnType<typeof device>) { return d.store.get().plans[0].tasks.map(t => t.title); }
export { assert };
