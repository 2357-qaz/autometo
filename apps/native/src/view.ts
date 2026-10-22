// Everything the SwiftUI screens show, as one plain JSON-able object (decoded by
// AuTomeDo/ViewModel.swift). Built from the state on every change; the timeline reuses
// the terminal version's coloured lines (apps/tui/src/format.ts), drawn natively.
import {
  activeSession,
  budgetLevel,
  currentWs,
  fatigueMult,
  fmtAgo,
  hieAdvice,
  latestFatigue,
  onThisDevice,
  ops,
  otherSessions,
  ratePerMin,
  runSegmentsTokens,
  runStartedAt,
  tokensToday,
  TIERS,
  type AppState,
  type SyncStatus,
  type Task,
  type Workspace,
} from '@automedo/core';
import { historyBlocks, wsHeaderLines, type Line } from '../../tui/src/format';

export interface TaskView {
  id: string;
  num: number;
  title: string;
  status: Task['status'];
  note: string | null;
  phaseId: string | null;
  /** A subtask (indented under its parent). */
  sub: boolean;
  /** Steps of a split task. */
  steps: { done: number; total: number } | null;
  /** In progress on this device / on another one. */
  here: boolean;
  elsewhere: boolean;
}

export interface PhaseView {
  id: string;
  title: string;
  goal: string;
  status: 'pending' | 'active' | 'done';
  due: string | null;
  overdue: boolean;
}

export interface GoalView {
  why: string;
  doneWhen: string;
  nextAction: string;
  cadenceDays: number;
  checkpointDue: boolean;
  nextCheckpointAt: number;
  last: { progress: number; verdict: string; at: number; learned: string } | null;
}

export interface ViewModel {
  mode: 'plan' | 'goal';
  ws: {
    id: string;
    kind: 'plan' | 'goal';
    title: string;
    status: Workspace['status'];
    /** The terminal header's second line: phase, progress, drift against the plan. */
    meta: Line;
    phases: PhaseView[];
    goal: GoalView | null;
    tasks: TaskView[];
    /** Lanes of this device's split task in progress (Fable). */
    lanes: number;
  } | null;
  workspaces: { id: string; kind: 'plan' | 'goal'; title: string; status: Workspace['status']; active: boolean; detail: string }[];
  status: {
    tier: string;
    tierLabel: string;
    effort: string;
    lanes: number;
    used: number;
    budget: number;
    level: string;
    fatigue: number | null;
    fatigueMult: number;
    advice: string | null;
    sync: { text: string; tone: 'dim' | 'blue' | 'yellow' | 'red' };
  };
  session: { runId: string; intent: string; startedAt: number; plannedMin: number; tier: string; tierLabel: string; effort: string; lanes: number; tokens: number; rate: number } | null;
  otherSessions: { intent: string; startedAt: number; plannedMin: number }[];
  timeline: { key: string; lines: Line[] }[];
  /** A snapshot left for this plan/goal earlier: offer to resume from it. */
  resume: { compactId: string; ago: string } | null;
  canUndo: boolean;
}

const LANES_TIER = 'fable';

function syncLine(st: SyncStatus): ViewModel['status']['sync'] {
  if (st.phase === 'off') return { text: '本地', tone: 'dim' };
  if (st.phase === 'syncing') return { text: '⟳ 同步中', tone: 'blue' };
  if (st.phase === 'offline') return { text: '⚠ 离线', tone: 'yellow' };
  if (st.confirm) return { text: '⏸ 同步暂停：大量删除待确认（/sync）', tone: 'yellow' };
  if (st.conflicts.length) return { text: `⚠ ${st.conflicts.length} 处同时编辑已合并（/sync 查看）`, tone: 'yellow' };
  if (st.phase === 'error') return { text: `✗ ${st.error ?? '同步失败'}`, tone: 'red' };
  return { text: `✓ 已同步${st.lastSyncAt ? ` ${fmtAgo(st.lastSyncAt)}` : ''}`, tone: 'dim' };
}

function tasksOf(ws: Workspace, state: AppState): TaskView[] {
  const list = ops.orderedTasks(ws);
  return list.map((t, i) => {
    const sub = !!ops.parentOf(ws, t);
    const kids = sub ? [] : ops.childrenOf(ws, t.id);
    const active = t.status === 'active';
    const here = active && onThisDevice(t.activeBy, state);
    return {
      id: t.id,
      num: i + 1,
      title: t.title,
      status: t.status,
      note: t.note ?? null,
      phaseId: t.phaseId,
      sub,
      steps: kids.length ? { done: kids.filter((k) => k.status === 'done' || k.status === 'skipped').length, total: kids.length } : null,
      here,
      elsewhere: active && !here,
    };
  });
}

/** The last snapshot of this workspace taken before the app was opened, unless dismissed. */
function resumable(state: AppState, ws: Workspace, openedAt: number) {
  const c = [...state.compacts].reverse().find((x) => x.wsId === ws.id && x.at < openedAt && x.id !== state.ui.dismissedCompactId);
  return c ? { compactId: c.id, ago: fmtAgo(c.at) } : null;
}

export function buildView(state: AppState, sync: SyncStatus, opts: { openedAt: number; canUndo: boolean }, now = Date.now()): ViewModel {
  const ws = currentWs(state);
  const used = tokensToday(state, now);
  const budget = state.settings.dailyBudget;
  const fatigue = latestFatigue(state, now);
  const s = activeSession(state);
  const lanes = ops.laneCount(state);
  const all: Workspace[] = [...state.plans, ...state.goals];
  return {
    mode: state.ui.mode,
    ws: ws
      ? {
          id: ws.id,
          kind: ws.kind,
          title: ws.title,
          status: ws.status,
          meta: wsHeaderLines(ws)[1] ?? [],
          phases:
            ws.kind === 'plan'
              ? ws.phases.map((p) => ({ id: p.id, title: p.title, goal: p.goal, status: p.status, due: p.due ?? null, overdue: !!p.due && p.status !== 'done' && now > ops.dueAt(p.due) }))
              : [],
          goal:
            ws.kind === 'goal'
              ? (() => {
                  const last = ws.checkpoints[ws.checkpoints.length - 1];
                  return {
                    why: ws.why,
                    doneWhen: ws.doneWhen,
                    nextAction: ws.nextAction,
                    cadenceDays: ws.cadenceDays,
                    checkpointDue: ops.checkpointDue(ws, now),
                    nextCheckpointAt: ops.nextCheckpointAt(ws),
                    last: last ? { progress: last.progress, verdict: last.verdict, at: last.at, learned: last.learned } : null,
                  };
                })()
              : null,
          tasks: tasksOf(ws, state),
          lanes: ops.activeLanes(ws, state).length,
        }
      : null,
    workspaces: all.map((w) => {
      const tasks = ops.taskList(w);
      const done = tasks.filter((t) => t.status === 'done').length;
      const last = w.kind === 'goal' ? w.checkpoints[w.checkpoints.length - 1] : undefined;
      return {
        id: w.id,
        kind: w.kind,
        title: w.title,
        status: w.status,
        active: w.id === ws?.id,
        detail: w.kind === 'plan' ? `${done}/${tasks.filter((t) => t.status !== 'skipped').length}` : last ? `${last.progress}%` : `${done} 个行动`,
      };
    }),
    status: {
      tier: state.hie.tier,
      tierLabel: TIERS[state.hie.tier].label,
      effort: state.hie.effort,
      lanes: state.hie.tier === LANES_TIER ? lanes : 1,
      used,
      budget,
      level: budgetLevel(used, budget),
      fatigue,
      fatigueMult: fatigueMult(fatigue),
      advice: ws ? hieAdvice(used, budget, fatigue) : null,
      sync: syncLine(sync),
    },
    session: s
      ? {
          runId: s.runId,
          intent: s.intent,
          startedAt: runStartedAt(state, s.runId),
          plannedMin: s.plannedMin,
          tier: s.tier,
          tierLabel: TIERS[s.tier].label,
          effort: s.effort,
          lanes: s.tier === LANES_TIER ? (s.lanes ?? 1) : 1,
          tokens: runSegmentsTokens(state, s.runId, now),
          rate: Math.round(ratePerMin(s.tier, s.effort, fatigue, s.lanes)),
        }
      : null,
    otherSessions: otherSessions(state).map((o) => ({ intent: o.intent, startedAt: runStartedAt(state, o.runId), plannedMin: o.plannedMin })),
    timeline: ws ? historyBlocks(ws, state.sessions, 60) : [],
    resume: ws ? resumable(state, ws, opts.openedAt) : null,
    canUndo: opts.canUndo,
  };
}
