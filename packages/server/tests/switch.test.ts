import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDocPersistence, createStore, newSyncMeta, ops, SyncClient, type SyncConfig } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const TOKEN = 'switch-token-0123456789ab';
const servers: Server[] = [];
async function start(): Promise<string> {
  const s = createApp({ db: openDb(':memory:'), token: TOKEN });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
let OLD = '';
let NEW = '';
beforeAll(async () => {
  OLD = await start();
  NEW = await start();
});
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

function device(id: string, fetchImpl?: typeof fetch) {
  const disk = { doc: null as string | null };
  let cfg: SyncConfig | null = null;
  const p = createDocPersistence({ read: () => disk.doc, write: (t) => void (disk.doc = t) }, () => newSyncMeta(id));
  const store = createStore(p.load().state, p.persist, 0);
  p.attach(store);
  const client = new SyncClient(store, { loadConfig: () => cfg, saveConfig: (c) => void (cfg = c), loadMeta: p.loadMeta, saveMeta: p.saveMeta }, { fetchImpl });
  return { store, client, meta: () => structuredClone(p.loadMeta()), config: () => cfg, state: () => store.get() };
}
const titles = (s: ReturnType<ReturnType<typeof device>['state']>, plan: string) => s.plans.find((p) => p.title === plan)?.tasks.map((t) => t.title) ?? [];

describe('switching servers', () => {
  it('a failed switch (bad token) changes nothing: config, meta and state stay; pending work still reaches the old server', async () => {
    const a = device('A');
    a.store.mutate('x', (d) => {
      ops.createPlan(d, '换服务器');
      ops.addTask(d, '保留');
      ops.addTask(d, '待删除');
    });
    await a.client.connect({ url: OLD, token: TOKEN });
    // Unsynced local work: one edit, one deletion.
    a.store.mutate('x', (d) => {
      const p = d.plans[0];
      ops.updateTask(d, p.tasks[0].id, { title: '保留（已改）' });
      ops.deleteTask(d, p.tasks[1].id);
    });
    const before = { meta: a.meta(), state: a.state() };
    await expect(a.client.connect({ url: NEW, token: 'wrong-token-xxxxxxxx' })).rejects.toThrow();
    expect(a.config()?.url).toBe(OLD);
    // Meta still belongs to the old server with the same history (background sync may
    // already have resumed, so only the clock may have moved).
    expect({ ...a.meta(), lastT: 0 }).toMatchObject({ ...before.meta, lastT: 0, cursor: expect.any(Number) });
    expect(a.meta()!.url).toBe(OLD);
    expect(a.state().plans[0].tasks.map((t) => t.title)).toEqual(['保留（已改）']);
    await a.client.syncNow(true);
    const b = device('B');
    await b.client.connect({ url: OLD, token: TOKEN });
    expect(titles(b.state(), '换服务器')).toEqual(['保留（已改）']);
  });

  it('a switch that fails after pulling rolls back the merged data too', async () => {
    // The new server already has someone else's data.
    const other = device('O');
    other.store.mutate('x', (d) => void ops.createPlan(d, '新服务器上的计划'));
    await other.client.connect({ url: NEW, token: TOKEN });

    let failPush = true;
    const flaky: typeof fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (failPush && String(input).startsWith(NEW) && body?.changes?.length) return new Response('boom', { status: 500 });
      return fetch(input, init);
    };
    const a = device('C', flaky);
    a.store.mutate('x', (d) => void ops.createPlan(d, '旧服务器上的计划'));
    await a.client.connect({ url: OLD, token: TOKEN });
    const before = { meta: a.meta(), state: a.state() };
    await expect(a.client.connect({ url: NEW, token: TOKEN })).rejects.toThrow();
    expect(a.config()?.url).toBe(OLD);
    expect(a.meta()!.url).toBe(OLD);
    expect(a.meta()!.cursor).toBe(before.meta!.cursor); // not the new server's cursor
    expect(a.state().plans.map((p) => p.title).sort()).toEqual(before.state.plans.map((p) => p.title).sort());
    expect(a.state().plans.some((p) => p.title === '新服务器上的计划')).toBe(false); // nothing from NEW leaked in
    await a.client.syncNow(true);
    const check = device('D');
    await check.client.connect({ url: OLD, token: TOKEN });
    expect(check.state().plans.some((p) => p.title === '新服务器上的计划')).toBe(false);
    failPush = false;
  });

  it('a successful switch starts a fresh history on the new server and keeps the data', async () => {
    const a = device('E');
    a.store.mutate('x', (d) => void ops.createPlan(d, '搬家'));
    await a.client.connect({ url: OLD, token: TOKEN });
    await a.client.connect({ url: NEW, token: TOKEN });
    expect(a.config()?.url).toBe(NEW);
    const b = device('F');
    await b.client.connect({ url: NEW, token: TOKEN });
    expect(b.state().plans.some((p) => p.title === '搬家')).toBe(true);
  });
});
