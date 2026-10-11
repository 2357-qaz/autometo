import { describe, expect, it } from 'vitest';
import { createDocPersistence, mergeMeta } from '../src/persistence';
import { createStore } from '../src/store';
import { emptyState, normalize } from '../src/state';
import { newSyncMeta } from '../src/sync';
import * as ops from '../src/ops';

function disk(initial: string | null = null) {
  const d = { doc: initial, writes: 0 };
  return { d, io: { read: () => d.doc, write: (t: string) => void ((d.doc = t), d.writes++) } };
}

describe('single-document persistence', () => {
  it('updateMeta writes meta and the current state in one write', () => {
    const { d, io } = disk();
    const p = createDocPersistence(io);
    p.load();
    const store = createStore(emptyState(), p.persist, 10_000); // debounced save far away
    p.attach(store);
    store.mutate('x', (s) => void ops.createPlan(s, '同一次写入'));
    expect(d.writes).toBe(0); // state not written yet (debounce)
    p.updateMeta((m) => ({ ...m, cursor: 42 }));
    expect(d.writes).toBe(1);
    const doc = JSON.parse(d.doc!);
    expect(doc.syncMeta.cursor).toBe(42);
    expect(doc.plans[0].title).toBe('同一次写入');
    // Reloading yields the same pair.
    const p2 = createDocPersistence(io);
    expect(p2.load().state.plans[0].title).toBe('同一次写入');
    expect(p2.loadMeta()?.cursor).toBe(42);
  });

  it('a local edit is recorded (revision + outbox) and saved in the same document as the data', () => {
    const { d, io } = disk();
    const p = createDocPersistence(io);
    p.load();
    const store = createStore(emptyState(), p.persist, 0);
    p.attach(store);
    store.mutate('x', (s) => void ops.createPlan(s, 'P'));
    store.flush();
    const doc = JSON.parse(d.doc!);
    const planKey = `plan:${doc.plans[0].id}`;
    expect(doc.syncMeta.outbox[planKey]).toBeTruthy();
    expect(doc.syncMeta.revs[planKey]).toBe(doc.syncMeta.outbox[planKey]);
  });

  it('adopts meta from the legacy location, and the meta never leaks into state', () => {
    const legacy = { ...newSyncMeta('old'), cursor: 7 };
    const { io } = disk(JSON.stringify(emptyState()));
    const p = createDocPersistence(io, () => legacy);
    const { state } = p.load();
    expect(p.loadMeta()?.cursor).toBe(7);
    expect('syncMeta' in state).toBe(false);
  });

  it("imported data never carries another device's sync meta", () => {
    const s = normalize({ ...emptyState(), syncMeta: { clientId: 'x', cursor: 99, base: {}, lastT: 0 } });
    expect('syncMeta' in s).toBe(false);
  });

  it('two writers of one document: both changes survive, the newer edit of a shared record wins', () => {
    const { d, io } = disk(JSON.stringify(emptyState()));
    const open = () => {
      const p = createDocPersistence(io);
      const store = createStore(p.load().state, p.persist, 60_000);
      p.attach(store);
      return { p, store };
    };
    const seed = open();
    seed.store.mutate('x', (s) => {
      ops.createPlan(s, 'P');
      ops.addTask(s, 'shared');
    });
    seed.store.flush();
    const a = open();
    const b = open();
    a.store.mutate('a', (s) => void ops.addTask(s, 'from A'));
    a.store.mutate('a2', (s) => void ops.updateTask(s, s.plans[0].tasks[0].id, { title: 'A edit' }));
    b.store.mutate('b', (s) => void ops.addTask(s, 'from B'));
    b.store.mutate('b2', (s) => void ops.updateTask(s, s.plans[0].tasks[0].id, { title: 'B edit (later)' }));
    expect(a.store.flush()).toBe(true);
    expect(b.store.flush()).toBe(true); // B wrote on top of A's newer document: merged
    const doc = JSON.parse(d.doc!);
    expect(doc.plans[0].tasks.map((t: { title: string }) => t.title).sort()).toEqual(['B edit (later)', 'from A', 'from B']);
    // Both writers' unsent edits are still queued for the server.
    const outboxTasks = Object.keys(doc.syncMeta.outbox).filter((k) => k.startsWith('task:'));
    expect(outboxTasks).toHaveLength(3);
    // A picks B's write up by merging (nothing of its own is lost).
    const merged = a.p.reload()!;
    expect(merged.plans[0].tasks.map((t) => t.title).sort()).toEqual(['B edit (later)', 'from A', 'from B']);
    a.store.applyExternal(merged);
    expect(a.p.reload()).toBeNull(); // nothing new: no ping-pong between writers
  });

  it('an outbox entry the other writer already synced is not sent again', () => {
    const base = { ...newSyncMeta('x'), revs: { r1: 'a1', r2: 'a2' }, outbox: { r1: 'a1', r2: 'a2' } };
    const syncedByOther = { ...base, outbox: { r2: 'a2' }, cursor: 9, synced: true }; // r1 acknowledged there
    const m = mergeMeta(base, syncedByOther)!;
    expect(m.outbox).toEqual({ r2: 'a2' });
    expect(m.cursor).toBe(9);
  });
});
