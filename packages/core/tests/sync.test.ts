import { describe, expect, it } from 'vitest';
import { emptyState } from '../src/state';
import { seedDemo } from '../src/demo';
import * as ops from '../src/ops';
import { applyResponse, compose, decompose, hashData, makeRev, migrateMeta, newSyncMeta, prepareSync, reconcile, revTime } from '../src/sync';
import { createStore } from '../src/store';
import { createDocPersistence } from '../src/persistence';
import type { AppState } from '../src/types';

const strip = (s: AppState) => {
  const c = structuredClone(s) as AppState;
  for (const w of [...c.plans, ...c.goals]) w.updatedAt = 0;
  return c;
};

describe('record decomposition', () => {
  it('round-trips the demo state (except derived updatedAt)', () => {
    const d = emptyState();
    seedDemo(d);
    const back = compose(decompose(d).values(), d.ui);
    expect(strip(back)).toEqual(strip(d));
  });

  it('drops orphans and re-homes tasks whose phase disappeared', () => {
    const d = emptyState();
    const p = ops.createPlan(d, 'P');
    ops.addPhase(d, 'B');
    const t = ops.addTask(d, 'x', p.phases[1].id);
    const recs = decompose(d);
    recs.delete(`phase:${p.phases[1].id}`);
    recs.set('task:ghost', { id: 'task:ghost', kind: 'task', parent: 'plan:nope', data: { id: 'ghost' } });
    const back = compose(recs.values(), d.ui);
    expect(back.plans[0].tasks.map((x) => x.id)).toEqual([t.id]);
    expect(back.plans[0].tasks[0].phaseId).toBe(p.phases[0].id);
  });
});

describe('revisions', () => {
  it('sort by time then client, and hashes ignore key order', () => {
    expect(makeRev(5, 'a') < makeRev(10, 'a')).toBe(true);
    expect(makeRev(10, 'a') < makeRev(10, 'b')).toBe(true);
    expect(hashData({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashData({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});

describe('event ordering', () => {
  it('keeps same-millisecond events in order through a round trip', () => {
    const d = emptyState();
    ops.createPlan(d, 'P');
    const t = ops.addTask(d, 'a');
    ops.setTaskStatus(d, t.id, 'active'); // emits commit + start in one go
    const types = d.plans[0].log.map((e) => e.type);
    const back = compose(decompose(d).values(), d.ui);
    expect(back.plans[0].log.map((e) => e.type)).toEqual(types);
    const ats = d.plans[0].log.map((e) => e.at);
    expect(ats.every((x, i) => i === 0 || x > ats[i - 1])).toBe(true);
  });
});

/** A store whose local edits are recorded into a meta, like a real device. */
function device(id = 'dev', initial = emptyState()) {
  let doc: string | null = JSON.stringify(initial);
  const p = createDocPersistence({ read: () => doc, write: (t) => void (doc = t) }, () => newSyncMeta(id));
  const store = createStore(p.load().state, p.persist, 0);
  p.attach(store);
  return { store, meta: () => p.loadMeta()!, update: p.updateMeta };
}

describe('recording local edits', () => {
  it('stamps each changed record at edit time; a retry sends exactly the same revisions', () => {
    const d = device();
    d.store.mutate('x', (s) => void ops.createPlan(s, 'P'));
    const synced = { ...d.meta(), synced: true, outbox: {} };
    d.update(() => synced);
    d.store.mutate('edit', (s) => void ops.addTask(s, 'a'));
    const first = prepareSync(d.store.get(), d.meta());
    const retry = prepareSync(d.store.get(), d.meta(), Date.now() + 60_000);
    expect(first.request.changes.length).toBeGreaterThan(0);
    expect(retry.request.changes).toEqual(first.request.changes); // idempotent: no new revisions
    expect(first.request.changes.every((c) => c.kind === 'task' || c.kind === 'log' || c.kind === 'phase')).toBe(true);
  });

  it('an explicit deletion becomes a tombstone; untouched default settings are never offered', () => {
    const d = device();
    let tid = '';
    d.store.mutate('x', (s) => {
      ops.createPlan(s, 'P');
      tid = ops.addTask(s, 'a').id;
    });
    const all = prepareSync(d.store.get(), d.meta()); // never synced: everything is new
    expect(all.request.changes.some((c) => c.id === 'settings' || c.id === 'hie')).toBe(false);
    d.update((m) => ({ ...m, synced: true, outbox: {} }));
    d.store.mutate('del', (s) => void ops.deleteTask(s, tid));
    const ids = prepareSync(d.store.get(), d.meta()).request.changes.map((c) => `${c.id}${c.deleted ? '✗' : ''}`);
    expect(ids).toContain(`task:${tid}✗`);
  });
});

describe('applying a response', () => {
  it('acknowledges only what was sent; an edit made in flight stays pending', () => {
    const d = device();
    d.store.mutate('x', (s) => void ops.createPlan(s, 'P'));
    d.update((m) => ({ ...m, synced: true }));
    const p1 = prepareSync(d.store.get(), d.meta());
    d.store.mutate('in flight', (s) => void ops.addTask(s, 'later')); // while the request is out
    const out = applyResponse(d.store.get(), d.meta(), p1.sent, { cursor: 5, records: [] });
    const left = Object.keys(out.meta.outbox);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((id) => !(id in p1.sent) || out.meta.outbox[id] !== p1.sent[id])).toBe(true);
    expect(out.meta.cursor).toBe(5);
  });

  it('a newer remote version wins; an older one never overwrites a newer pending edit', () => {
    const d = device();
    let tid = '';
    d.store.mutate('x', (s) => {
      ops.createPlan(s, 'P');
      tid = ops.addTask(s, 'mine').id;
    });
    d.update((m) => ({ ...m, synced: true }));
    const id = `task:${tid}`;
    const rec = decompose(d.store.get()).get(id)!;
    const mine = d.meta().outbox[id];
    const older = { id, kind: rec.kind, parent: rec.parent, rev: makeRev(1, 'other'), data: { ...(rec.data as object), title: 'old remote' } };
    const keep = applyResponse(d.store.get(), d.meta(), {}, { cursor: 1, records: [older] });
    expect(keep.state.plans[0].tasks[0].title).toBe('mine');
    expect(keep.meta.outbox[id]).toBe(mine);
    const newer = { ...older, rev: makeRev(revTime(mine) + 1000, 'other'), data: { ...(rec.data as object), title: 'new remote' } };
    const take = applyResponse(d.store.get(), d.meta(), {}, { cursor: 2, records: [newer] });
    expect(take.state.plans[0].tasks[0].title).toBe('new remote');
    expect(take.meta.outbox[id]).toBeUndefined();
    expect(take.meta.revs[id]).toBe(newer.rev);
  });
});

describe('reconciliation', () => {
  it('per record the newer revision wins, local-only records are queued, server-only ones arrive', () => {
    const d = device('me');
    d.store.mutate('x', (s) => {
      ops.createPlan(s, 'local plan');
    });
    const local = decompose(d.store.get());
    const planId = [...local.keys()].find((k) => k.startsWith('plan:'))!;
    const remotePlan = { id: 'plan:remote', kind: 'plan' as const, rev: makeRev(5, 'srv'), data: { id: 'remote', kind: 'plan', title: 'remote plan', objective: '', status: 'active', createdAt: 1 } };
    const out = reconcile(d.store.get(), { ...d.meta(), outbox: {} }, { cursor: 9, records: [remotePlan] });
    expect(out.state.plans.map((p) => p.title).sort()).toEqual(['local plan', 'remote plan']);
    expect(out.meta.outbox[planId]).toBe(d.meta().revs[planId]); // queued with its edit-time revision
    expect(out.meta.outbox['plan:remote']).toBeUndefined();
    expect(out.meta.outbox.settings).toBeUndefined(); // untouched defaults stay "unset"
    expect(out.meta.cursor).toBe(9);
  });

  it('a record this device never edited yields to the server', () => {
    const s = emptyState();
    ops.createPlan(s, 'from an old version');
    const id = [...decompose(s).keys()].find((k) => k.startsWith('plan:'))!;
    const server = { ...decompose(s).get(id)!, rev: makeRev(3, 'srv'), data: { ...(decompose(s).get(id)!.data as object), title: 'server title' } };
    const out = reconcile(s, newSyncMeta('me'), { cursor: 1, records: [server] });
    expect(out.state.plans[0].title).toBe('server title');
  });
});

describe('older meta format', () => {
  it('turns unsent changes (relative to the old hash base) into the outbox, deletions included', () => {
    const s = emptyState();
    ops.createPlan(s, 'P');
    const t = ops.addTask(s, 'gone');
    const base: Record<string, string> = {};
    for (const [id, r] of decompose(s)) base[id] = hashData(r.data) + (r.parent ?? '');
    ops.deleteTask(s, t.id);
    ops.addNote(s, 'unsent');
    const m = migrateMeta({ clientId: 'old', cursor: 7, base, lastT: 0 }, s)!;
    expect(m.synced).toBe(true);
    expect(m.cursor).toBe(7);
    const ids = prepareSync(s, m).request.changes.map((c) => `${c.id}${c.deleted ? '✗' : ''}`);
    expect(ids).toContain(`task:${t.id}✗`);
    expect(ids.some((i) => i.startsWith('log:'))).toBe(true);
    expect(ids).not.toContain('plan:' + s.plans[0].id);
  });
});

describe('undo', () => {
  it('reverts exactly the records the edit touched, never what arrived since', () => {
    const d = device();
    d.store.mutate('x', (s) => void ops.createPlan(s, 'P'));
    d.store.mutate('rename', (s) => void ops.renameWs(s, s.plans[0].id, 'renamed'));
    // A task arrives from another device.
    const remote = structuredClone(d.store.get());
    ops.addTask(remote, 'remote task');
    d.store.applyExternal(compose(decompose(remote).values(), d.store.get().ui));
    const r = d.store.undo()!;
    expect(r).toMatchObject({ label: 'rename', skipped: 0 });
    expect(d.store.get().plans[0].title).toBe('P');
    expect(d.store.get().plans[0].tasks.map((t) => t.title)).toEqual(['remote task']);
  });

  it('skips a record changed elsewhere since, and says so', () => {
    const d = device();
    d.store.mutate('x', (s) => void ops.createPlan(s, 'P'));
    d.store.mutate('rename', (s) => void ops.renameWs(s, s.plans[0].id, 'mine'));
    const remote = structuredClone(d.store.get());
    remote.plans[0].title = 'theirs';
    d.store.applyExternal(remote);
    const r = d.store.undo()!;
    expect(r.skipped).toBe(1); // the plan record: changed elsewhere, left alone
    expect(d.store.get().plans[0].title).toBe('theirs');
  });
});
