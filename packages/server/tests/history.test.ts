// The server's history going back (restored backup) and clients upgrading from the
// older sync bookkeeping: both must end with nobody's acknowledged data lost.
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDocPersistence, createStore, decompose, hashData, ops, SyncClient, type SyncConfig } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb, type RecordDb } from '../src/db';

const TOKEN = 'history-token-0123456789';
const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

async function server(): Promise<{ cfg: SyncConfig; db: RecordDb }> {
  const db = openDb(':memory:');
  const s = createApp({ db, token: TOKEN });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { cfg: { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: TOKEN }, db };
}

function device(cfg: SyncConfig | null, doc: string | null = null) {
  let text = doc;
  let c = cfg;
  const p = createDocPersistence({ read: () => text, write: (t) => void (text = t) });
  const store = createStore(p.load().state, p.persist, 0);
  p.attach(store);
  const client = new SyncClient(store, { loadConfig: () => c, saveConfig: (x) => void (c = x), loadMeta: p.loadMeta, updateMeta: p.updateMeta });
  return { store, client, sync: () => client.syncNow(true), meta: p.loadMeta, title: () => store.get().plans[0]?.tasks[0]?.title };
}

/** Everything in the database, as an administrator's file backup would have it. */
function backup(db: RecordDb) {
  return Object.fromEntries(['records', 'journal', 'meta'].map((t) => [t, db.raw.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]]));
}
function restore(db: RecordDb, b: ReturnType<typeof backup>) {
  for (const [table, rows] of Object.entries(b)) {
    db.raw.exec(`DELETE FROM ${table}`);
    for (const r of rows) {
      const cols = Object.keys(r);
      db.raw.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(r) as never[]));
    }
  }
}

async function seeded() {
  const srv = await server();
  const a = device(srv.cfg);
  a.store.mutate('x', (d) => {
    ops.createPlan(d, 'P');
    ops.addTask(d, 'original');
  });
  await a.sync();
  return { srv, a };
}
const editTask = (d: ReturnType<typeof device>, title: string) => d.store.mutate('edit', (s) => void ops.updateTask(s, s.plans[0].tasks[0].id, { title }));

describe('durability settings', () => {
  it('commits are fully synced to disk (survive a power cut, not just a crash)', () => {
    const db = openDb(':memory:');
    expect((db.raw.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2); // FULL
    db.close();
  });
});

describe('server history going back', () => {
  it('a whole-database restore is detected and the acknowledged edit is re-sent', async () => {
    const { srv, a } = await seeded();
    const old = backup(srv.db);
    editTask(a, 'acknowledged');
    await a.sync();
    restore(srv.db, old);
    await a.sync();
    const b = device(srv.cfg);
    await b.sync();
    expect(b.title()).toBe('acknowledged');
    expect(a.client.getStatus().phase).toBe('idle');
  });

  it('…even when other writes moved the restored history past our old position', async () => {
    const { srv, a } = await seeded();
    const old = backup(srv.db);
    editTask(a, 'acknowledged');
    a.store.mutate('more', (s) => {
      for (let i = 0; i < 3; i++) ops.addTask(s, `more ${i}`);
    });
    await a.sync();
    restore(srv.db, old);
    // Another device writes several records after the restore, before A comes back.
    const c = device(srv.cfg);
    await c.sync();
    c.store.mutate('c', (s) => {
      for (let i = 0; i < 12; i++) ops.addNote(s, `c ${i}`);
    });
    await c.sync();
    await a.sync();
    const b = device(srv.cfg);
    await b.sync();
    expect(b.title()).toBe('acknowledged');
    expect(b.store.get().plans[0].tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['more 0', 'more 1', 'more 2']));
  });
});

describe('upgrading from the older sync bookkeeping', () => {
  it('unsent edits recorded only as a difference from the old hash base still reach the server', async () => {
    const srv = await server();
    const a = device(srv.cfg);
    a.store.mutate('x', (d) => {
      ops.createPlan(d, 'P');
      ops.addTask(d, 'synced before the upgrade');
    });
    await a.sync();
    // Rewrite A's document as the previous version stored it: a hash base, no revisions…
    const s = structuredClone(a.store.get());
    const base: Record<string, string> = {};
    for (const [id, r] of decompose(s)) if (id !== 'settings' && id !== 'hie') base[id] = hashData(r.data) + (r.parent ?? '');
    // …with an edit made (and saved) but not yet synced before upgrading.
    ops.updateTask(s, s.plans[0].tasks[0].id, { title: 'edited before the upgrade' });
    const oldDoc = JSON.stringify({ ...s, syncMeta: { clientId: 'old', cursor: a.meta()!.cursor, base, lastT: 0, url: srv.cfg.url } });
    const upgraded = device(srv.cfg, oldDoc);
    await upgraded.sync();
    const b = device(srv.cfg);
    await b.sync();
    expect(b.title()).toBe('edited before the upgrade');
  });
});

describe('restoring a guarded deletion', () => {
  it('brings back only the deletions that were paused; other pending edits still go out', async () => {
    const srv = await server();
    const a = device(srv.cfg);
    a.store.mutate('x', (d) => {
      ops.createPlan(d, 'keep me');
      ops.createPlan(d, 'and me');
      ops.createPlan(d, 'edited');
    });
    await a.sync();
    a.store.mutate('del', (d) => {
      for (const p of d.plans.filter((x) => x.title !== 'edited')) ops.deleteWs(d, p.id);
    });
    a.store.mutate('rename', (d) => void ops.renameWs(d, d.plans.find((x) => x.title === 'edited')!.id, 'renamed meanwhile'));
    await expect(a.sync()).rejects.toThrow(/已暂停/);
    await a.client.restoreFromServer();
    expect(a.store.get().plans.map((p) => p.title).sort()).toEqual(['and me', 'keep me', 'renamed meanwhile']);
    const b = device(srv.cfg);
    await b.sync();
    expect(b.store.get().plans.map((p) => p.title).sort()).toEqual(['and me', 'keep me', 'renamed meanwhile']);
  });
});
