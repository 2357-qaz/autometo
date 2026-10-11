import { describe, expect, it } from 'vitest';
import { emptyState } from '../src/state';
import * as ops from '../src/ops';
import { compose, decompose } from '../src/sync';
import { duplicateRecordIds, parseImport, repairDuplicateIds } from '../src/validate';

function planWithTasks() {
  const d = emptyState();
  ops.createPlan(d, 'P');
  ops.addTask(d, 'a');
  ops.addTask(d, 'b');
  return d;
}

describe('data integrity', () => {
  it('two devices committing the same version number keep both, renumbered the same way everywhere', () => {
    const a = planWithTasks();
    const b = structuredClone(a);
    ops.commitPlan(a, 'from A');
    ops.commitPlan(b, 'from B');
    const recs = new Map([...decompose(a), ...decompose(b)]);
    const merged = compose(recs.values(), a.ui);
    const vs = merged.plans[0].versions;
    expect(vs.map((v) => v.message).sort()).toEqual(['from A', 'from B']);
    expect(vs.map((v) => v.v)).toEqual([1, 2]);
    // Order does not depend on which device composes.
    const other = compose([...recs.values()].reverse(), b.ui);
    expect(other.plans[0].versions.map((v) => v.message)).toEqual(vs.map((v) => v.message));
  });

  it('import rejects colliding ids and invalid statuses, naming the problem', () => {
    const d = planWithTasks();
    d.plans[0].tasks[1].id = d.plans[0].tasks[0].id;
    expect(() => parseImport(d)).toThrow(/ID 被多条数据共用/);
    const e = planWithTasks();
    (e.plans[0].tasks[0] as { status: string }).status = 'weird';
    expect(() => parseImport(e)).toThrow(/状态无效/);
    expect(parseImport(planWithTasks()).plans[0].tasks).toHaveLength(2);
  });

  it('stored data with colliding ids is repaired by keeping every entity', () => {
    const d = planWithTasks();
    d.plans[0].tasks[1].id = d.plans[0].tasks[0].id;
    const fixed = repairDuplicateIds(d);
    expect(duplicateRecordIds(fixed)).toEqual([]);
    expect(fixed.plans[0].tasks.map((t) => t.title)).toEqual(['a', 'b']);
    expect(repairDuplicateIds(d).plans[0].tasks[1].id).toBe(fixed.plans[0].tasks[1].id); // deterministic
  });
});
