// Safety net: the server pauses a sync that would delete a lot at once until the user confirms.
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDocPersistence, createStore, ops, SyncClient, type AppState, type SyncConfig } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb, type RecordDb } from '../src/db';

const TOKEN = 'guard-token-0123456789ab';
const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

/** A fresh server per test, so tests can't see each other's data. */
async function server(): Promise<{ cfg: SyncConfig; db: RecordDb }> {
  const db = openDb(':memory:');
  const s = createApp({ db, token: TOKEN });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { cfg: { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: TOKEN }, db };
}

function device() {
  const disk = { doc: null as string | null };
  let cfg: SyncConfig | null = null;
  const p = createDocPersistence({ read: () => disk.doc, write: (t) => void (disk.doc = t) });
  const store = createStore(p.load().state, p.persist, 0);
  p.attach(store);
  const client = new SyncClient(store, { loadConfig: () => cfg, saveConfig: (c) => void (cfg = c), loadMeta: p.loadMeta, updateMeta: p.updateMeta });
  const titles = () => store.get().plans.map((x) => x.title).sort();
  return { store, client, titles, status: () => client.getStatus() };
}

async function seeded(planTitles: string[], tasksPerPlan = 1) {
  const srv = await server();
  const a = device();
  a.store.mutate('x', (d) => {
    for (const t of planTitles) {
      ops.createPlan(d, t);
      for (let i = 0; i < tasksPerPlan; i++) ops.addTask(d, `${t}-任务${i}`);
    }
  });
  await a.client.connect(srv.cfg);
  return { srv, a };
}

const wsId = (s: AppState, title: string) => s.plans.find((p) => p.title === title)!.id;

async function serverTitles(cfg: SyncConfig) {
  const check = device();
  await check.client.connect(cfg);
  return check.titles();
}

describe('mass-delete guard', () => {
  it('lets an ordinary deletion through: one plan out of several', async () => {
    const { srv, a } = await seeded(['甲', '乙', '丙']);
    a.store.mutate('x', (d) => void ops.deleteWs(d, wsId(d, '甲')));
    await a.client.syncNow(true);
    expect(a.status().confirm).toBeNull();
    expect(await serverTitles(srv.cfg)).toEqual(['丙', '乙']);
  });

  it('pauses on deleting two plans at once: nothing is applied until the user confirms', async () => {
    const { srv, a } = await seeded(['甲', '乙', '丙']);
    const before = srv.db.stats();
    a.store.mutate('x', (d) => {
      ops.deleteWs(d, wsId(d, '甲'));
      ops.deleteWs(d, wsId(d, '乙'));
    });
    await expect(a.client.syncNow(true)).rejects.toThrow(/已暂停/);
    const st = a.status();
    expect(st.phase).toBe('error');
    expect(st.confirm?.workspaces.map((w) => w.title).sort()).toEqual(['乙', '甲']);
    expect(srv.db.stats()).toEqual(before); // the whole request was refused
    expect(await serverTitles(srv.cfg)).toEqual(['丙', '乙', '甲']);

    // Other local edits stay queued (not lost) while paused, and go through with the confirmation.
    a.store.mutate('x', (d) => void ops.addTask(d, '暂停期间加的'));
    await a.client.confirmDeletes();
    expect(a.status().confirm).toBeNull();
    expect(a.status().phase).toBe('idle');
    const b = device();
    await b.client.connect(srv.cfg);
    expect(b.titles()).toEqual(['丙']);
    expect(b.store.get().plans[0].tasks.map((t) => t.title)).toContain('暂停期间加的');
  });

  it('"restore from server" brings the deleted plans back and keeps the server untouched', async () => {
    const { srv, a } = await seeded(['甲', '乙', '丙']);
    a.store.mutate('x', (d) => {
      ops.deleteWs(d, wsId(d, '甲'));
      ops.deleteWs(d, wsId(d, '乙'));
    });
    await a.client.syncNow(true).catch(() => {});
    expect(a.status().confirm).not.toBeNull();
    await a.client.restoreFromServer();
    expect(a.status().confirm).toBeNull();
    expect(a.titles()).toEqual(['丙', '乙', '甲']);
    expect(await serverTitles(srv.cfg)).toEqual(['丙', '乙', '甲']);
    await a.client.syncNow(true); // and it is a normal, quiet sync again
    expect(a.status().phase).toBe('idle');
  });

  it('pauses on deleting the last plan', async () => {
    const { srv, a } = await seeded(['唯一']);
    a.store.mutate('x', (d) => void ops.deleteWs(d, wsId(d, '唯一')));
    await expect(a.client.syncNow(true)).rejects.toThrow();
    expect(a.status().confirm?.workspaces).toEqual([{ kind: 'plan', title: '唯一' }]);
    expect(await serverTitles(srv.cfg)).toEqual(['唯一']);
  });

  it('pauses on deleting most of the records even without deleting a plan', async () => {
    const { srv, a } = await seeded(['大计划'], 30);
    const pid = wsId(a.store.get(), '大计划');
    a.store.mutate('x', (d) => {
      const p = d.plans.find((x) => x.id === pid)!;
      for (const t of p.tasks.slice(0, 28)) ops.deleteTask(d, t.id);
    });
    await expect(a.client.syncNow(true)).rejects.toThrow();
    expect(a.status().confirm?.deletes).toBe(28);
    expect(a.status().confirm?.workspaces).toEqual([]);
    const b = device();
    await b.client.connect(srv.cfg);
    expect(b.store.get().plans[0].tasks).toHaveLength(30);
  });

  it('catches the bug class it exists for: stale sync meta next to emptied data', async () => {
    const { srv, a } = await seeded(['甲', '乙']);
    // Simulate the earlier bugs: data reset to empty while the meta still lists every record.
    a.store.mutate(null, (d) => {
      d.plans = [];
    });
    await expect(a.client.syncNow(true)).rejects.toThrow();
    expect(await serverTitles(srv.cfg)).toEqual(['乙', '甲']);
  });

  it('a confirmation covers exactly the records shown, not "up to N" of any', async () => {
    const { srv } = await seeded(['甲', '乙', '丙']);
    const post = (body: unknown) =>
      fetch(`${srv.cfg.url}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    const all = (await (await post({ clientId: 'zz', cursor: 0, changes: [] })).json()) as { records: { id: string; kind: string }[] };
    const plans = all.records.filter((r) => r.kind === 'plan').map((r) => r.id);
    const del = (confirmDeleteIds?: string[]) => post({ clientId: 'zz', cursor: 0, confirmDeleteIds, changes: plans.map((id) => ({ id, kind: 'plan', rev: 'zzzzzzzzz.zz', deleted: true })) });
    const first = await del();
    expect(first.status).toBe(409);
    expect(((await first.json()) as { ids: string[] }).ids.sort()).toEqual([...plans].sort());
    expect((await del(plans.slice(0, 2))).status).toBe(409); // two of three confirmed: refused
    expect((await del(plans)).status).toBe(200);
  });
});
