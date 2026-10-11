import { describe, expect, it, vi } from 'vitest';
import { emptyState } from '../src/state';
import * as ops from '../src/ops';
import { activeSession, otherSessions, tokensToday } from '../src/hie';
import { createStore } from '../src/store';
import { execute, type CmdCtx } from '../src/commands';
import type { AppState } from '../src/types';

/** One shared plan as seen by two devices (same data, different ui.deviceId). */
function twoDevices() {
  const a = emptyState();
  a.ui.deviceId = 'dev-a';
  ops.createPlan(a, 'P');
  for (const t of ['one', 'two', 'three']) ops.addTask(a, t);
  const b = structuredClone(a);
  b.ui.deviceId = 'dev-b';
  return { a, b };
}
const id = (s: AppState, title: string) => s.plans[0].tasks.find((t) => t.title === title)!.id;
const statuses = (s: AppState) => Object.fromEntries(s.plans[0].tasks.map((t) => [t.title, t.status]));

describe('parallel work on several devices', () => {
  it('starting a task pauses only this device’s other task, never another device’s', () => {
    const { a } = twoDevices();
    ops.setTaskStatus(a, id(a, 'one'), 'active');
    // Simulate B's work arriving by sync: "two" in progress on dev-b.
    Object.assign(a.plans[0].tasks.find((t) => t.title === 'two')!, { status: 'active', activeBy: 'dev-b' });
    ops.setTaskStatus(a, id(a, 'three'), 'active');
    expect(statuses(a)).toEqual({ one: 'pending', two: 'active', three: 'active' });
    expect(ops.currentTask(a.plans[0], a)?.title).toBe('three');
    expect(ops.otherActiveTasks(a.plans[0], a).map((t) => t.title)).toEqual(['two']);
  });

  it('/done and /next act on this device’s task; with only another device’s, they say so', () => {
    const { a } = twoDevices();
    Object.assign(a.plans[0].tasks[1], { status: 'active', activeBy: 'dev-b' });
    expect(() => ops.resolveTask(a.plans[0], '', a)).toThrow(/另一台设备在做「two」/);
    ops.setTaskStatus(a, id(a, 'one'), 'active');
    ops.nextTask(a);
    expect(statuses(a)).toEqual({ one: 'done', two: 'active', three: 'active' });
    expect(a.plans[0].tasks.find((t) => t.title === 'two')!.activeBy).toBe('dev-b');
  });

  it('sessions run in parallel: each device has its own, budgets add up, a forgotten one can be ended', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00'));
    const { a } = twoDevices();
    a.sessions.push({ id: 'sb', runId: 'sb', wsId: a.plans[0].id, tier: 'sonnet', effort: 'medium', intent: 'B work', plannedMin: 25, startedAt: Date.now(), device: 'dev-b' });
    expect(activeSession(a)).toBeUndefined();
    ops.startSession(a, { intent: 'A work', plannedMin: 25, tier: 'sonnet', effort: 'medium' });
    expect(activeSession(a)?.intent).toBe('A work');
    expect(otherSessions(a).map((s) => s.intent)).toEqual(['B work']);
    vi.setSystemTime(new Date('2026-10-11T10:10:00'));
    expect(tokensToday(a)).toBe(2 * 8000); // both sessions are real, declared work
    const store = createStore(a);
    const ctx: CmdCtx = { store, open: vi.fn(), exportData: vi.fn(), importData: vi.fn(), showDiff: vi.fn() };
    execute('/end other', ctx);
    expect(otherSessions(store.get())).toEqual([]);
    expect(activeSession(store.get())?.intent).toBe('A work'); // this device's keeps running
    vi.useRealTimers();
  });

  it('older data without device tags still behaves as one device', () => {
    const s = emptyState();
    ops.createPlan(s, 'P');
    ops.addTask(s, 'x');
    s.plans[0].tasks[0].status = 'active'; // no activeBy
    s.sessions.push({ id: 'old', runId: 'old', wsId: null, tier: 'sonnet', effort: 'medium', intent: '', plannedMin: 25, startedAt: Date.now() });
    expect(ops.currentTask(s.plans[0], s)?.title).toBe('x');
    expect(activeSession(s)?.id).toBe('old');
  });
});
