import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStore, emptyState, newSyncMeta, ops, SyncClient, type Store, type SyncConfig, type SyncMeta, type SyncStorage } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const TOKEN = 'test-token-0123456789';
let server: Server;
let url = '';

beforeAll(async () => {
  server = createApp({ db: openDb(':memory:'), token: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function memStorage(cfg: SyncConfig | null): SyncStorage & { meta: SyncMeta | null } {
  let c = cfg;
  const s = {
    meta: null as SyncMeta | null,
    loadConfig: () => c,
    saveConfig: (x: SyncConfig | null) => void (c = x),
    loadMeta: () => s.meta,
    saveMeta: (m: SyncMeta) => void (s.meta = m),
  };
  return s;
}

function device(name: string) {
  const store: Store = createStore(emptyState());
  const storage = memStorage({ url, token: TOKEN });
  storage.meta = newSyncMeta(name);
  const client = new SyncClient(store, storage);
  return { store, client, sync: () => client.syncNow(true), state: () => store.get() };
}

describe('sync over HTTP', () => {
  it('propagates creates, concurrent edits, conflicts and deletes between two devices', async () => {
    const a = device('A');
    const b = device('B');

    a.store.mutate('x', (d) => {
      ops.createPlan(d, '网站改版');
      ops.addTask(d, '线框图');
    });
    await a.sync();
    await b.sync();
    expect(b.state().plans.map((p) => p.title)).toEqual(['网站改版']);
    expect(b.state().plans[0].tasks.map((t) => t.title)).toEqual(['线框图']);

    // Concurrent edits on different records both survive.
    b.store.mutate('x', (d) => {
      d.ui.activePlanId = d.plans[0].id;
      ops.addTask(d, '配色');
    });
    a.store.mutate('x', (d) => ops.renameWs(d, d.plans[0].id, '个人网站改版'));
    await b.sync();
    await a.sync();
    await b.sync();
    for (const dev of [a, b]) {
      expect(dev.state().plans[0].title).toBe('个人网站改版');
      expect(dev.state().plans[0].tasks.map((t) => t.title)).toEqual(['线框图', '配色']);
    }
    // The execution log is the union of both devices' events.
    expect(a.state().plans[0].log.length).toBe(b.state().plans[0].log.length);

    // Same record edited on both: the later edit wins everywhere.
    const tid = a.state().plans[0].tasks[0].id;
    a.store.mutate('x', (d) => ops.updateTask(d, tid, { title: 'A 改的' }));
    await new Promise((r) => setTimeout(r, 5));
    b.store.mutate('x', (d) => ops.updateTask(d, tid, { title: 'B 改的' }));
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.state().plans[0].tasks[0].title).toBe('B 改的');
    expect(b.state().plans[0].tasks[0].title).toBe('B 改的');

    // Deleting a whole plan propagates and does not come back.
    b.store.mutate('x', (d) => ops.deleteWs(d, d.plans[0].id));
    await b.sync();
    await a.sync();
    await b.sync();
    expect(a.state().plans).toHaveLength(0);
    expect(b.state().plans).toHaveLength(0);
  });

  it('keeps edits made while a sync is in flight', async () => {
    const a = device('C');
    a.store.mutate('x', (d) => void ops.createPlan(d, 'P'));
    // Edit after the request was prepared but before the response is applied.
    const realFetch = globalThis.fetch;
    const client = new SyncClient(a.store, (a.client as unknown as { storage: SyncStorage }).storage, {
      fetchImpl: async (input, init) => {
        a.store.mutate('x', (d) => void ops.addTask(d, '飞行中添加'));
        return realFetch(input, init);
      },
    });
    await client.syncNow(true);
    expect(a.state().plans[0].tasks.map((t) => t.title)).toEqual(['飞行中添加']);
    await client.syncNow(true);
    const b = device('D');
    await b.sync();
    expect(b.state().plans.find((p) => p.title === 'P')?.tasks.map((t) => t.title)).toEqual(['飞行中添加']);
  });

  it('rejects bad tokens and malformed requests', async () => {
    const bad = await fetch(`${url}/v1/sync`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    expect(bad.status).toBe(401);
    const malformed = await fetch(`${url}/v1/sync`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ clientId: 'x', cursor: 0, changes: [{ id: 'a', kind: 'evil', rev: 'zz' }] }) });
    expect(malformed.status).toBe(400);
    const health = (await (await fetch(`${url}/v1/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    const exp = (await (await fetch(`${url}/v1/export`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { version: number };
    expect(exp.version).toBe(1);
  });
});
