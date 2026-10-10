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
    expect(first.request.changes.length).toBe(first.snapshot.size);
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
