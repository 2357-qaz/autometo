// A small, flat summary of "where am I" for surfaces outside the app: the iOS widget
// and the Live Activity of a running session. Pure, so it is computed the same way
// everywhere and can be tested; the native side only draws it.
import type { AppState, Effort, Task, Tier, Workspace } from './types';
import { activeSession, budgetLevel, latestFatigue, ratePerMin, runSegmentsTokens, runStartedAt, tokensToday, TIERS, type BudgetLevel } from './hie';
import { activeLanes, childrenOf, currentTask, laneCount, orderedTasks } from './ops';
import { currentWs } from './state';
import { startOfDay } from './util';

export interface GlanceTask {
  title: string;
  /** The number used by /done #n etc. */
  num: number;
}

export interface Glance {
  v: 1;
  /** When the snapshot was taken; `used` and `session.tokens` are as of then. */
  at: number;
  /** Start of that day: after it, today's usage starts again from 0. */
  day: number;
  budget: number;
  used: number;
  level: BudgetLevel;
  tier: Tier;
  tierLabel: string;
  effort: Effort;
  fatigue: number | null;
  /** Parallel subtasks in progress on this device (Fable), at least 1. */
  lanes: number;
  ws: { kind: 'plan' | 'goal'; title: string } | null;
  /** This device's task in progress, its steps and the steps running in parallel. */
  task: (GlanceTask & { steps: { done: number; total: number } | null; running: GlanceTask[] }) | null;
  /** What comes next (open subtasks of the current task first). */
  next: GlanceTask[];
  session: {
    runId: string;
    intent: string;
    startedAt: number;
    plannedEnd: number;
    tier: Tier;
    tierLabel: string;
    effort: Effort;
    lanes: number;
    /** Tokens per minute right now. */
    rate: number;
    tokens: number;
  } | null;
}

const finished = (t: Task) => t.status === 'done' || t.status === 'skipped';

function taskPart(ws: Workspace | undefined, state: AppState) {
  if (!ws) return { task: null, next: [] };
  const list = orderedTasks(ws);
  const ref = (t: Task): GlanceTask => ({ title: t.title, num: list.indexOf(t) + 1 });
  const cur = currentTask(ws, state);
  const kids = cur ? childrenOf(ws, cur.id) : [];
  const running = activeLanes(ws, state).filter((t) => t.parentId === cur?.id);
  const waiting = kids.filter((t) => t.status === 'pending' || t.status === 'blocked');
  const rest = list.filter((t) => t.status === 'pending' && t !== cur && !kids.includes(t));
  return {
    task: cur
      ? { ...ref(cur), steps: kids.length ? { done: kids.filter(finished).length, total: kids.length } : null, running: running.map(ref) }
      : null,
    next: [...waiting, ...rest].slice(0, 3).map(ref),
  };
}

export function glance(state: AppState, now = Date.now()): Glance {
  const used = tokensToday(state, now);
  const budget = state.settings.dailyBudget;
  const fatigue = latestFatigue(state, now);
  const ws = currentWs(state);
  const s = activeSession(state);
  const startedAt = s ? runStartedAt(state, s.runId) : 0;
  return {
    v: 1,
    at: now,
    day: startOfDay(now),
    budget,
    used,
    level: budgetLevel(used, budget),
    tier: state.hie.tier,
    tierLabel: TIERS[state.hie.tier].label,
    effort: state.hie.effort,
    fatigue,
    lanes: laneCount(state),
    ws: ws ? { kind: ws.kind, title: ws.title } : null,
    ...taskPart(ws, state),
    session: s
      ? {
          runId: s.runId,
          intent: s.intent,
          startedAt,
          plannedEnd: startedAt + s.plannedMin * 60_000,
          tier: s.tier,
          tierLabel: TIERS[s.tier].label,
          effort: s.effort,
          lanes: s.tier === 'fable' ? (s.lanes ?? 1) : 1,
          rate: Math.round(ratePerMin(s.tier, s.effort, fatigue, s.lanes)),
          tokens: runSegmentsTokens(state, s.runId, now),
        }
      : null,
  };
}
