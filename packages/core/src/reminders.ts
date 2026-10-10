// What deserves a nudge right now. Pure, so the server can evaluate it on a
// timer and the tests can pin the clock. Each reminder has a stable key so it
// is delivered once (a new due date or a new session gives a new key).
import type { AppState } from './types';
import { activeSession, runStartedAt } from './hie';
import { checkpointDue, dueAt, nextCheckpointAt } from './ops';
import { fmtDate } from './util';

export interface Reminder {
  key: string;
  title: string;
  body: string;
  /** Workspace to open when the notification is tapped. */
  wsId?: string;
}

export function dueReminders(s: AppState, now = Date.now()): Reminder[] {
  const out: Reminder[] = [];
  for (const g of s.goals) {
    if (checkpointDue(g, now)) {
      const at = nextCheckpointAt(g);
      out.push({ key: `cp:${g.id}:${at}`, title: `⚑ Checkpoint 到期 · ${g.title}`, body: '停下来看看：做了什么、学到什么、下一步往哪走。', wsId: g.id });
    }
  }
  for (const p of s.plans) {
    if (p.status !== 'active') continue;
    for (const ph of p.phases) {
      if (ph.status === 'done' || !ph.due || now <= dueAt(ph.due)) continue;
      out.push({ key: `due:${ph.id}:${ph.due}`, title: `阶段逾期 · ${ph.title}`, body: `「${p.title}」的阶段目标日期是 ${fmtDate(dueAt(ph.due)).slice(5)}。完成它、修正目标，或调整日期。`, wsId: p.id });
    }
  }
  const ses = activeSession(s);
  if (ses) {
    const elapsed = now - runStartedAt(s, ses.runId);
    if (elapsed > ses.plannedMin * 60_000) {
      out.push({ key: `ses:${ses.runId}`, title: '✻ 专注时间到了', body: `已经超过计划的 ${ses.plannedMin} 分钟${ses.intent ? `（${ses.intent}）` : ''}。休息一下，或结束 Session 留个记录。`, wsId: ses.wsId ?? undefined });
    }
  }
  return out;
}
