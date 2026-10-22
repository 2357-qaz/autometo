// Pure domain operations. Each mutates a draft AppState and returns a short
// human-readable result line. User errors are thrown as UserError.
// Every meaningful change emits a structured event into the workspace's Execution Log.
import type { AppState, Checkpoint, DiffLine, Effort, Goal, LogEntry, Plan, PlanVersion, Session, Task, TaskStatus, Tier, Workspace } from './types';
import { activeSession, fatigueMult, focusedMsBetween, latestFatigue, onThisDevice, otherSessions, sessionTokens, tokensBetween, TIERS } from './hie';
import { activeGoal, activePlan, currentWs, findWs } from './state';
import { DAY, uid } from './util';

export class UserError extends Error {}

/**
 * Fable works on split tasks: thrown when a task has to be split into subtasks first.
 * The client asks the split questions, then reruns the operation that was refused.
 */
export class SplitRequired extends UserError {
  constructor(readonly taskId: string, title: string) {
    super(`Fable 档要先把「${title}」拆成子任务`);
  }
}
const fail = (msg: string): never => {
  throw new UserError(msg);
};

const LOG_LIMIT = 2000;

/** Append an event to a workspace log, tagging it with the running focus session. */
export function emit(d: AppState, ws: Workspace, ev: Omit<LogEntry, 'id' | 'at'> & { at?: number }): LogEntry {
  const s = activeSession(d);
  // Strictly increasing per workspace, so order survives sync (which sorts by time).
  const prev = ws.log[ws.log.length - 1]?.at ?? 0;
  const e: LogEntry = { id: uid(), ...ev, at: Math.max(ev.at ?? Date.now(), prev + 1), runId: ev.runId ?? (s && s.wsId === ws.id ? s.runId : undefined) };
  ws.log.push(e);
  if (ws.log.length > LOG_LIMIT) ws.log.splice(0, ws.log.length - LOG_LIMIT);
  ws.updatedAt = e.at;
  return e;
}

// ───────────────────────── workspaces ─────────────────────────

export function createPlan(d: AppState, title: string, objective = ''): Plan {
  const now = Date.now();
  const t = title.trim() || fail('Plan 需要一个标题');
  const p: Plan = {
    id: uid(),
    kind: 'plan',
    title: t,
    objective: objective.trim(),
    status: 'active',
    phases: [{ id: uid(), title: 'Phase 1', goal: '', status: 'active' }],
    tasks: [],
    versions: [],
    log: [],
    createdAt: now,
    updatedAt: now,
  };
  d.plans.unshift(p);
  emit(d, p, { type: 'create', text: `创建计划「${t}」`, title: t });
  d.ui.mode = 'plan';
  d.ui.activePlanId = p.id;
  return p;
}

export function createGoal(d: AppState, title: string, opts: Partial<Pick<Goal, 'why' | 'doneWhen' | 'cadenceDays' | 'nextAction'>> = {}): Goal {
  const now = Date.now();
  const t = title.trim() || fail('Goal 需要一个标题');
  const g: Goal = {
    id: uid(),
    kind: 'goal',
    title: t,
    why: opts.why?.trim() ?? '',
    doneWhen: opts.doneWhen?.trim() ?? '',
    cadenceDays: opts.cadenceDays && opts.cadenceDays > 0 ? opts.cadenceDays : 7,
    nextAction: opts.nextAction?.trim() ?? '',
    moves: [],
    checkpoints: [],
    status: 'active',
    log: [],
    createdAt: now,
    updatedAt: now,
  };
  d.goals.unshift(g);
  emit(d, g, { type: 'create', text: `设定目标「${t}」`, title: t });
  d.ui.mode = 'goal';
  d.ui.activeGoalId = g.id;
  return g;
}

export function selectWs(d: AppState, id: string) {
  const ws = findWs(d, id) ?? fail('找不到该 Plan/Goal');
  if (ws.kind === 'plan') {
    d.ui.mode = 'plan';
    d.ui.activePlanId = ws.id;
  } else {
    d.ui.mode = 'goal';
    d.ui.activeGoalId = ws.id;
  }
}

export function deleteWs(d: AppState, id: string): string {
  const ws = findWs(d, id) ?? fail('找不到该 Plan/Goal');
  d.plans = d.plans.filter((p) => p.id !== id);
  d.goals = d.goals.filter((g) => g.id !== id);
  d.compacts = d.compacts.filter((c) => c.wsId !== id);
  if (d.ui.activePlanId === id) d.ui.activePlanId = d.plans[0]?.id ?? null;
  if (d.ui.activeGoalId === id) d.ui.activeGoalId = d.goals[0]?.id ?? null;
  return `已删除「${ws.title}」`;
}

export function renameWs(d: AppState, id: string, title: string): string {
  const ws = findWs(d, id) ?? fail('找不到该 Plan/Goal');
  const t = title.trim() || fail('标题不能为空');
  if (t === ws.title) return '标题未变化';
  emit(d, ws, { type: 'edit', text: `重命名：「${ws.title}」→「${t}」`, diff: [{ sign: '~', text: `标题  ${ws.title} → ${t}` }] });
  ws.title = t;
  return `已重命名为「${t}」`;
}

export function setWsStatus(d: AppState, id: string, status: Workspace['status']): string {
  const ws = findWs(d, id) ?? fail('找不到该 Plan/Goal');
  ws.status = status;
  emit(d, ws, { type: 'note', text: `状态 → ${status}` });
  return `「${ws.title}」状态 → ${status}`;
}

export function requirePlan(d: AppState): Plan {
  return activePlan(d) ?? fail('当前没有 Plan。用 /plan <标题> 新建一个');
}
export function requireGoal(d: AppState): Goal {
  return activeGoal(d) ?? fail('当前没有 Goal。用 /goal <标题> 新建一个');
}
export function requireWs(d: AppState): Workspace {
  return currentWs(d) ?? fail('当前没有打开的 Plan/Goal');
}
export function requireWsSafe(d: AppState): Workspace | undefined {
  return currentWs(d);
}

export function addNote(d: AppState, text: string): string {
  const ws = requireWs(d);
  const t = text.trim() || fail('记录内容为空');
  emit(d, ws, { type: 'note', text: t });
  return `已记录到「${ws.title}」`;
}

// ───────────────────────── plan versions ─────────────────────────

export function snapshot(p: Plan, v: number, message: string, at = Date.now()): PlanVersion {
  return {
    v,
    at,
    message,
    phases: p.phases.map(({ id, title, goal, due }) => ({ id, title, goal, due })),
    tasks: p.tasks.filter((t) => t.status !== 'skipped').map(({ id, title, phaseId }) => ({ id, title, phaseId })),
  };
}

export function baseline(p: Plan): PlanVersion | undefined {
  return p.versions[0];
}

function pushVersion(p: Plan, message: string): PlanVersion {
  const ver = { id: uid(), ...snapshot(p, (p.versions[p.versions.length - 1]?.v ?? 0) + 1, message) };
  p.versions.push(ver);
  return ver;
}

/** Manual /commit, or the automatic v1 baseline on first start. */
export function commitPlan(d: AppState, message: string, auto = false): string {
  const p = requirePlan(d);
  const m = message.trim() || (auto ? '基准：首次开始执行' : '手动提交');
  const ver = pushVersion(p, m);
  emit(d, p, { type: 'commit', version: ver.v, text: `Commit v${ver.v} · ${m}`, detail: m });
  return `已提交计划版本 v${ver.v}`;
}

// ───────────────────────── plan: phases ─────────────────────────

export function currentPhase(p: Plan) {
  return p.phases.find((ph) => ph.status === 'active') ?? p.phases.find((ph) => ph.status === 'pending') ?? p.phases[p.phases.length - 1];
}

export function addPhase(d: AppState, title: string, goal = ''): string {
  const p = requirePlan(d);
  const t = title.trim() || `Phase ${p.phases.length + 1}`;
  const hasActive = p.phases.some((ph) => ph.status === 'active');
  const ph = { id: uid(), title: t, goal: goal.trim(), status: hasActive ? ('pending' as const) : ('active' as const) };
  p.phases.push(ph);
  emit(d, p, { type: 'phase-add', phaseId: ph.id, title: t, text: `新增阶段「${t}」`, diff: [{ sign: '+', text: `## ${t}`, note: ph.goal || undefined }] });
  return `新增阶段「${t}」`;
}

export function updatePhase(d: AppState, phaseId: string, patch: { title?: string; goal?: string; due?: string | null }): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  const diff: DiffLine[] = [];
  if (patch.title != null && patch.title.trim() && patch.title.trim() !== ph.title) {
    diff.push({ sign: '~', text: `阶段  ${ph.title} → ${patch.title.trim()}` });
    ph.title = patch.title.trim();
  }
  if (patch.goal != null && patch.goal.trim() !== ph.goal) {
    diff.push({ sign: '~', text: `「${ph.title}」目标  ${ph.goal || '（无）'} → ${patch.goal.trim() || '（无）'}` });
    ph.goal = patch.goal.trim();
  }
  if (patch.due !== undefined) {
    const due = parseDue(patch.due);
    if ((due ?? '') !== (ph.due ?? '')) {
      diff.push({ sign: '~', text: `「${ph.title}」目标日期  ${ph.due ?? '（无）'} → ${due ?? '（无）'}` });
      if (due) ph.due = due;
      else delete ph.due;
    }
  }
  if (!diff.length) return '没有变化';
  emit(d, p, { type: 'edit', phaseId, title: ph.title, text: diff.map((l) => l.text).join('；'), diff });
  return `已更新阶段「${ph.title}」`;
}

/** Accepts YYYY-MM-DD, MM-DD, +Nd, or empty (clear). */
export function parseDue(v: string | null | undefined, now = Date.now()): string | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  let m = s.match(/^\+(\d{1,3})d?$/);
  if (m) return fmt(new Date(now + Number(m[1]) * DAY));
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return `${new Date(now).getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`;
  return fail('日期格式：YYYY-MM-DD、MM-DD 或 +3d');
}

/** End of the due day, local time. */
export function dueAt(due: string): number {
  const [y, m, dd] = due.split('-').map(Number);
  return new Date(y, m - 1, dd, 23, 59, 59).getTime();
}

export function revisePhase(d: AppState, phaseId: string, newGoal: string, reason: string): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  const g = newGoal.trim() || fail('修正后的阶段目标不能为空');
  const r = reason.trim() || fail('请写下修正原因——这是复盘最有价值的部分');
  const old = ph.goal || '（未设定）';
  // The baseline must capture the plan BEFORE the revision.
  if (!p.versions.length) pushVersion(p, '基准（修正前）');
  ph.goal = g;
  const before = p.versions[p.versions.length - 1].v;
  const ver = pushVersion(p, r);
  emit(d, p, {
    type: 'revise',
    phaseId,
    title: ph.title,
    reason: r,
    version: ver.v,
    detail: `v${before} → v${ver.v}`,
    text: `修正「${ph.title}」目标：${old} → ${g}｜原因：${r}`,
    diff: [
      { sign: '-', text: `目标  ${old}` },
      { sign: '+', text: `目标  ${g}` },
    ],
  });
  return `已修正阶段「${ph.title}」· 计划版本 v${ver.v}`;
}

export function completePhase(d: AppState, phaseId: string): string {
  const p = requirePlan(d);
  const idx = p.phases.findIndex((x) => x.id === phaseId);
  if (idx < 0) fail('找不到阶段');
  const ph = p.phases[idx];
  ph.status = 'done';
  ph.doneAt = Date.now();
  const next = p.phases.slice(idx + 1).find((x) => x.status === 'pending');
  if (next && !p.phases.some((x) => x.status === 'active')) next.status = 'active';
  const late = ph.due && ph.doneAt > dueAt(ph.due) ? Math.ceil((ph.doneAt - dueAt(ph.due)) / DAY) : 0;
  emit(d, p, {
    type: 'phase',
    phaseId,
    title: ph.title,
    text: `完成阶段「${ph.title}」${next ? `，进入「${next.title}」` : ''}`,
    detail: `完成${ph.due ? ` · 目标 ${ph.due.slice(5)}${late ? ` · 晚 ${late} 天` : ' · 按时'}` : ''}${next ? ` · 进入「${next.title}」` : ''}`,
  });
  return `阶段「${ph.title}」完成${next ? ` → 进入「${next.title}」` : ''}`;
}

export function activatePhase(d: AppState, phaseId: string): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  for (const x of p.phases) if (x.status === 'active') x.status = 'pending';
  ph.status = 'active';
  delete ph.doneAt;
  emit(d, p, { type: 'phase', phaseId, title: ph.title, text: `切换到阶段「${ph.title}」`, detail: '设为当前阶段' });
  return `当前阶段 → 「${ph.title}」`;
}

export function movePhase(d: AppState, phaseId: string, dir: -1 | 1) {
  const p = requirePlan(d);
  const i = p.phases.findIndex((x) => x.id === phaseId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.phases.length) return;
  [p.phases[i], p.phases[j]] = [p.phases[j], p.phases[i]];
  p.updatedAt = Date.now();
}

export function deletePhase(d: AppState, phaseId: string): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  const gone = p.tasks.filter((t) => t.phaseId === phaseId);
  p.tasks = p.tasks.filter((t) => t.phaseId !== phaseId);
  p.phases = p.phases.filter((x) => x.id !== phaseId);
  if (ph.status === 'active') {
    const nx = p.phases.find((x) => x.status === 'pending');
    if (nx) nx.status = 'active';
  }
  emit(d, p, {
    type: 'remove',
    phaseId,
    title: ph.title,
    text: `删除阶段「${ph.title}」（含 ${gone.length} 个任务）`,
    diff: [{ sign: '-', text: `## ${ph.title}` }, ...gone.map((t) => ({ sign: '-' as const, text: `☐ ${t.title}` }))],
  });
  return `已删除阶段「${ph.title}」`;
}

// ───────────────────────── tasks (plan tasks & goal moves) ─────────────────────────

/** Ordered task list used for numbering (#1, #2…) in the current workspace. Subtasks follow their parent. */
export function orderedTasks(ws: Workspace): Task[] {
  const list = taskList(ws);
  const byId = new Map(list.map((t) => [t.id, t]));
  // A subtask whose parent is gone (deleted on another device) or is itself a subtask stands on its own.
  const isTop = (t: Task) => !t.parentId || !byId.has(t.parentId) || !!byId.get(t.parentId)!.parentId;
  const kids = new Map<string, Task[]>();
  for (const t of list) if (!isTop(t)) kids.set(t.parentId!, [...(kids.get(t.parentId!) ?? []), t]);
  let roots = list.filter(isTop);
  if (ws.kind === 'plan') {
    const inPhase = (id: string | null) => roots.filter((t) => t.phaseId === id);
    roots = [...ws.phases.flatMap((ph) => inPhase(ph.id)), ...roots.filter((t) => !ws.phases.some((ph) => ph.id === t.phaseId))];
  }
  return roots.flatMap((t) => [t, ...(kids.get(t.id) ?? [])]);
}

/** Subtasks of a task, in order. */
export function childrenOf(ws: Workspace, taskId: string): Task[] {
  return orderedTasks(ws).filter((t) => t.parentId === taskId);
}

/** The task a subtask was split from (undefined for top-level tasks and orphans). */
export function parentOf(ws: Workspace, t: Task): Task | undefined {
  return t.parentId ? taskList(ws).find((x) => x.id === t.parentId && !x.parentId) : undefined;
}

/** Whether Fable must split this task before it can start: a top-level task without subtasks. */
export function needsSplit(ws: Workspace, t: Task): boolean {
  return !parentOf(ws, t) && !childrenOf(ws, t.id).length;
}

/** This device's subtasks in progress: the parallel lanes of the split tasks it works on. */
export function activeLanes(ws: Workspace, state: Pick<AppState, 'ui'>): Task[] {
  return orderedTasks(ws).filter((t) => t.status === 'active' && !!parentOf(ws, t) && onThisDevice(t.activeBy, state));
}

/** Parallel lanes on this device across all plans and goals (at least 1). */
export function laneCount(d: AppState): number {
  return Math.max(1, [...d.plans, ...d.goals].reduce((n, ws) => n + activeLanes(ws, d).length, 0));
}

/**
 * The task THIS device is working on. Several devices can each have one in progress
 * (parallel sessions); without `state`, the first one in progress anywhere.
 */
export function currentTask(ws: Workspace, state?: Pick<AppState, 'ui'>): Task | undefined {
  return orderedTasks(ws).find((t) => t.status === 'active' && (!state || onThisDevice(t.activeBy, state)));
}

/** Tasks in progress on other devices. */
export function otherActiveTasks(ws: Workspace, state: Pick<AppState, 'ui'>): Task[] {
  return orderedTasks(ws).filter((t) => t.status === 'active' && !onThisDevice(t.activeBy, state));
}

export function taskList(ws: Workspace): Task[] {
  return ws.kind === 'plan' ? ws.tasks : ws.moves;
}

const numOf = (ws: Workspace, id: string) => orderedTasks(ws).findIndex((t) => t.id === id) + 1;

export function resolveTask(ws: Workspace, ref: string | undefined, state?: Pick<AppState, 'ui'>): Task {
  const list = orderedTasks(ws);
  if (!ref || !ref.trim()) {
    const lanes = state ? activeLanes(ws, state) : [];
    if (lanes.length > 1) fail(`正在并行推进 ${lanes.length} 路（${lanes.map((t) => `#${numOf(ws, t.id)}`).join(' ')}），请指定编号，例如 /done ${numOf(ws, lanes[0].id)}`);
    if (lanes.length === 1) return lanes[0];
    const cur = currentTask(ws, state);
    if (cur) return cur;
    const other = state ? otherActiveTasks(ws, state)[0] : undefined;
    return fail(other ? `这台设备上没有进行中的任务（另一台设备在做「${other.title}」#${numOf(ws, other.id)}），请指定编号` : '没有进行中的任务，请指定编号，例如 /done 2');
  }
  const r = ref.trim().replace(/^#/, '');
  const n = Number(r);
  if (Number.isInteger(n)) return list[n - 1] ?? fail(`没有编号为 #${n} 的任务`);
  return list.find((t) => t.id === r) ?? list.find((t) => t.title.includes(r)) ?? fail(`找不到任务「${r}」`);
}

export function addTask(d: AppState, title: string, phaseId?: string | null): Task {
  const ws = requireWs(d);
  const t = title.trim() || fail('任务内容为空');
  let pid: string | null = null;
  if (ws.kind === 'plan') {
    pid = phaseId ?? currentPhase(ws)?.id ?? null;
    if (!pid) {
      const ph = { id: uid(), title: 'Phase 1', goal: '', status: 'active' as const };
      ws.phases.push(ph);
      pid = ph.id;
    }
  }
  const task: Task = { id: uid(), title: t, status: 'pending', phaseId: pid, createdAt: Date.now() };
  taskList(ws).push(task);
  const ph = ws.kind === 'plan' ? ws.phases.find((x) => x.id === pid) : undefined;
  emit(d, ws, {
    type: 'add',
    taskId: task.id,
    title: t,
    phaseId: pid ?? undefined,
    text: `+ ${t}`,
    diff: [{ sign: '+', num: numOf(ws, task.id), text: `☐ ${t}`, note: ph ? ph.title : undefined }],
  });
  return task;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待办',
  active: '进行中',
  done: '完成',
  blocked: '阻塞',
  skipped: '跳过',
};

function lastStartAt(ws: Workspace, taskId: string): number | undefined {
  for (let i = ws.log.length - 1; i >= 0; i--) {
    const e = ws.log[i];
    if (e.taskId === taskId && e.type === 'start') return e.at;
  }
  return undefined;
}

export function setTaskStatus(d: AppState, taskId: string, status: TaskStatus, note?: string): string {
  const ws = requireWs(d);
  const list = taskList(ws);
  const task = list.find((t) => t.id === taskId) ?? fail('找不到任务');
  const from = task.status;
  if (from === status) return `${STATUS_LABEL[status]}：${task.title}（未变化）`;
  const parent = parentOf(ws, task);
  const pre: string[] = [];
  const post: string[] = [];
  if (status === 'active') {
    if (d.hie.tier === 'fable' && needsSplit(ws, task)) throw new SplitRequired(task.id, task.title);
    // A subtask runs inside its parent: starting it starts the parent too.
    if (parent && parent.status !== 'active') pre.push(setTaskStatus(d, parent.id, 'active'));
    // First execution freezes the plan as baseline v1 — the reference for Plan Diff.
    if (ws.kind === 'plan' && !ws.versions.length) commitPlan(d, '', true);
    // One task in progress per device, like a focused agent — Fable runs the subtasks of
    // one split task in parallel; elsewhere a split task runs one subtask at a time.
    // Another device's task in progress is that device's business (parallel sessions).
    const root = parent ?? task;
    const keep = (t: Task) => t.id === root.id || (t.parentId === root.id && (d.hie.tier === 'fable' || !parent));
    for (const t of list) {
      if (t.status === 'active' && t.id !== taskId && onThisDevice(t.activeBy, d) && !keep(t)) {
        t.status = 'pending';
        delete t.activeBy;
      }
    }
    if (ws.kind === 'plan' && task.phaseId) {
      const ph = ws.phases.find((x) => x.id === task.phaseId);
      if (ph && ph.status === 'pending') {
        for (const x of ws.phases) if (x.status === 'active') x.status = 'pending';
        ph.status = 'active';
      }
    }
  }
  task.status = status;
  if (status === 'active' && d.ui.deviceId) task.activeBy = d.ui.deviceId;
  else delete task.activeBy;
  if (status !== 'active' && !parent) {
    // The subtasks being worked on stop with their parent (and say so).
    const stopped = childrenOf(ws, taskId).filter((t) => t.status === 'active' && onThisDevice(t.activeBy, d));
    for (const t of stopped) {
      t.status = 'pending';
      delete t.activeBy;
    }
    if (stopped.length) post.push(`子任务已暂停：${stopped.map((t) => t.title).join('、')}`);
  }
  const now = Date.now();
  if (status === 'done') task.doneAt = now;
  else delete task.doneAt;
  const reason = note?.trim() || undefined;
  if (reason) task.note = reason;

  const type =
    status === 'active' ? 'start'
    : status === 'done' ? 'done'
    : status === 'blocked' ? 'block'
    : status === 'skipped' ? 'skip'
    : from === 'done' ? 'reopen'
    : from === 'blocked' ? 'unblock'
    : 'pause';
  const ph = ws.kind === 'plan' ? ws.phases.find((x) => x.id === task.phaseId) : undefined;
  let durMs: number | undefined;
  let tokens: number | undefined;
  if (status === 'done') {
    const st = lastStartAt(ws, taskId);
    if (st != null && from === 'active') {
      // Prefer focused (in-session) time; fall back to wall clock only for short same-sitting work.
      const focused = focusedMsBetween(d, st, now);
      const wall = Math.max(0, now - st);
      durMs = focused > 0 ? focused : wall < 4 * 3_600_000 ? wall : undefined;
      tokens = tokensBetween(d, st, now) || undefined;
    }
  }
  emit(d, ws, {
    type,
    taskId,
    title: task.title,
    phaseId: task.phaseId ?? undefined,
    reason,
    durMs,
    tokens,
    detail: type === 'start' && from === 'blocked' ? '解除阻塞后继续' : type === 'start' && ph ? `${ph.title} · #${numOf(ws, taskId)}` : undefined,
    text: `${STATUS_LABEL[status]}：${task.title}${reason ? `（${reason}）` : ''}`,
    diff: type === 'skip' ? [{ sign: '-', num: numOf(ws, taskId), text: `☐ ${task.title}`, note: '跳过' }] : undefined,
  });
  let msg = `${STATUS_LABEL[status]}：${task.title}`;
  const open = (t: Task) => t.status === 'pending' || t.status === 'active' || t.status === 'blocked';
  if (parent && (status === 'done' || status === 'skipped') && parent.status !== 'done' && !childrenOf(ws, parent.id).some(open)) {
    msg += `　·　「${parent.title}」的子任务都结束了，可 /done ${numOf(ws, parent.id)} 完成它`;
  }
  if (ws.kind === 'plan' && status === 'done' && task.phaseId) {
    const rest = ws.tasks.filter((t) => t.phaseId === task.phaseId && open(t));
    if (ph && ph.status !== 'done' && rest.length === 0) msg += `　·　阶段「${ph.title}」任务已清空，可 /phase done 结束本阶段`;
  }
  syncLanes(d);
  return [...pre, [msg, ...post].join('　·　')].join('　→　');
}

export function cycleTask(d: AppState, taskId: string): string {
  const ws = requireWs(d);
  const t = taskList(ws).find((x) => x.id === taskId) ?? fail('找不到任务');
  const next: TaskStatus = t.status === 'pending' ? 'active' : t.status === 'active' ? 'done' : 'pending';
  return setTaskStatus(d, taskId, next);
}

/** Complete the in-progress task (if any) and start the next pending one. */
export function nextTask(d: AppState): string {
  const ws = requireWs(d);
  const lanes = activeLanes(ws, d);
  if (lanes.length > 1) fail(`正在并行推进 ${lanes.length} 路：用 /done #n 完成其中一路`);
  const cur = lanes[0] ?? currentTask(ws, d);
  const parts: string[] = [];
  const kids = cur ? childrenOf(ws, cur.id) : [];
  if (cur && kids.some((t) => t.status !== 'done' && t.status !== 'skipped')) {
    // A split task is done through its subtasks: go on with the next one.
    const k = kids.find((t) => t.status === 'pending') ?? fail(`「${cur.title}」还有子任务没结束`);
    return setTaskStatus(d, k.id, 'active');
  }
  if (cur) parts.push(setTaskStatus(d, cur.id, 'done'));
  // Prefer the next subtask of the same parent; never reopen a finished parent for a leftover subtask.
  const all = orderedTasks(requireWs(d));
  const nx =
    (cur?.parentId && all.find((t) => t.status === 'pending' && t.parentId === cur.parentId)) ||
    all.find((t) => t.status === 'pending' && !(t.parentId && all.find((p) => p.id === t.parentId)?.status === 'done'));
  if (nx) parts.push(setTaskStatus(d, nx.id, 'active'));
  else parts.push('没有更多待办任务 ✓');
  return parts.join('　→　');
}

/** Push a task later: next unfinished phase (plan) or end of list (goal). */
export function deferTask(d: AppState, taskId: string, reason = ''): string {
  const ws = requireWs(d);
  const list = taskList(ws);
  const i = list.findIndex((x) => x.id === taskId);
  if (i < 0) fail('找不到任务');
  const t = list[i];
  if (t.status === 'done') fail('已完成的任务不能延期');
  const r = reason.trim() || undefined;
  const parent = parentOf(ws, t);
  let detail = parent ? `移到「${parent.title}」的最后` : '移到列表末尾';
  const kids = parent ? [] : childrenOf(ws, t.id);
  if (ws.kind === 'plan' && !parent) {
    const pi = ws.phases.findIndex((x) => x.id === t.phaseId);
    const target = ws.phases.slice(pi + 1).find((x) => x.status !== 'done');
    const from = ws.phases[pi];
    if (target) {
      t.phaseId = target.id;
      for (const k of kids) k.phaseId = target.id; // subtasks go along
      detail = `${from?.title ?? '?'} → ${target.title}`;
    }
  }
  list.splice(i, 1);
  list.push(t);
  if (t.status === 'active') {
    for (const k of kids) {
      if (k.status === 'active' && onThisDevice(k.activeBy, d)) {
        k.status = 'pending';
        delete k.activeBy;
      }
    }
  }
  t.status = 'pending';
  delete t.activeBy;
  if (r) t.note = r;
  emit(d, ws, {
    type: 'defer',
    taskId,
    title: t.title,
    phaseId: t.phaseId ?? undefined,
    reason: r,
    detail,
    text: `延期：${t.title}（${detail}${r ? `；${r}` : ''}）`,
    diff: [{ sign: '~', num: numOf(ws, taskId), text: `☐ ${t.title}`, note: detail }],
  });
  return `已延期：${t.title}（${detail}）`;
}

export function updateTask(d: AppState, taskId: string, patch: { title?: string; note?: string; phaseId?: string | null }): string {
  const ws = requireWs(d);
  const t = taskList(ws).find((x) => x.id === taskId) ?? fail('找不到任务');
  const diff: DiffLine[] = [];
  if (patch.title != null && patch.title.trim() && patch.title.trim() !== t.title) {
    diff.push({ sign: '-', num: numOf(ws, taskId), text: `☐ ${t.title}` }, { sign: '+', num: numOf(ws, taskId), text: `☐ ${patch.title.trim()}` });
    t.title = patch.title.trim();
  }
  if (patch.note != null) t.note = patch.note.trim() || undefined;
  if (patch.phaseId !== undefined && ws.kind === 'plan' && patch.phaseId !== t.phaseId) {
    const a = ws.phases.find((x) => x.id === t.phaseId)?.title ?? '?';
    const b = ws.phases.find((x) => x.id === patch.phaseId)?.title ?? '?';
    t.phaseId = patch.phaseId;
    for (const k of childrenOf(ws, taskId)) k.phaseId = patch.phaseId; // subtasks go along
    diff.push({ sign: '~', num: numOf(ws, taskId), text: `☐ ${t.title}`, note: `${a} → ${b}` });
  }
  if (diff.length) emit(d, ws, { type: 'edit', taskId, title: t.title, text: `修改任务：${t.title}`, diff });
  else ws.updatedAt = Date.now();
  return `已更新：${t.title}`;
}

export function deleteTask(d: AppState, taskId: string): string {
  const ws = requireWs(d);
  const list = taskList(ws);
  const i = list.findIndex((x) => x.id === taskId);
  if (i < 0) fail('找不到任务');
  const n = numOf(ws, taskId);
  // A split task goes together with its subtasks.
  const kids = childrenOf(ws, taskId).map((k) => ({ k, n: numOf(ws, k.id) }));
  const [t] = list.splice(i, 1);
  for (const { k } of kids) list.splice(list.indexOf(k), 1);
  emit(d, ws, {
    type: 'remove',
    taskId,
    title: t.title,
    text: `- ${t.title}${kids.length ? `（连同 ${kids.length} 个子任务）` : ''}`,
    diff: [{ sign: '-', num: n, text: `☐ ${t.title}` }, ...kids.map(({ k, n }) => ({ sign: '-' as const, num: n, text: `☐ ${k.title}`, note: `↳ ${t.title}` }))],
  });
  syncLanes(d);
  return `已删除：${t.title}${kids.length ? `（连同 ${kids.length} 个子任务）` : ''}`;
}

export function moveTask(d: AppState, taskId: string, dir: -1 | 1) {
  const ws = requireWs(d);
  const list = taskList(ws);
  const i = list.findIndex((x) => x.id === taskId);
  if (i < 0) return;
  const t = list[i];
  // Subtasks move among their siblings; top-level tasks among the top-level tasks of their phase.
  const parent = parentOf(ws, t);
  const peer = (x: Task) => (parent ? x.parentId === parent.id : !parentOf(ws, x) && x.phaseId === t.phaseId);
  let j = i + dir;
  while (j >= 0 && j < list.length && !peer(list[j])) j += dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

/** Split a task into steps from text: one per line, or separated by ；/ ; */
export function splitSteps(text: string): string[] {
  return text.split(/[\n;；]+/).map((x) => x.trim()).filter(Boolean);
}

export interface SplitAnswers {
  /** What "done" looks like. */
  doneWhen: string;
  steps: string[];
  /** The biggest uncertainty / risk (optional). */
  risk?: string;
}

/** Split a top-level task of the current workspace into subtasks (adds to any it already has). */
export function splitTask(d: AppState, taskId: string, a: SplitAnswers): Task[] {
  const ws = requireWs(d);
  const list = taskList(ws);
  const t = list.find((x) => x.id === taskId) ?? fail('找不到任务');
  if (parentOf(ws, t)) fail('子任务不再继续拆分');
  if (t.status === 'done' || t.status === 'skipped') fail('已结束的任务不需要拆分');
  const doneWhen = a.doneWhen.trim() || fail('先写下做完是什么样');
  const steps = a.steps.map((x) => x.trim()).filter(Boolean);
  const had = childrenOf(ws, taskId);
  if (had.length + steps.length < 2) fail('至少拆成 2 步（每行一步，或用 ；分隔）');
  const risk = a.risk?.trim() || undefined;
  t.note = [t.note, `完成标准：${doneWhen}`, risk && `风险：${risk}`].filter(Boolean).join('\n');
  const now = Date.now();
  const kids: Task[] = steps.map((title) => ({ id: uid(), title, status: 'pending', phaseId: t.phaseId, parentId: t.id, createdAt: now }));
  const last = had.length ? had[had.length - 1] : t;
  list.splice(list.indexOf(last) + 1, 0, ...kids);
  emit(d, ws, {
    type: 'split',
    taskId,
    title: t.title,
    phaseId: t.phaseId ?? undefined,
    reason: doneWhen,
    detail: risk ? `风险：${risk}` : undefined,
    text: `拆分：${t.title} → ${steps.length} 步（完成标准：${doneWhen}）`,
    diff: kids.map((k) => ({ sign: '+' as const, num: numOf(ws, k.id), text: `☐ ${k.title}`, note: `↳ ${t.title}` })),
  });
  return kids;
}

/** Which of n new subtasks to start right away: "1 3", "1,2", "全部"/"all"; empty = none. */
export function parseLanePick(text: string, n: number): number[] {
  const s = text.trim().toLowerCase();
  if (!s) return [];
  if (s === 'all' || s === '全部' || s === '*') return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (const part of s.split(/[\s,，、]+/).filter(Boolean)) {
    const m = part.match(/^#?(\d+)(?:-(\d+))?$/) ?? fail(`看不懂「${part}」：填编号，如 1 2，或「全部」`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let k = a; k <= b; k++) {
      if (k < 1 || k > n) fail(`没有第 ${k} 步（共 ${n} 步）`);
      out.add(k - 1);
    }
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Submit the split questions: split, rerun what Fable refused (if anything), then start the
 * chosen steps — in parallel in Fable, the first one only in the other tiers.
 */
export function submitSplit(d: AppState, taskId: string, v: SplitAnswers & { start: string }, retry?: (d: AppState) => unknown): string {
  const kids = splitTask(d, taskId, v);
  const pick = parseLanePick(v.start, kids.length);
  const parent = taskList(requireWs(d)).find((x) => x.id === taskId)!;
  const parts = [`已拆分「${parent.title}」→ ${kids.length} 步`];
  const r = retry?.(d);
  if (typeof r === 'string') parts.push(r);
  const go = d.hie.tier === 'fable' ? pick : pick.slice(0, 1);
  for (const i of go) parts.push(setTaskStatus(d, kids[i].id, 'active'));
  if (go.length < pick.length) parts.push('其他步骤要在 Fable 档才能并行推进');
  return parts.join('　→　');
}

// ───────────────────────── goal ─────────────────────────

export function updateGoal(d: AppState, id: string, patch: Partial<Pick<Goal, 'title' | 'why' | 'doneWhen' | 'cadenceDays' | 'nextAction'>>): string {
  const g = d.goals.find((x) => x.id === id) ?? fail('找不到目标');
  const diff: DiffLine[] = [];
  const field = (k: 'title' | 'why' | 'doneWhen' | 'nextAction', label: string) => {
    const v = patch[k];
    if (v == null) return;
    const nv = v.trim();
    if (k === 'title' && !nv) return;
    if (nv !== g[k]) {
      diff.push({ sign: '~', text: `${label}  ${g[k] || '（无）'} → ${nv || '（无）'}` });
      g[k] = nv;
    }
  };
  field('title', '目标');
  field('why', '为什么');
  field('doneWhen', '完成标准');
  field('nextAction', '下一步');
  if (patch.cadenceDays && patch.cadenceDays > 0 && Math.round(patch.cadenceDays) !== g.cadenceDays) {
    diff.push({ sign: '~', text: `周期  ${g.cadenceDays}d → ${Math.round(patch.cadenceDays)}d` });
    g.cadenceDays = Math.round(patch.cadenceDays);
  }
  if (diff.length) emit(d, g, { type: 'edit', text: diff.map((x) => x.text).join('；'), diff });
  return `已更新目标「${g.title}」`;
}

export function updatePlan(d: AppState, id: string, patch: { title?: string; objective?: string }): string {
  const p = d.plans.find((x) => x.id === id) ?? fail('找不到计划');
  const diff: DiffLine[] = [];
  if (patch.title != null && patch.title.trim() && patch.title.trim() !== p.title) {
    diff.push({ sign: '~', text: `标题  ${p.title} → ${patch.title.trim()}` });
    p.title = patch.title.trim();
  }
  if (patch.objective != null && patch.objective.trim() !== p.objective) {
    diff.push({ sign: '~', text: `目标  ${p.objective || '（无）'} → ${patch.objective.trim() || '（无）'}` });
    p.objective = patch.objective.trim();
  }
  if (diff.length) emit(d, p, { type: 'edit', text: diff.map((x) => x.text).join('；'), diff });
  return `已更新计划「${p.title}」`;
}

export function nextCheckpointAt(g: Goal): number {
  const last = g.checkpoints[g.checkpoints.length - 1];
  return (last ? last.at : g.createdAt) + g.cadenceDays * DAY;
}

export function checkpointDue(g: Goal, now = Date.now()): boolean {
  return g.status === 'active' && nextCheckpointAt(g) <= now;
}

export function addCheckpoint(d: AppState, goalId: string, cp: Omit<Checkpoint, 'id' | 'at'>): string {
  const g = d.goals.find((x) => x.id === goalId) ?? fail('找不到目标');
  if (!cp.did.trim() && !cp.learned.trim() && !cp.next.trim()) fail('Checkpoint 至少写一项：做了什么 / 学到什么 / 下一步');
  const c: Checkpoint = { ...cp, id: uid(), at: Date.now(), progress: Math.max(0, Math.min(100, Math.round(cp.progress))) };
  g.checkpoints.push(c);
  const prevNext = g.nextAction;
  if (cp.next.trim()) g.nextAction = cp.next.trim();
  emit(d, g, {
    type: 'checkpoint',
    version: g.checkpoints.length,
    text: `Checkpoint #${g.checkpoints.length} · ${c.progress}% · ${c.verdict}${c.next ? ` · 下一步：${c.next}` : ''}`,
    detail: `${c.progress}% · ${{ 'on-track': '顺利', drifting: '偏航', blocked: '受阻', pivot: '转向' }[c.verdict]}`,
    reason: c.learned || undefined,
    diff: cp.next.trim() && cp.next.trim() !== prevNext ? [
      ...(prevNext ? [{ sign: '-' as const, text: `下一步  ${prevNext}` }] : []),
      { sign: '+', text: `下一步  ${cp.next.trim()}` },
    ] : undefined,
  });
  return `已记录 Checkpoint #${g.checkpoints.length}（${c.progress}%）`;
}

// ───────────────────────── HIE ─────────────────────────

/**
 * Tier change rules around Fable. Entering it: the task this device works on in the current
 * workspace must be split first. Leaving it: one subtask per split task stays in progress,
 * the others are paused — returned so the caller can say which.
 */
function changeTier(d: AppState, tier: Tier): string[] {
  const from = d.hie.tier;
  const paused: string[] = [];
  if (tier === 'fable' && from !== 'fable') {
    const ws = currentWs(d);
    const cur = ws && currentTask(ws, d);
    if (ws && cur && needsSplit(ws, cur)) throw new SplitRequired(cur.id, cur.title);
  }
  if (from === 'fable' && tier !== 'fable') {
    for (const ws of [...d.plans, ...d.goals]) {
      const seen = new Set<string>();
      for (const t of activeLanes(ws, d)) {
        if (!seen.has(t.parentId!)) {
          seen.add(t.parentId!);
          continue;
        }
        t.status = 'pending';
        delete t.activeBy;
        paused.push(t.title);
      }
    }
  }
  if (from !== tier) d.hie.updatedAt = Date.now();
  d.hie.tier = tier;
  return paused;
}

const pausedNote = (paused: string[]) => (paused.length ? `　·　并行子任务只保留一路，已暂停：${paused.join('、')}` : '');

export function setTier(d: AppState, tier: Tier): string {
  const paused = changeTier(d, tier);
  const s = activeSession(d);
  if (s && s.tier !== tier) splitSession(d, s, { tier, lanes: tier === 'fable' ? laneCount(d) : undefined });
  return `模型档位 → ${TIERS[tier].label}${pausedNote(paused)}`;
}

/** A Fable session is priced by the subtasks in progress: a change in their number starts a new segment. */
function syncLanes(d: AppState) {
  const s = activeSession(d);
  if (!s || s.tier !== 'fable') return;
  const n = laneCount(d);
  if ((s.lanes ?? 1) !== n) splitSession(d, s, { lanes: n });
}

export function setEffort(d: AppState, effort: Effort): string {
  if (d.hie.effort !== effort) d.hie.updatedAt = Date.now();
  d.hie.effort = effort;
  const s = activeSession(d);
  if (s && s.effort !== effort) splitSession(d, s, { effort });
  return `推理强度 → ${effort}`;
}

function splitSession(d: AppState, s: Session, patch: Partial<Pick<Session, 'tier' | 'effort' | 'lanes'>>) {
  const now = Date.now();
  const next: Session = { ...s, ...patch, id: uid(), startedAt: now, endedAt: undefined, tokens: undefined, fatigue: undefined, outcome: undefined };
  if (next.lanes == null || next.tier !== 'fable') delete next.lanes;
  if (now - s.startedAt < 1000) {
    // Several changes in one go (e.g. starting a few subtasks): no empty segments.
    Object.assign(s, { tier: next.tier, effort: next.effort });
    if (next.lanes != null) s.lanes = next.lanes;
    else delete s.lanes;
    return;
  }
  s.endedAt = now;
  s.tokens = sessionTokens(s, now, latestFatigue(d, now));
  d.sessions.push(next);
}

export function startSession(d: AppState, opts: { intent: string; plannedMin: number; tier: Tier; effort: Effort }): string {
  if (activeSession(d)) fail('已有进行中的 Session，先 /end 结束它');
  const ws = currentWs(d);
  const paused = changeTier(d, opts.tier);
  if (d.hie.effort !== opts.effort) d.hie.updatedAt = Date.now();
  d.hie.effort = opts.effort;
  const id = uid();
  const planned = Math.max(5, Math.round(opts.plannedMin) || 25);
  d.sessions.push({
    id,
    runId: id,
    wsId: ws?.id ?? null,
    tier: opts.tier,
    effort: opts.effort,
    intent: opts.intent.trim(),
    plannedMin: planned,
    startedAt: Date.now(),
    ...(d.ui.deviceId ? { device: d.ui.deviceId } : {}),
    ...(opts.tier === 'fable' ? { lanes: laneCount(d) } : {}),
  });
  if (ws) {
    emit(d, ws, {
      type: 'session-start',
      runId: id,
      text: `开始专注 Session · ${TIERS[opts.tier].label}/${opts.effort} · ${planned}m${opts.intent.trim() ? ` · ${opts.intent.trim()}` : ''}`,
      title: opts.intent.trim() || undefined,
      detail: `${TIERS[opts.tier].label} · ${opts.effort} · ${planned}m`,
    });
  }
  return `Session 开始 · ${TIERS[opts.tier].label} / ${opts.effort} · 计划 ${planned} 分钟${pausedNote(paused)}`;
}

export function runSegments(d: Pick<AppState, 'sessions'>, runId: string): Session[] {
  return d.sessions.filter((x) => (x.runId ?? x.id) === runId);
}

/**
 * End this device's session — or, with `other`, the session left running on another
 * device (e.g. forgotten there): shown to the user, never ended behind their back.
 */
export function endSession(d: AppState, opts: { fatigue?: number | null; outcome?: string; other?: boolean }): string {
  const s = opts.other
    ? (otherSessions(d)[0] ?? fail('没有在其他设备上进行中的 Session'))
    : (activeSession(d) ?? fail(otherSessions(d).length ? '这台设备上没有进行中的 Session。另一台设备上的可以用 /end other 结束' : '当前没有进行中的 Session'));
  const now = Date.now();
  s.endedAt = now;
  // The fatigue reported at the end prices the whole session (every segment of the run,
  // e.g. before and after a tier switch); without one, the status-bar fatigue does.
  const fat = opts.fatigue || latestFatigue(d, now);
  const run = runSegments(d, s.runId);
  for (const x of run) x.tokens = sessionTokens({ ...x, tokens: undefined }, now, fat);
  if (opts.fatigue) {
    s.fatigue = opts.fatigue;
    d.fatigue.push({ at: now, level: opts.fatigue });
  }
  if (opts.outcome?.trim()) s.outcome = opts.outcome.trim();
  const ws = findWs(d, s.wsId);
  const durMs = now - run[0].startedAt;
  const mins = Math.round(durMs / 60_000);
  const total = run.reduce((a, x) => a + (x.tokens ?? 0), 0);
  if (ws) {
    emit(d, ws, {
      type: 'session-end',
      runId: s.runId,
      durMs,
      tokens: total,
      reason: s.outcome,
      detail: fat ? `疲劳 ${fat}/5 ×${fatigueMult(fat)}` : undefined,
      text: `结束 Session · ${mins}m · ${total} tokens${s.outcome ? ` · ${s.outcome}` : ''}${fat ? ` · 疲劳 ${fat}/5 ×${fatigueMult(fat)}` : ''}`,
    });
  }
  return `Session 结束 · ${mins} 分钟 · ${total.toLocaleString()} tokens`;
}

export function markFatigue(d: AppState, level: number): string {
  const l = Math.round(level);
  if (!(l >= 1 && l <= 5)) fail('疲劳自评需在 1–5 之间（1 = 精力充沛，5 = 需要休息）');
  d.fatigue.push({ at: Date.now(), level: l });
  if (d.fatigue.length > 1000) d.fatigue.splice(0, d.fatigue.length - 1000);
  return `疲劳自评：${l}/5`;
}

export function setBudget(d: AppState, n: number): string {
  if (!(n >= 1000 && n <= 10_000_000)) fail('每日预算需在 1k–10M 之间，例如 /budget 200k');
  if (d.settings.dailyBudget !== Math.round(n)) d.settings.updatedAt = Date.now();
  d.settings.dailyBudget = Math.round(n);
  return `每日 Cognitive Token 预算 → ${Math.round(n).toLocaleString()}`;
}

export function parseTokenAmount(s: string): number {
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1);
}

// ───────────────────────── compact ─────────────────────────

export function saveCompact(d: AppState, wsId: string, text: string): string {
  const ws = findWs(d, wsId) ?? fail('找不到该 Plan/Goal');
  const t = text.trim() || fail('快照内容为空');
  d.compacts.push({ id: uid(), wsId, at: Date.now(), text: t });
  const mine = d.compacts.filter((c) => c.wsId === wsId);
  if (mine.length > 20) {
    const drop = new Set(mine.slice(0, mine.length - 20).map((c) => c.id));
    d.compacts = d.compacts.filter((c) => !drop.has(c.id));
  }
  emit(d, ws, { type: 'compact', text: '保存了工作快照（Compact）' });
  return `已 Compact「${ws.title}」· 下次打开时可 Resume`;
}
