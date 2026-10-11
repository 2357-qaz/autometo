// Rule-based context snapshot ("Compact"). No LLM involved.
import type { AppState, Goal, Plan, Workspace } from './types';
import { activeSession, latestFatigue, sessionTokens, TIERS } from './hie';
import { checkpointDue, currentPhase, currentTask, nextCheckpointAt, orderedTasks, otherActiveTasks } from './ops';
import { diffPlan, diffSummary } from './diff';
import { fmtDate, fmtTime, startOfDay } from './util';

export function generateCompact(state: AppState, ws: Workspace, now = Date.now()): string {
  const lines = ws.kind === 'plan' ? planLines(ws, state) : goalLines(ws, now);
  lines.push('', ...sessionLines(state, ws, now));
  const recent = ws.log.filter((l) => !['compact', 'session-start', 'session-end'].includes(l.type)).slice(-5);
  if (recent.length) {
    lines.push('', '## 最近动态');
    for (const l of recent) lines.push(`- ${fmtTime(l.at)} ${l.text}`);
  }
  lines.push('', '## 恢复时先做', '- ');
  return [`# Compact · ${ws.title} · ${fmtDate(now)}`, '', ...lines].join('\n');
}

function planLines(p: Plan, state: AppState): string[] {
  const out: string[] = [];
  out.push(`模式：Plan Mode · 状态 ${p.status}`);
  if (p.objective) out.push(`目标：${p.objective}`);
  const tasks = orderedTasks(p);
  const done = tasks.filter((t) => t.status === 'done').length;
  const counted = tasks.filter((t) => t.status !== 'skipped').length;
  out.push(`进度：${done}/${counted} 任务（${counted ? Math.round((done / counted) * 100) : 0}%）`);
  const ph = currentPhase(p);
  if (ph) {
    const idx = p.phases.indexOf(ph) + 1;
    out.push(`当前阶段：${idx}/${p.phases.length}「${ph.title}」${ph.goal ? ` — ${ph.goal}` : ''}`);
  }
  const active = currentTask(p, state);
  out.push('', '## 我做到哪里');
  out.push(active ? `- 进行中：#${tasks.indexOf(active) + 1} ${active.title}${active.note ? `（${active.note}）` : ''}` : '- 没有进行中的任务');
  for (const t of otherActiveTasks(p, state)) out.push(`- 另一台设备进行中：#${tasks.indexOf(t) + 1} ${t.title}`);
  const lastDone = tasks.filter((t) => t.status === 'done' && t.doneAt).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 3);
  for (const t of lastDone) out.push(`- 已完成：${t.title}`);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    out.push('', '## 阻塞');
    for (const t of blocked) out.push(`- #${tasks.indexOf(t) + 1} ${t.title}${t.note ? `：${t.note}` : ''}`);
  }
  const next = tasks.filter((t) => t.status === 'pending').slice(0, 3);
  out.push('', '## 下一步');
  if (next.length) for (const t of next) out.push(`- #${tasks.indexOf(t) + 1} ${t.title}`);
  else out.push('- 待办已清空：考虑完成阶段或补充任务');
  const pd = diffPlan(p);
  if (pd) {
    const sum = diffSummary(pd);
    out.push('', `相对 v${pd.base.v}（${fmtDate(pd.base.at)}）：${sum ?? '与计划一致'}${pd.firstDrift ? ` · 首次偏离 ${fmtDate(pd.firstDrift.at)}${pd.firstDriftPhase ? `「${pd.firstDriftPhase}」` : ''}` : ''}`);
  }
  const lastRevise = [...p.log].reverse().find((l) => l.type === 'revise');
  if (lastRevise) out.push('', `最近一次修正：${lastRevise.text}`);
  return out;
}

function goalLines(g: Goal, now: number): string[] {
  const out: string[] = [];
  out.push(`模式：Goal Mode · 状态 ${g.status}`);
  if (g.why) out.push(`为什么：${g.why}`);
  if (g.doneWhen) out.push(`完成标准：${g.doneWhen}`);
  const last = g.checkpoints[g.checkpoints.length - 1];
  out.push('', '## 我做到哪里');
  if (last) {
    out.push(`- 最近 Checkpoint（${fmtDate(last.at)}）：${last.progress}% · ${last.verdict}`);
    if (last.did) out.push(`- 做了：${last.did}`);
    if (last.learned) out.push(`- 学到：${last.learned}`);
  } else out.push('- 还没有 Checkpoint');
  const doneMoves = g.moves.filter((m) => m.status === 'done').length;
  if (g.moves.length) out.push(`- 行动：${doneMoves}/${g.moves.length} 完成`);
  out.push('', '## 下一步');
  out.push(`- ${g.nextAction || '（未设定，先动起来：写一个 30 分钟内能开始的动作）'}`);
  for (const m of g.moves.filter((x) => x.status === 'active' || x.status === 'pending').slice(0, 3)) out.push(`- ${m.status === 'active' ? '▶ ' : ''}${m.title}`);
  const due = nextCheckpointAt(g);
  out.push(checkpointDue(g, now) ? `⚑ Checkpoint 已到期（应于 ${fmtDate(due)}）` : `下次 Checkpoint：${fmtDate(due)}`);
  return out;
}

function sessionLines(state: AppState, ws: Workspace, now: number): string[] {
  const sod = startOfDay(now);
  const mine = state.sessions.filter((s) => s.wsId === ws.id && (s.endedAt ?? now) >= sod);
  const tokens = mine.reduce((a, s) => a + sessionTokens(s, now, latestFatigue(state, now)), 0);
  const mins = Math.round(mine.reduce((a, s) => a + ((s.endedAt ?? now) - s.startedAt), 0) / 60_000);
  const cur = activeSession(state);
  const out = ['## 今日投入（HIE）'];
  out.push(`- ${mine.length ? `${mins} 分钟 · ${tokens.toLocaleString()} tokens` : '今天还没有在这里开 Session'}`);
  out.push(`- 档位：${TIERS[cur?.tier ?? state.hie.tier].label} / ${cur?.effort ?? state.hie.effort}`);
  const f = state.fatigue.filter((x) => x.at >= sod).pop();
  if (f) out.push(`- 疲劳自评：${f.level}/5`);
  return out;
}
