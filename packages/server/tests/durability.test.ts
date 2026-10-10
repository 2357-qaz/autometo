import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDocPersistence, createStore, newSyncMeta, ops, SyncClient, type AppState } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const TOKEN = 'durability-token-0123456789';
let server: Server;
let url = '';
beforeAll(async () => {
  server = createApp({ db: openDb(':memory:'), token: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/**
 * A device whose "disk" is a single string written through the real
 * createDocPersistence (same as web/TUI). A crash is simulated by rebuilding a
 * device from whatever had reached the disk at that moment.
 */
function device(id: string, disk?: { doc: string | null }) {
  const d = disk ?? { doc: null as string | null };
  const p = createDocPersistence({ read: () => d.doc, write: (t) => void (d.doc = t) }, () => newSyncMeta(id));
  const { state } = p.load();
  const store = createStore(state, p.persist, 150);
  p.attach(store);
  const client = new SyncClient(store, { loadConfig: () => ({ url, token: TOKEN }), saveConfig() {}, loadMeta: p.loadMeta, saveMeta: p.saveMeta });
  return { store, client, disk: d, state: () => store.get() };
}
const snapshotDisk = (dev: ReturnType<typeof device>) => ({ doc: dev.disk.doc });

describe('crash right after a sync', () => {
  it('does not push stale data over a newer synced version on restart', async () => {
    const a = device('A');
    a.store.mutate('x', (d) => {
      ops.createPlan(d, '崩溃测试');
      ops.addTask(d, '旧标题');
    });
    a.store.flush();
    await a.client.syncNow(true);
    a.store.flush();
    const b = device('B');
    await b.client.syncNow(true);
    const tid = b.state().plans[0].tasks[0].id;
    b.store.mutate('x', (d) => void ops.updateTask(d, tid, { title: '新标题' }));
    await b.client.syncNow(true);

    // A pulls the new title… and "crashes" before its debounced state write lands.
    await a.client.syncNow(true);
    expect(a.state().plans[0].tasks[0].title).toBe('新标题');
    const onDisk = snapshotDisk(a);

    const a2 = device('A', onDisk); // restart from what was durable
    await a2.client.syncNow(true);
    await b.client.syncNow(true);
    expect(b.state().plans[0].tasks[0].title).toBe('新标题');
    expect(a2.state().plans[0].tasks[0].title).toBe('新标题');
  });

  it('does not resurrect a record deleted elsewhere', async () => {
    const a = device('C');
    a.store.mutate('x', (d) => {
      ops.createPlan(d, '复活测试');
      ops.addTask(d, '会被别处删除');
    });
    a.store.flush();
    await a.client.syncNow(true);
    a.store.flush();
    const b = device('D');
    await b.client.syncNow(true);
    b.store.mutate('x', (d) => {
      const p = d.plans.find((x) => x.title === '复活测试')!;
      d.ui.activePlanId = p.id;
      ops.deleteTask(d, p.tasks[0].id);
    });
    await b.client.syncNow(true);

    await a.client.syncNow(true); // pulls the tombstone, then crashes
    const a2 = device('C', snapshotDisk(a));
    await a2.client.syncNow(true);
    await b.client.syncNow(true);
    const has = (s: AppState) => s.plans.find((p) => p.title === '复活测试')!.tasks.length > 0;
    expect(has(b.state())).toBe(false);
    expect(has(a2.state())).toBe(false);
  });
});

describe('first contact keeps an explicit offline setting', () => {
  it('an offline 180k set on a new device survives first sync against a server at 150k', async () => {
    const a = device('E');
    a.store.mutate('x', (d) => void ops.setBudget(d, 150_000));
    await a.client.syncNow(true);
    await new Promise((r) => setTimeout(r, 5));
    const b = device('F');
    b.store.mutate('x', (d) => void ops.setBudget(d, 180_000)); // set offline, later than A's change
    await b.client.syncNow(true);
    expect(b.state().settings.dailyBudget).toBe(180_000);
    await a.client.syncNow(true);
    expect(a.state().settings.dailyBudget).toBe(180_000);
  });

  it('…but an older offline setting does not beat a newer one from another device', async () => {
    const b = device('G');
    b.store.mutate('x', (d) => void ops.setBudget(d, 90_000)); // set offline first
    await new Promise((r) => setTimeout(r, 5));
    const a = device('H');
    a.store.mutate('x', (d) => void ops.setBudget(d, 110_000)); // newer, and synced first
    await a.client.syncNow(true);
    await b.client.syncNow(true);
    expect(b.state().settings.dailyBudget).toBe(110_000);
  });
});
