// Pure domain operations. Each mutates a draft AppState and returns a short
// human-readable result line. User errors are thrown as Error.
import type { AppState, Checkpoint, Effort, Goal, LogKind, Plan, Session, Task, TaskStatus, Tier, Workspace } from './types';
import { activeSession, sessionTokens, TIERS } from './hie';
import { activeGoal, activePlan, currentWs, findWs } from './store';
import { DAY, uid } from './util';

export class UserError extends Error {}
const fail = (msg: string): never => {
  throw new UserError(msg);
};

export function log(ws: Workspace, kind: LogKind, text: string, now = Date.now()) {
  ws.log.push({ id: uid(), at: now, kind, text });
  if (ws.log.length > 500) ws.log.splice(0, ws.log.length - 500);
  ws.updatedAt = now;
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
    log: [],
    createdAt: now,
    updatedAt: now,
  };
  log(p, 'create', `创建计划「${t}」`, now);
  d.plans.unshift(p);
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
  log(g, 'create', `设定目标「${t}」`, now);
  d.goals.unshift(g);
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
  log(ws, 'note', `重命名：「${ws.title}」→「${t}」`);
  ws.title = t;
  return `已重命名为「${t}」`;
}

export function setWsStatus(d: AppState, id: string, status: Workspace['status']): string {
  const ws = findWs(d, id) ?? fail('找不到该 Plan/Goal');
  ws.status = status;
  log(ws, 'note', `状态 → ${status}`);
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

export function addNote(d: AppState, text: string): string {
  const ws = requireWs(d);
  const t = text.trim() || fail('记录内容为空');
  log(ws, 'note', t);
  return `已记录到「${ws.title}」日志`;
}

// ───────────────────────── plan: phases ─────────────────────────

export function currentPhase(p: Plan) {
  return p.phases.find((ph) => ph.status === 'active') ?? p.phases.find((ph) => ph.status === 'pending') ?? p.phases[p.phases.length - 1];
}

export function addPhase(d: AppState, title: string, goal = ''): string {
  const p = requirePlan(d);
  const t = title.trim() || `Phase ${p.phases.length + 1}`;
  const hasActive = p.phases.some((ph) => ph.status === 'active');
  p.phases.push({ id: uid(), title: t, goal: goal.trim(), status: hasActive ? 'pending' : 'active' });
  log(p, 'phase', `新增阶段「${t}」`);
  return `新增阶段「${t}」`;
}

export function updatePhase(d: AppState, phaseId: string, patch: { title?: string; goal?: string }): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  if (patch.title != null) ph.title = patch.title.trim() || ph.title;
  if (patch.goal != null) ph.goal = patch.goal.trim();
  p.updatedAt = Date.now();
  return `已更新阶段「${ph.title}」`;
}

export function revisePhase(d: AppState, phaseId: string, newGoal: string, reason: string): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  const g = newGoal.trim() || fail('修正后的阶段目标不能为空');
  const r = reason.trim() || fail('请写下修正原因——这是复盘最有价值的部分');
  const old = ph.goal || '（未设定）';
  ph.goal = g;
  log(p, 'revise', `修正「${ph.title}」目标：${old} → ${g}｜原因：${r}`);
  return `已修正阶段「${ph.title}」`;
}

export function completePhase(d: AppState, phaseId: string): string {
  const p = requirePlan(d);
  const idx = p.phases.findIndex((x) => x.id === phaseId);
  if (idx < 0) fail('找不到阶段');
  const ph = p.phases[idx];
  ph.status = 'done';
  const next = p.phases.slice(idx + 1).find((x) => x.status === 'pending');
  if (next && !p.phases.some((x) => x.status === 'active')) next.status = 'active';
  log(p, 'phase', `完成阶段「${ph.title}」${next ? `，进入「${next.title}」` : ''}`);
  return `阶段「${ph.title}」完成${next ? ` → 进入「${next.title}」` : ''}`;
}

export function activatePhase(d: AppState, phaseId: string): string {
  const p = requirePlan(d);
  const ph = p.phases.find((x) => x.id === phaseId) ?? fail('找不到阶段');
  for (const x of p.phases) if (x.status === 'active') x.status = 'pending';
  ph.status = 'active';
  log(p, 'phase', `切换到阶段「${ph.title}」`);
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
  const n = p.tasks.filter((t) => t.phaseId === phaseId).length;
  p.tasks = p.tasks.filter((t) => t.phaseId !== phaseId);
  p.phases = p.phases.filter((x) => x.id !== phaseId);
  if (ph.status === 'active') {
    const nx = p.phases.find((x) => x.status === 'pending');
    if (nx) nx.status = 'active';
  }
  log(p, 'phase', `删除阶段「${ph.title}」（含 ${n} 个任务）`);
  return `已删除阶段「${ph.title}」`;
}

// ───────────────────────── tasks (plan tasks & goal moves) ─────────────────────────

/** Ordered task list used for numbering (#1, #2…) in the current workspace. */
export function orderedTasks(ws: Workspace): Task[] {
  if (ws.kind === 'goal') return ws.moves;
  const out: Task[] = [];
  for (const ph of ws.phases) out.push(...ws.tasks.filter((t) => t.phaseId === ph.id));
  out.push(...ws.tasks.filter((t) => !ws.phases.some((ph) => ph.id === t.phaseId)));
  return out;
}

function taskList(ws: Workspace): Task[] {
  return ws.kind === 'plan' ? ws.tasks : ws.moves;
}

export function resolveTask(ws: Workspace, ref: string | undefined): Task {
  const list = orderedTasks(ws);
  if (!ref || !ref.trim()) {
    return list.find((t) => t.status === 'active') ?? fail('没有进行中的任务，请指定编号，例如 /done 2');
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
  log(ws, 'task', `+ ${t}`);
  return task;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待办',
  active: '进行中',
  done: '完成',
  blocked: '阻塞',
  skipped: '跳过',
};

export function setTaskStatus(d: AppState, taskId: string, status: TaskStatus, note?: string): string {
  const ws = requireWs(d);
  const list = taskList(ws);
  const task = list.find((t) => t.id === taskId) ?? fail('找不到任务');
  if (status === 'active') {
    // Exactly one task in progress at a time, like a focused agent.
    for (const t of list) if (t.status === 'active' && t.id !== taskId) t.status = 'pending';
    if (ws.kind === 'plan' && task.phaseId) {
      const ph = ws.phases.find((x) => x.id === task.phaseId);
      if (ph && ph.status === 'pending') {
        for (const x of ws.phases) if (x.status === 'active') x.status = 'pending';
        ph.status = 'active';
      }
    }
  }
  task.status = status;
  if (status === 'done') task.doneAt = Date.now();
  else delete task.doneAt;
  if (note != null && note.trim()) task.note = note.trim();
  log(ws, 'task', `${STATUS_LABEL[status]}：${task.title}${note?.trim() ? `（${note.trim()}）` : ''}`);
  let msg = `${STATUS_LABEL[status]}：${task.title}`;
  if (ws.kind === 'plan' && status === 'done' && task.phaseId) {
    const ph = ws.phases.find((x) => x.id === task.phaseId);
    const rest = ws.tasks.filter((t) => t.phaseId === task.phaseId && (t.status === 'pending' || t.status === 'active' || t.status === 'blocked'));
    if (ph && ph.status !== 'done' && rest.length === 0) msg += `　·　阶段「${ph.title}」任务已清空，可 /phase done 结束本阶段`;
  }
  return msg;
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
  const list = orderedTasks(ws);
  const cur = list.find((t) => t.status === 'active');
  const parts: string[] = [];
  if (cur) parts.push(setTaskStatus(d, cur.id, 'done'));
  const fresh = orderedTasks(requireWs(d));
  const nx = fresh.find((t) => t.status === 'pending');
  if (nx) parts.push(setTaskStatus(d, nx.id, 'active'));
  else parts.push('没有更多待办任务 ✓');
  return parts.join('　→　');
}

export function updateTask(d: AppState, taskId: string, patch: { title?: string; note?: string; phaseId?: string | null }): string {
  const ws = requireWs(d);
  const t = taskList(ws).find((x) => x.id === taskId) ?? fail('找不到任务');
  if (patch.title != null) t.title = patch.title.trim() || t.title;
  if (patch.note != null) t.note = patch.note.trim() || undefined;
  if (patch.phaseId !== undefined && ws.kind === 'plan') t.phaseId = patch.phaseId;
  ws.updatedAt = Date.now();
  return `已更新：${t.title}`;
}

export function deleteTask(d: AppState, taskId: string): string {
  const ws = requireWs(d);
  const list = taskList(ws);
  const i = list.findIndex((x) => x.id === taskId);
  if (i < 0) fail('找不到任务');
  const [t] = list.splice(i, 1);
  log(ws, 'task', `- ${t.title}`);
  return `已删除：${t.title}`;
}

export function moveTask(d: AppState, taskId: string, dir: -1 | 1) {
  const ws = requireWs(d);
  const list = taskList(ws);
  const i = list.findIndex((x) => x.id === taskId);
  if (i < 0) return;
  const t = list[i];
  // find neighbour within same phase
  let j = i + dir;
  while (j >= 0 && j < list.length && list[j].phaseId !== t.phaseId) j += dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// ───────────────────────── goal ─────────────────────────

export function updateGoal(d: AppState, id: string, patch: Partial<Pick<Goal, 'title' | 'why' | 'doneWhen' | 'cadenceDays' | 'nextAction'>>): string {
  const g = d.goals.find((x) => x.id === id) ?? fail('找不到目标');
  if (patch.nextAction != null && patch.nextAction.trim() !== g.nextAction) {
    log(g, 'note', `下一步 → ${patch.nextAction.trim() || '（清空）'}`);
  }
  Object.assign(g, {
    ...patch,
    title: patch.title?.trim() || g.title,
    cadenceDays: patch.cadenceDays && patch.cadenceDays > 0 ? Math.round(patch.cadenceDays) : g.cadenceDays,
  });
  g.updatedAt = Date.now();
  return `已更新目标「${g.title}」`;
}

export function updatePlan(d: AppState, id: string, patch: { title?: string; objective?: string }): string {
  const p = d.plans.find((x) => x.id === id) ?? fail('找不到计划');
  if (patch.title != null) p.title = patch.title.trim() || p.title;
  if (patch.objective != null) p.objective = patch.objective.trim();
  p.updatedAt = Date.now();
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
  if (cp.next.trim()) g.nextAction = cp.next.trim();
  log(g, 'checkpoint', `Checkpoint #${g.checkpoints.length} · ${c.progress}% · ${c.verdict}${c.next ? ` · 下一步：${c.next}` : ''}`);
  return `已记录 Checkpoint #${g.checkpoints.length}（${c.progress}%）`;
}

// ───────────────────────── HIE ─────────────────────────

export function setTier(d: AppState, tier: Tier): string {
  d.hie.tier = tier;
  const s = activeSession(d);
  if (s && s.tier !== tier) {
    // Split the running session so tokens before the switch keep the old rate.
    splitSession(d, s, { tier });
  }
  return `模型档位 → ${TIERS[tier].label}`;
}

export function setEffort(d: AppState, effort: Effort): string {
  d.hie.effort = effort;
  const s = activeSession(d);
  if (s && s.effort !== effort) splitSession(d, s, { effort });
  return `推理强度 → ${effort}`;
}

function splitSession(d: AppState, s: Session, patch: Partial<Pick<Session, 'tier' | 'effort'>>) {
  const now = Date.now();
  s.endedAt = now;
  s.tokens = sessionTokens(s, now);
  d.sessions.push({ ...s, ...patch, id: uid(), startedAt: now, endedAt: undefined, tokens: undefined, fatigue: undefined, outcome: undefined });
}

export function startSession(d: AppState, opts: { intent: string; plannedMin: number; tier: Tier; effort: Effort }): string {
  if (activeSession(d)) fail('已有进行中的 Session，先 /end 结束它');
  const ws = currentWs(d);
  d.hie.tier = opts.tier;
  d.hie.effort = opts.effort;
  const id = uid();
  d.sessions.push({
    id,
    runId: id,
    wsId: ws?.id ?? null,
    tier: opts.tier,
    effort: opts.effort,
    intent: opts.intent.trim(),
    plannedMin: Math.max(5, Math.round(opts.plannedMin) || 25),
    startedAt: Date.now(),
  });
  if (ws) log(ws, 'session', `开始专注 Session · ${TIERS[opts.tier].label}/${opts.effort} · ${opts.plannedMin}m${opts.intent.trim() ? ` · ${opts.intent.trim()}` : ''}`);
  return `Session 开始 · ${TIERS[opts.tier].label} / ${opts.effort} · 计划 ${opts.plannedMin} 分钟`;
}

export function endSession(d: AppState, opts: { fatigue?: number | null; outcome?: string }): string {
  const s = activeSession(d) ?? fail('当前没有进行中的 Session');
  const now = Date.now();
  s.endedAt = now;
  s.tokens = sessionTokens(s, now);
  const run = runSegments(d, s.runId);
  if (opts.fatigue) {
    s.fatigue = opts.fatigue;
    d.fatigue.push({ at: now, level: opts.fatigue });
  }
  if (opts.outcome?.trim()) s.outcome = opts.outcome.trim();
  const ws = findWs(d, s.wsId);
  const mins = Math.round((now - run[0].startedAt) / 60_000);
  const total = run.reduce((a, x) => a + (x.tokens ?? 0), 0);
  if (ws) log(ws, 'session', `结束 Session · ${mins}m · ${total} tokens${s.outcome ? ` · ${s.outcome}` : ''}${opts.fatigue ? ` · 疲劳 ${opts.fatigue}/5` : ''}`);
  return `Session 结束 · ${mins} 分钟 · ${total.toLocaleString()} tokens`;
}

export function runSegments(d: Pick<AppState, 'sessions'>, runId: string): Session[] {
  return d.sessions.filter((x) => (x.runId ?? x.id) === runId);
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
  // Keep the last 20 per workspace.
  const mine = d.compacts.filter((c) => c.wsId === wsId);
  if (mine.length > 20) {
    const drop = new Set(mine.slice(0, mine.length - 20).map((c) => c.id));
    d.compacts = d.compacts.filter((c) => !drop.has(c.id));
  }
  log(ws, 'compact', '保存了工作快照（Compact）');
  return `已 Compact「${ws.title}」· 下次打开时可 Resume`;
}

export function requireWsSafe(d: AppState): Workspace | undefined {
  return currentWs(d);
}
