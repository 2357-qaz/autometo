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

    // Deleting a whole plan propagates and does not come back. (It is the server's last
    // plan, so the mass-delete guard pauses it until confirmed — see guard.test.ts.)
    b.store.mutate('x', (d) => ops.deleteWs(d, d.plans[0].id));
    await expect(b.sync()).rejects.toThrow(/已暂停/);
    await b.client.confirmDeletes();
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
    let injected = false;
    const client = new SyncClient(a.store, (a.client as unknown as { storage: SyncStorage }).storage, {
      fetchImpl: async (input, init) => {
        // Edit once, while the first request that actually pushes changes is in flight.
        if (!injected && JSON.parse(String(init?.body)).changes.length) {
          injected = true;
          a.store.mutate('x', (d) => void ops.addTask(d, '飞行中添加'));
        }
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

  it('survives malformed request paths', async () => {
    const { request } = await import('node:http');
    const port = (server.address() as AddressInfo).port;
    for (const path of ['//', '//evil.com/x', '/%E0%A4%A', '/v1/%ZZ', '/..%2f..%2fetc/passwd', '/v1/sync?x=%']) {
      const status = await new Promise<number>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end();
      });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
    // Still alive afterwards.
    expect(((await (await fetch(`${url}/v1/health`)).json()) as { ok: boolean }).ok).toBe(true);
  });

  it('a deletion made while a sync is in flight still reaches the server', async () => {
    const a = device('E');
    const b = device('F');
    a.store.mutate('x', (d) => {
      ops.createPlan(d, '飞行删除');
      ops.addTask(d, '会被删掉的任务');
    });
    await a.sync();
    await b.sync();
    const has = (dev: ReturnType<typeof device>) => dev.state().plans.find((p) => p.title === '飞行删除')!.tasks.some((t) => t.title === '会被删掉的任务');
    expect(has(b)).toBe(true);
    // A edits something (so the request carries changes) and, while that request is
    // in flight, deletes the task.
    a.store.mutate('x', (d) => {
      d.ui.activePlanId = d.plans.find((p) => p.title === '飞行删除')!.id;
      ops.addNote(d, '先改点别的');
    });
    const realFetch = globalThis.fetch;
    let done = false;
    const client = new SyncClient(a.store, (a.client as unknown as { storage: SyncStorage }).storage, {
      fetchImpl: async (input, init) => {
        if (!done) {
          done = true;
          a.store.mutate('x', (d) => {
            const p = d.plans.find((x) => x.title === '飞行删除')!;
            ops.deleteTask(d, p.tasks.find((t) => t.title === '会被删掉的任务')!.id);
          });
        }
        return realFetch(input, init);
      },
    });
    await client.syncNow(true); // the delete happened mid-flight
    await client.syncNow(true); // next round must send the tombstone
    await b.sync();
    expect(has(a)).toBe(false);
    expect(has(b)).toBe(false);
  });

  it("a new device's defaults don't overwrite settings already on the server", async () => {
    const a = device('G');
    a.store.mutate('x', (d) => {
      d.settings.dailyBudget = 150_000;
      d.hie.tier = 'opus';
      d.hie.effort = 'high';
    });
    await a.sync();
    // Brand-new device: default budget 200k / sonnet / medium, plus one local-only plan.
    const b = device('H');
    b.store.mutate('x', (d) => void ops.createPlan(d, '新设备上离线建的计划'));
    expect(b.state().settings.dailyBudget).toBe(200_000);
    await b.sync();
    expect(b.state().settings.dailyBudget).toBe(150_000);
    expect(b.state().hie).toEqual({ tier: 'opus', effort: 'high' });
    await a.sync();
    expect(a.state().settings.dailyBudget).toBe(150_000);
    expect(a.state().hie.tier).toBe('opus');
    // The new device's own data was still uploaded.
    expect(a.state().plans.some((p) => p.title === '新设备上离线建的计划')).toBe(true);
    // And a later, real change on the new device does win.
    b.store.mutate('x', (d) => void (d.settings.dailyBudget = 120_000));
    await b.sync();
    await a.sync();
    expect(a.state().settings.dailyBudget).toBe(120_000);
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
