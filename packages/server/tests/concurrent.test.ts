// Two devices editing the same things at the same time, over real HTTP + SQLite:
// nothing may be lost silently.
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDocPersistence, createStore, ops, SyncClient, TIMEOUTS, type AppState, type SyncConfig } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const TOKEN = 'concurrent-token-0123456789';
const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

async function server(): Promise<SyncConfig> {
  const s = createApp({ db: openDb(':memory:'), token: TOKEN });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: TOKEN };
}

function device(cfg: SyncConfig, fetchImpl?: typeof fetch) {
  let doc: string | null = null;
  let c: SyncConfig | null = cfg;
  const p = createDocPersistence({ read: () => doc, write: (t) => void (doc = t) });
  const store = createStore(p.load().state, p.persist, 0);
  p.attach(store);
  const client = new SyncClient(store, { loadConfig: () => c, saveConfig: (x) => void (c = x), loadMeta: p.loadMeta, updateMeta: p.updateMeta }, { fetchImpl });
  return { store, client, sync: () => client.syncNow(true), state: () => store.get() };
}
const later = () => new Promise((r) => setTimeout(r, 5));
const task = (s: AppState, title: string) => s.plans.flatMap((p) => p.tasks).find((t) => t.title === title)!;
const titles = (s: AppState) => s.plans.flatMap((p) => p.tasks.map((t) => t.title)).sort();

/** A and B both have plan P with task "original", in sync. */
async function pair() {
  const cfg = await server();
  const a = device(cfg);
  const b = device(cfg);
  a.store.mutate('x', (d) => {
    ops.createPlan(d, 'P');
    ops.addTask(d, 'original');
  });
  await a.sync();
  await b.sync();
  b.store.mutate(null, (d) => void (d.ui.activePlanId = d.plans[0].id));
  return { a, b, tid: task(a.state(), 'original').id };
}

describe('concurrent edits of the same record', () => {
  it('different fields: both edits survive on both devices, no notice needed', async () => {
    const { a, b, tid } = await pair();
    a.store.mutate('a', (d) => void ops.updateTask(d, tid, { title: 'renamed on A' }));
    b.store.mutate('b', (d) => void ops.updateTask(d, tid, { note: 'note from B' }));
    await a.sync();
    await b.sync();
    await a.sync();
    for (const dev of [a, b]) {
      const t = dev.state().plans[0].tasks[0];
      expect([t.title, t.note]).toEqual(['renamed on A', 'note from B']);
    }
    expect(b.client.getStatus().conflicts).toEqual([]);
  });

  it('the same field: the later edit wins everywhere and the other value is reported', async () => {
    const { a, b, tid } = await pair();
    a.store.mutate('a', (d) => void ops.updateTask(d, tid, { title: 'A (earlier)' }));
    await later();
    b.store.mutate('b', (d) => void ops.updateTask(d, tid, { title: 'B (later)' }));
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.state().plans[0].tasks[0].title).toBe('B (later)');
    expect(b.state().plans[0].tasks[0].title).toBe('B (later)');
    const note = b.client.getStatus().conflicts[0];
    expect(note).toMatchObject({ what: 'fields', fields: [{ name: 'title', mine: 'B (later)', theirs: 'A (earlier)', kept: 'mine' }] });
    // "Use the other value": an ordinary edit that syncs.
    b.client.resolveConflict({ ...note, fields: [{ ...note.fields![0], mine: 'A (earlier)' }] }, { field: 'title' });
    await b.sync();
    await a.sync();
    expect(a.state().plans[0].tasks[0].title).toBe('A (earlier)');
  });

  it('deleted on one device, edited on the other: the edit survives (either order)', async () => {
    for (const deleterFirst of [true, false]) {
      const { a, b, tid } = await pair();
      a.store.mutate('del', (d) => void ops.deleteTask(d, tid));
      b.store.mutate('edit', (d) => void ops.updateTask(d, tid, { title: 'edited on B' }));
      if (deleterFirst) {
        await a.sync();
        await b.sync();
      } else {
        await b.sync();
        await a.sync();
      }
      await a.sync();
      await b.sync();
      expect(titles(a.state())).toEqual(['edited on B']);
      expect(titles(b.state())).toEqual(['edited on B']);
      const noted = [...a.client.getStatus().conflicts, ...b.client.getStatus().conflicts];
      expect(noted.some((n) => n.what === 'kept-edited' || n.what === 'kept-deleted')).toBe(true);
    }
  });
});

describe('a plan deleted while another device adds to it', () => {
  it('delete synced first: the adding device keeps the plan with its new task', async () => {
    const { a, b } = await pair();
    a.store.mutate('del', (d) => void ops.deleteWs(d, d.plans[0].id));
    b.store.mutate('add', (d) => void ops.addTask(d, 'added on B'));
    await a.sync().catch(() => a.client.confirmDeletes()); // the only plan: the guard asks first
    await b.sync();
    await a.sync();
    expect(titles(b.state())).toContain('added on B');
    expect(titles(a.state())).toContain('added on B'); // visible everywhere, not an orphan
    expect(b.client.getStatus().conflicts.some((n) => n.what === 'kept-workspace')).toBe(true);
  });

  it('addition synced first: the deleting device keeps the plan (it had content it never saw)', async () => {
    const { a, b } = await pair();
    b.store.mutate('add', (d) => void ops.addTask(d, 'added on B'));
    await b.sync();
    a.store.mutate('del', (d) => void ops.deleteWs(d, d.plans[0].id));
    await a.sync().catch(() => a.client.confirmDeletes());
    await b.sync();
    expect(titles(a.state())).toEqual(['added on B']); // what A knew is deleted, the new task kept
    expect(titles(b.state())).toEqual(['added on B']);
    expect(a.client.getStatus().conflicts.some((n) => n.what === 'kept-workspace')).toBe(true);
  });
});

describe('a server that does not answer', () => {
  it('a hung request fails after the timeout, and the next sync goes through', async () => {
    const cfg = await server();
    let hang = true;
    const a = device(cfg, async (input, init) => (hang ? new Promise<Response>(() => {}) : fetch(input, init)));
    a.store.mutate('x', (d) => void ops.createPlan(d, 'P'));
    const saved = TIMEOUTS.sync;
    TIMEOUTS.sync = 200;
    try {
      const t0 = Date.now();
      await expect(a.sync()).rejects.toThrow(/没有响应/);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(a.client.getStatus().phase).toBe('offline');
      hang = false;
      await a.sync();
      expect(a.client.getStatus()).toMatchObject({ phase: 'idle', pending: 0 });
    } finally {
      TIMEOUTS.sync = saved;
    }
  });
});
