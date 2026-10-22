import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../src/state';
import * as ops from '../src/ops';
import { generateReview, reviewMarkdown, weekRange } from '../src/review';
import { createStore } from '../src/store';
import { execute, type CmdCtx } from '../src/commands';

afterEach(() => vi.useRealTimers());
const at = (s: string) => new Date(s).getTime();
const set = (s: string) => vi.setSystemTime(new Date(s));

/** A plan worked on through the week of Mon 2026-10-19 (dates in local time). */
function week() {
  vi.useFakeTimers();
  set('2026-10-12T09:00:00'); // the week before: one task done
  const d = emptyState();
  ops.createPlan(d, '网站改版');
  const a = ops.addTask(d, 'A');
  ops.setTaskStatus(d, a.id, 'active');
  ops.setTaskStatus(d, a.id, 'done');
  set('2026-10-19T09:00:00'); // Monday
  const b = ops.addTask(d, 'B');
  const c = ops.addTask(d, 'C');
  ops.startSession(d, { intent: 'B', plannedMin: 30, tier: 'opus', effort: 'medium' });
  ops.setTaskStatus(d, b.id, 'active');
  set('2026-10-19T10:00:00'); // 60 min of a 30 min plan
  ops.setTaskStatus(d, b.id, 'done');
  ops.endSession(d, { fatigue: 2 });
  set('2026-10-20T11:00:00'); // Tuesday
  ops.markFatigue(d, 4);
  ops.markFatigue(d, 3);
  ops.deferTask(d, c.id, '等设计稿');
  set('2026-10-21T11:00:00');
  ops.deferTask(d, c.id, '还在等');
  set('2026-10-21T23:30:00'); // Wednesday night, across midnight
  ops.startSession(d, { intent: 'late', plannedMin: 60, tier: 'sonnet', effort: 'medium' });
  set('2026-10-22T00:30:00');
  ops.endSession(d, {});
  set('2026-10-23T12:00:00'); // "now": Friday
  return { d, b, c };
}

describe('weekly review', () => {
  it('weeks run Monday 00:00 to Monday 00:00', () => {
    const r = weekRange(0, at('2026-10-21T15:00:00'));
    expect(r.from).toBe(at('2026-10-19T00:00:00'));
    expect(r.to).toBe(at('2026-10-26T00:00:00'));
    expect(weekRange(-1, at('2026-10-19T00:00:00')).from).toBe(at('2026-10-12T00:00:00'));
    expect(weekRange(0, at('2026-10-25T23:59:00')).from).toBe(at('2026-10-19T00:00:00')); // Sunday still belongs to it
  });

  it('counts the week only, splits sessions across midnight, keeps each day’s highest fatigue', () => {
    const { d } = week();
    const r = generateReview(d);
    expect(r.totals).toMatchObject({ done: 1, added: 2, deferred: 2, sessions: 2, activeDays: 3 }); // Mon, Wed and Thu (after midnight)
    expect(r.previous.done).toBe(1);
    expect(r.totals.focusMs).toBe(2 * 3_600_000);
    const day = (s: string) => r.days.find((x) => x.start === at(s))!;
    expect(day('2026-10-19T00:00:00')).toMatchObject({ focusMs: 3_600_000, done: 1, fatigue: 2 });
    expect(day('2026-10-20T00:00:00').fatigue).toBe(4); // highest of the day, not the last
    expect(day('2026-10-21T00:00:00').focusMs).toBe(30 * 60_000); // 23:30–24:00
    expect(day('2026-10-22T00:00:00').focusMs).toBe(30 * 60_000); // 00:00–00:30
    expect(r.days).toHaveLength(7);
  });

  it('lists drift with its reasons, and per-workspace work', () => {
    const { d } = week();
    const r = generateReview(d);
    expect(r.drift.map((x) => [x.type, x.title, x.reason])).toEqual([
      ['defer', 'C', '等设计稿'],
      ['defer', 'C', '还在等'],
    ]);
    expect(r.workspaces[0]).toMatchObject({ title: '网站改版', done: ['B'], added: 2 });
    expect(r.tiers.opus).toBe(3_600_000);
  });

  it('points out patterns worth noticing', () => {
    const { d } = week();
    const r = generateReview(d);
    expect(r.insights.join('\n')).toMatch(/「C」被延期了 2 次/);
    expect(r.overrun).toBeCloseTo(1.5); // 60/30 and 60/60
    expect(r.insights.join('\n')).toMatch(/计划时长的 150%/);
  });

  it('an empty week says so instead of showing nothing', () => {
    vi.useFakeTimers();
    set('2026-10-21T12:00:00');
    expect(generateReview(emptyState()).insights).toEqual([expect.stringMatching(/休息也是计划的一部分/)]);
  });

  it('renders as Markdown with every section', () => {
    const { d } = week();
    const md = reviewMarkdown(generateReview(d));
    for (const h of ['# 周回顾 · 本周 10-19 – 10-25', '## 值得注意', '## 每天', '## 计划与目标', '## 偏离与修正', '## 投入方式']) expect(md).toContain(h);
    expect(md).toContain('还在等');
  });

  it('/review opens this week, /review last the one before; anything else explains the usage', () => {
    const store = createStore(emptyState());
    const open = vi.fn();
    const ctx: CmdCtx = { store, open, exportData: vi.fn(), importData: vi.fn(), showDiff: vi.fn() };
    execute('/review', ctx);
    execute('/review last', ctx);
    execute('/review -3', ctx);
    expect(open.mock.calls.map((c) => c[0])).toEqual([{ type: 'review', offset: 0 }, { type: 'review', offset: -1 }, { type: 'review', offset: -3 }]);
    expect(execute('/review tomorrow', ctx)).toMatchObject({ error: true });
  });
});
