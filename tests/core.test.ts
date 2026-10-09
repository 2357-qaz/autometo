import { describe, expect, it, vi } from 'vitest';
import { emptyState, normalize, createStore } from '../src/store';
import * as ops from '../src/ops';
import { execute, type CmdCtx } from '../src/commands';
import { budgetLevel, estimateTokens, tokensToday } from '../src/hie';
import { generateCompact } from '../src/compact';
import { seedDemo } from '../src/demo';

const mkCtx = () => {
  const store = createStore(emptyState(), false);
  const open = vi.fn();
  const ctx: CmdCtx = { store, open, exportData: vi.fn(), importData: vi.fn() };
  return { store, open, ctx };
};

describe('plan engine', () => {
  it('keeps exactly one active task and advances with /next', () => {
    const { store, ctx } = mkCtx();
    execute('/plan 写论文', ctx);
    execute('读文献', ctx);
    execute('列提纲', ctx);
    execute('/start 1', ctx);
    execute('/start 2', ctx);
    let p = store.get().plans[0];
    expect(p.tasks.map((t) => t.status)).toEqual(['pending', 'active']);
    execute('/next', ctx);
    p = store.get().plans[0];
    expect(p.tasks.map((t) => t.status)).toEqual(['active', 'done']);
    const r = execute('/done', ctx);
    expect(r?.error).toBeFalsy();
    expect(store.get().plans[0].tasks.every((t) => t.status === 'done')).toBe(true);
  });

  it('revise requires a reason and logs old → new', () => {
    const d = emptyState();
    const p = ops.createPlan(d, 'X');
    const ph = p.phases[0];
    expect(() => ops.revisePhase(d, ph.id, 'new goal', '')).toThrow(ops.UserError);
    ops.revisePhase(d, ph.id, 'new goal', 'learned something');
    expect(d.plans[0].phases[0].goal).toBe('new goal');
    expect(d.plans[0].log.at(-1)?.kind).toBe('revise');
  });

  it('completing a phase activates the next one', () => {
    const d = emptyState();
    ops.createPlan(d, 'X');
    ops.addPhase(d, 'B');
    const [a, b] = d.plans[0].phases;
    ops.completePhase(d, a.id);
    expect(d.plans[0].phases.find((x) => x.id === b.id)?.status).toBe('active');
  });
});

describe('commands & undo', () => {
  it('reports unknown commands and errors without mutating', () => {
    const { store, ctx } = mkCtx();
    expect(execute('/nope', ctx)?.error).toBe(true);
    expect(execute('/done', ctx)?.error).toBe(true);
    expect(store.canUndo()).toBe(false);
  });

  it('plain text creates a workspace first, then tasks; undo reverts', () => {
    const { store, ctx } = mkCtx();
    execute('My plan', ctx);
    execute('task a', ctx);
    expect(store.get().plans[0].tasks).toHaveLength(1);
    store.undo();
    expect(store.get().plans[0].tasks).toHaveLength(0);
    store.undo();
    expect(store.get().plans).toHaveLength(0);
  });

  it('# writes a note to the log', () => {
    const { store, ctx } = mkCtx();
    execute('/goal 学吉他', ctx);
    execute('#今天练了 C 和弦', ctx);
    expect(store.get().goals[0].log.at(-1)?.text).toBe('今天练了 C 和弦');
  });
});

describe('goal checkpoints', () => {
  it('records checkpoint, updates next action, computes due date', () => {
    const d = emptyState();
    const g = ops.createGoal(d, 'G', { cadenceDays: 3 });
    expect(ops.checkpointDue(g, g.createdAt + 2 * 86_400_000)).toBe(false);
    expect(ops.checkpointDue(g, g.createdAt + 3 * 86_400_000)).toBe(true);
    expect(() => ops.addCheckpoint(d, g.id, { progress: 10, verdict: 'on-track', did: '', learned: '', next: '' })).toThrow();
    ops.addCheckpoint(d, g.id, { progress: 140, verdict: 'pivot', did: 'x', learned: '', next: 'try Y' });
    expect(d.goals[0].checkpoints[0].progress).toBe(100);
    expect(d.goals[0].nextAction).toBe('try Y');
  });
});

describe('HIE', () => {
  it('estimates tokens by tier × effort', () => {
    expect(estimateTokens('core', 'medium', 60)).toBe(48_000);
    expect(estimateTokens('deep', 'high', 60)).toBe(135_000);
    expect(estimateTokens('lite', 'low', 10)).toBe(2400);
  });

  it('accumulates session tokens across a tier switch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00'));
    const d = emptyState();
    ops.startSession(d, { intent: '', plannedMin: 30, tier: 'core', effort: 'medium' });
    vi.setSystemTime(new Date('2026-10-09T10:10:00'));
    ops.setTier(d, 'deep');
    vi.setSystemTime(new Date('2026-10-09T10:20:00'));
    expect(tokensToday(d)).toBe(8000 + 15000);
    const msg = ops.endSession(d, { fatigue: 3 });
    expect(msg).toContain('20 分钟');
    expect(msg).toContain('23,000');
    expect(d.fatigue.at(-1)?.level).toBe(3);
    vi.useRealTimers();
  });

  it('budget levels', () => {
    expect(budgetLevel(10, 100)).toBe('ok');
    expect(budgetLevel(70, 100)).toBe('warn');
    expect(budgetLevel(90, 100)).toBe('low');
    expect(budgetLevel(100, 100)).toBe('over');
    expect(ops.parseTokenAmount('150k')).toBe(150_000);
    expect(ops.parseTokenAmount('1.5m')).toBe(1_500_000);
  });
});

describe('compact & persistence', () => {
  it('generates a snapshot with where/next sections', () => {
    const d = emptyState();
    seedDemo(d);
    const text = generateCompact(d, d.plans[0]);
    expect(text).toContain('# Compact · 个人网站改版');
    expect(text).toContain('进行中：');
    expect(text).toContain('## 下一步');
    expect(generateCompact(d, d.goals[0])).toContain('今晚下班后快走');
  });

  it('round-trips through JSON and rejects garbage', () => {
    const d = emptyState();
    seedDemo(d);
    const back = normalize(JSON.parse(JSON.stringify(d)));
    expect(back.plans[0].tasks.length).toBe(d.plans[0].tasks.length);
    expect(() => normalize({ version: 2 })).toThrow(/版本/);
    expect(() => normalize([])).toThrow();
  });
});
