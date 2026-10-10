import { describe, expect, it } from 'vitest';
import { emptyState } from '../src/state';
import * as ops from '../src/ops';
import { dueReminders } from '../src/reminders';

const DAY = 86_400_000;

describe('dueReminders', () => {
  it('flags due checkpoints, overdue phases and overrun sessions with stable keys', () => {
    const d = emptyState();
    const g = ops.createGoal(d, '学吉他', { cadenceDays: 3 });
    const p = ops.createPlan(d, '网站');
    const t0 = g.createdAt;
    const due = ops.parseDue('+10d', t0)!; // ten days from now
    p.phases[0].due = due;
    const afterDue = ops.dueAt(due) + 2 * DAY;
    expect(dueReminders(d, t0 + DAY)).toEqual([]);
    const later = dueReminders(d, t0 + 4 * DAY).map((r) => r.key.split(':')[0]);
    expect(later).toContain('cp');
    expect(dueReminders(d, t0 + 4 * DAY).some((r) => r.key.startsWith('due:'))).toBe(false);
    const overdue = dueReminders(d, afterDue).find((r) => r.key.startsWith('due:'));
    expect(overdue?.key).toBe(`due:${p.phases[0].id}:${due}`);
    // Completing the phase silences it.
    ops.completePhase(d, p.phases[0].id);
    expect(dueReminders(d, afterDue).some((r) => r.key.startsWith('due:'))).toBe(false);
    // A checkpoint moves the next due date → new key.
    const k1 = dueReminders(d, t0 + 4 * DAY).find((r) => r.key.startsWith('cp:'))!.key;
    ops.addCheckpoint(d, g.id, { progress: 10, verdict: 'on-track', did: 'x', learned: '', next: '' });
    const k2 = dueReminders(d, Date.now() + 4 * DAY).find((r) => r.key.startsWith('cp:'))!.key;
    expect(k2).not.toBe(k1);
  });

  it('reminds once a focus session runs past its planned length', () => {
    const d = emptyState();
    ops.createPlan(d, 'P');
    ops.startSession(d, { intent: '写作', plannedMin: 25, tier: 'sonnet', effort: 'medium' });
    const start = d.sessions[0].startedAt;
    expect(dueReminders(d, start + 20 * 60_000)).toEqual([]);
    const r = dueReminders(d, start + 26 * 60_000);
    expect(r.map((x) => x.key)).toEqual([`ses:${d.sessions[0].runId}`]);
    expect(r[0].body).toContain('写作');
  });
});
