import { describe, expect, it, vi } from 'vitest';
import { emptyState, normalize } from '../src/state';
import { createStore } from '../src/store';
import * as ops from '../src/ops';
import { execute, type CmdCtx } from '../src/commands';
import { budgetLevel, estimateTokens, fatigueMult, runSegmentsTokens, tokensToday } from '../src/hie';
import { generateCompact } from '../src/compact';
import { seedDemo } from '../src/demo';
import { diffPlan, diffSummary } from '../src/diff';

const mkCtx = () => {
  const store = createStore(emptyState());
  const open = vi.fn();
  const ctx: CmdCtx = { store, open, exportData: vi.fn(), importData: vi.fn(), showDiff: vi.fn() };
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
    expect(d.plans[0].log.at(-1)?.type).toBe('revise');
    expect(d.plans[0].versions.map((v) => v.v)).toEqual([1, 2]);
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
    expect(estimateTokens('sonnet', 'medium', 60)).toBe(48_000);
    expect(estimateTokens('opus', 'high', 60)).toBe(135_000);
    expect(estimateTokens('haiku', 'low', 10)).toBe(2400);
  });

  it('accumulates session tokens across a tier switch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00'));
    const d = emptyState();
    ops.startSession(d, { intent: '', plannedMin: 30, tier: 'sonnet', effort: 'medium' });
    vi.setSystemTime(new Date('2026-10-09T10:10:00'));
    ops.setTier(d, 'opus');
    vi.setSystemTime(new Date('2026-10-09T10:20:00'));
    expect(tokensToday(d)).toBe(8000 + 15000);
    const msg = ops.endSession(d, { fatigue: 3 });
    expect(msg).toContain('20 分钟');
    expect(msg).toContain('46,000'); // fatigue 3 (×2) chosen at the end prices both segments
    expect(d.fatigue.at(-1)?.level).toBe(3);
    vi.useRealTimers();
  });

  it('prices tokens by fatigue: ×1 / ×1.25 / ×2 / ×4 / ×8', () => {
    expect([null, 1, 2, 3, 4, 5].map(fatigueMult)).toEqual([1, 1, 1.25, 2, 4, 8]);
    expect(estimateTokens('sonnet', 'medium', 60, 5)).toBe(48_000 * 8);
  });

  it('uses the status-bar fatigue unless one is picked at the end, and freezes ended sessions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00'));
    const d = emptyState();
    ops.markFatigue(d, 2);
    const id = (ops.startSession(d, { intent: '', plannedMin: 30, tier: 'sonnet', effort: 'medium' }), d.sessions[0].runId!);
    vi.setSystemTime(new Date('2026-10-09T10:10:00'));
    expect(tokensToday(d)).toBe(10_000); // live: 8000 × 1.25
    expect(runSegmentsTokens(d, id)).toBe(10_000);
    expect(runSegmentsTokens(d, id, undefined, 5)).toBe(64_000); // preview at fatigue 5
    ops.markFatigue(d, 4); // status bar changed mid-session: the running session follows it
    expect(tokensToday(d)).toBe(32_000);
    ops.endSession(d, {}); // nothing picked → status-bar fatigue (4, ×4)
    expect(d.sessions[0].tokens).toBe(32_000);
    ops.markFatigue(d, 1); // later reports don't re-price what already ended
    vi.setSystemTime(new Date('2026-10-09T11:00:00'));
    expect(tokensToday(d)).toBe(32_000);
    vi.useRealTimers();
  });

  it('a session without any fatigue report counts ×1', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00'));
    const d = emptyState();
    ops.startSession(d, { intent: '', plannedMin: 30, tier: 'haiku', effort: 'medium' });
    vi.setSystemTime(new Date('2026-10-09T10:30:00'));
    ops.endSession(d, {});
    expect(d.sessions[0].tokens).toBe(12_000);
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
    expect(text).toMatch(/相对 v1/);
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

describe('migration', () => {
  it('maps legacy tier names to haiku/sonnet/opus', () => {
    const d = emptyState();
    const raw = JSON.parse(JSON.stringify({ ...d, hie: { tier: 'deep', effort: 'high' }, sessions: [{ id: 's', tier: 'lite', effort: 'low', startedAt: 0, endedAt: 1, plannedMin: 25, intent: '', wsId: null }] }));
    const n = normalize(raw);
    expect(n.hie.tier).toBe('opus');
    expect(n.sessions[0].tier).toBe('haiku');
    expect(n.sessions[0].runId).toBe('s');
  });
});

describe('execution log & plan diff', () => {
  it('records structured events, auto-baselines on first start, tags session runs', () => {
    const d = emptyState();
    ops.createPlan(d, 'P');
    const a = ops.addTask(d, 'a');
    ops.addTask(d, 'b');
    expect(d.plans[0].versions).toHaveLength(0);
    ops.startSession(d, { intent: 'x', plannedMin: 25, tier: 'sonnet', effort: 'medium' });
    ops.setTaskStatus(d, a.id, 'active');
    expect(d.plans[0].versions).toHaveLength(1);
    ops.setTaskStatus(d, a.id, 'done');
    const types = d.plans[0].log.map((e) => e.type);
    expect(types).toEqual(['create', 'add', 'add', 'session-start', 'commit', 'start', 'done']);
    const done = d.plans[0].log.at(-1)!;
    expect(done.runId).toBe(d.sessions[0].runId);
    expect(done.durMs).toBeGreaterThanOrEqual(0);
  });

  it('diffs baseline against reality and finds the first drift', () => {
    const d = emptyState();
    seedDemo(d);
    const p = d.plans[0];
    const pd = diffPlan(p)!;
    expect(pd.base.v).toBe(1);
    expect(pd.stats.added).toBe(1); // 确定字体与配色
    expect(pd.stats.removed).toBe(1); // 博客列表页设计
    expect(pd.stats.deferred).toBe(1); // 文章页排版
    expect(pd.stats.revisions).toBe(1);
    expect(pd.stats.late).toBeGreaterThanOrEqual(1); // 设计 past due
    expect(pd.firstDrift?.type).toBe('add');
    expect(pd.firstDriftPhase).toBe('设计');
    const lines = pd.phases.flatMap((ph) => ph.lines);
    expect(lines.some((l) => l.sign === '-' && l.text.includes('博客列表页设计'))).toBe(true);
    expect(lines.some((l) => l.sign === '+' && l.text.includes('确定字体与配色'))).toBe(true);
    expect(diffSummary(pd)).toMatch(/\+1 −1/);
  });

  it('defer moves a task to the next unfinished phase', () => {
    const d = emptyState();
    ops.createPlan(d, 'P');
    ops.addPhase(d, 'B');
    const t = ops.addTask(d, 'x');
    ops.deferTask(d, t.id, 'later');
    expect(d.plans[0].tasks[0].phaseId).toBe(d.plans[0].phases[1].id);
    expect(d.plans[0].log.at(-1)?.type).toBe('defer');
  });

  it('migrates legacy text logs', () => {
    const d = emptyState();
    const raw = JSON.parse(JSON.stringify(d));
    raw.plans = [{ id: 'p', kind: 'plan', title: 'P', objective: '', status: 'active', phases: [], tasks: [], log: [{ id: 'l', at: 1, kind: 'task', text: '+ a' }, { id: 'm', at: 2, kind: 'revise', text: 'r' }], createdAt: 0, updatedAt: 0 }];
    const n = normalize(raw);
    expect(n.plans[0].versions).toEqual([]);
    expect(n.plans[0].log.map((e) => e.type)).toEqual(['legacy', 'revise']);
  });
});

describe('workspace deletion', () => {
  it('deletes a plan with its compacts and is undoable through the store', () => {
    const { store, ctx } = mkCtx();
    execute('/plan A', ctx);
    execute('/goal B', ctx);
    const planId = store.get().plans[0].id;
    store.mutate('compact', (d) => ops.saveCompact(d, planId, 'snapshot'));
    store.mutate('删除', (d) => ops.deleteWs(d, planId));
    expect(store.get().plans).toHaveLength(0);
    expect(store.get().compacts).toHaveLength(0);
    expect(store.get().ui.activePlanId).toBeNull();
    expect(store.get().goals).toHaveLength(1);
    store.undo();
    expect(store.get().plans[0].id).toBe(planId);
  });
});
