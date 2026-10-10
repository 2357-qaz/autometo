import { describe, expect, it } from 'vitest';
import { emptyState } from '../src/state';
import { seedDemo } from '../src/demo';
import * as ops from '../src/ops';
import { compose, decompose, hashData, makeRev, prepareSync, newSyncMeta } from '../src/sync';
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

describe('change detection', () => {
  it('only sends what changed since the base, plus tombstones', () => {
    const d = emptyState();
    ops.createPlan(d, 'P');
    const t = ops.addTask(d, 'a');
    const meta = newSyncMeta('dev1');
    const first = prepareSync(d, meta, 1000);
    // Everything except untouched default settings/hie, which are "unset".
    expect(first.request.changes.length).toBe(first.snapshot.size - 2);
    expect(first.request.changes.some((c) => c.id === 'settings' || c.id === 'hie')).toBe(false);
    const base = Object.fromEntries(first.hashes);
    ops.updateTask(d, t.id, { title: 'b' });
    ops.deleteTask(d, t.id);
    const second = prepareSync(d, { ...meta, base }, 2000);
    const ids = second.request.changes.map((c) => `${c.id}${c.deleted ? '✗' : ''}`);
    expect(ids).toContain(`task:${t.id}✗`);
    expect(ids.some((i) => i.startsWith('log:'))).toBe(true);
    expect(ids).not.toContain('settings');
  });

  it('revisions sort by time then client, and hashes ignore key order', () => {
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

describe('applySync bookkeeping', () => {
  it('keeps a base entry for a record deleted mid-flight so the next round sends a tombstone', async () => {
    const { applySync } = await import('../src/sync');
    const d = emptyState();
    ops.createPlan(d, 'P');
    const t = ops.addTask(d, 'x');
    let meta = newSyncMeta('dev');
    const p1 = prepareSync(d, meta);
    meta = applySync(d, p1, { cursor: 1, records: [] }, meta).meta; // fully synced
    ops.addNote(d, 'edit');
    const p2 = prepareSync(d, meta); // request in flight…
    ops.deleteTask(d, t.id); // …and the task is deleted meanwhile
    meta = applySync(d, p2, { cursor: 2, records: [] }, meta).meta;
    const p3 = prepareSync(d, meta);
    expect(p3.request.changes.find((c) => c.id === `task:${t.id}`)).toMatchObject({ deleted: true });
  });

  it('pull-only first sync does not mark local records as synced', async () => {
    const { applySync } = await import('../src/sync');
    const d = emptyState();
    ops.createPlan(d, 'local only');
    const meta = newSyncMeta('dev');
    const probe = prepareSync(d, meta);
    const out = applySync(d, { ...probe, request: { ...probe.request, changes: [] } }, { cursor: 0, records: [] }, meta, { pullOnly: true });
    expect(Object.keys(out.meta.base)).toEqual([]);
    expect(prepareSync(d, out.meta).request.changes.some((c) => c.kind === 'plan')).toBe(true);
  });
});
