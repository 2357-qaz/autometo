import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../src/state';
import * as ops from '../src/ops';
import { glance } from '../src/glance';
import { reminderSchedule, dueReminders } from '../src/reminders';
import type { AppState } from '../src/types';

afterEach(() => vi.useRealTimers());
const at = (s: string) => vi.setSystemTime(new Date(s));
const task = (s: AppState, title: string) => s.plans[0].tasks.find((t) => t.title === title)!;

function plan() {
  vi.useFakeTimers();
  at('2026-10-22T09:00:00');
  const s = emptyState();
  s.ui.deviceId = 'dev-a';
  ops.createPlan(s, '个人网站');
  for (const t of ['配色', '首页', '部署']) ops.addTask(s, t);
  return s;
}

describe('glance (widget / Live Activity snapshot)', () => {
  it('shows the current task, its steps, the lanes running and what is next', () => {
    const s = plan();
    s.hie.tier = 'fable';
    ops.submitSplit(s, task(s, '配色').id, { doneWhen: '能用', steps: ['选字体', '定主色', '做样张'], start: '1 2' });
    ops.setTaskStatus(s, task(s, '选字体').id, 'done');
    ops.setTaskStatus(s, task(s, '做样张').id, 'active');
    const g = glance(s);
    expect(g.ws).toEqual({ kind: 'plan', title: '个人网站' });
    expect(g.task).toEqual({
      title: '配色',
      num: 1,
      steps: { done: 1, total: 3 },
      running: [{ title: '定主色', num: 3 }, { title: '做样张', num: 4 }],
    });
    expect(g.next).toEqual([{ title: '首页', num: 5 }, { title: '部署', num: 6 }]);
    expect(g.lanes).toBe(2);
    expect(g.tierLabel).toBe('Fable');
    expect(g.session).toBeNull();
  });

  it('prices the running session as of the snapshot', () => {
    const s = plan();
    ops.setTaskStatus(s, task(s, '首页').id, 'active');
    ops.startSession(s, { intent: '首页', plannedMin: 45, tier: 'opus', effort: 'high' });
    at('2026-10-22T09:20:00');
    const g = glance(s);
    expect(g.session).toMatchObject({ intent: '首页', tierLabel: 'Opus', lanes: 1, rate: 2250, tokens: 45_000 });
    expect(g.session!.plannedEnd - g.session!.startedAt).toBe(45 * 60_000);
    expect(g.used).toBe(45_000);
    expect(g.level).toBe('ok');
    expect(g.day).toBe(new Date('2026-10-22T00:00:00').getTime());
  });

  it('has nothing to show without a plan or goal', () => {
    const g = glance(emptyState());
    expect([g.ws, g.task, g.next, g.session]).toEqual([null, null, [], null]);
  });
});

describe('reminderSchedule (local notifications)', () => {
  it('schedules the session end, the next checkpoint and the morning after a phase is due', () => {
    const s = plan();
    ops.updatePhase(s, s.plans[0].phases[0].id, { due: '2026-10-24' });
    ops.createGoal(s, '跑步', { cadenceDays: 7 });
    ops.selectWs(s, s.plans[0].id);
    ops.startSession(s, { intent: '首页', plannedMin: 30, tier: 'sonnet', effort: 'medium' });
    const r = reminderSchedule(s);
    expect(r.map((x) => [x.key.split(':')[0], new Date(x.at).toISOString()])).toEqual([
      ['ses', new Date('2026-10-22T09:30:00').toISOString()],
      ['due', new Date('2026-10-25T09:00:00').toISOString()],
      ['cp', new Date('2026-10-29T09:00:00').toISOString()],
    ]);
    // The same texts and keys as the server's push reminders once they are due.
    at('2026-10-30T10:00:00');
    const due = dueReminders(s);
    for (const x of r) expect(due.find((d) => d.key === x.key)).toMatchObject({ title: x.title, body: x.body });
  });

  it('leaves out what is past, beyond the horizon, or another device’s session', () => {
    const s = plan();
    ops.updatePhase(s, s.plans[0].phases[0].id, { due: '2026-10-21' }); // already overdue
    ops.createGoal(s, '读书', { cadenceDays: 60 }); // beyond 30 days
    ops.startSession(s, { intent: '', plannedMin: 30, tier: 'sonnet', effort: 'medium' });
    s.sessions[0].device = 'dev-b';
    expect(reminderSchedule(s)).toEqual([]);
  });
});
