// What deserves a nudge. Pure, so the server can evaluate it on a timer, a phone can
// schedule it ahead as local notifications, and the tests can pin the clock. Each
// reminder has a stable key so it is delivered once (a new due date or a new session
// gives a new key).
import type { AppState, Goal, Phase, Plan, Session } from './types';
import { activeSession, runStartedAt } from './hie';
import { checkpointDue, dueAt, nextCheckpointAt } from './ops';
import { DAY, fmtDate } from './util';

export interface Reminder {
  key: string;
  title: string;
  body: string;
  /** Workspace to open when the notification is tapped. */
  wsId?: string;
}

/** A reminder with the moment it becomes due. */
export interface ScheduledReminder extends Reminder {
  at: number;
}

const checkpointReminder = (g: Goal): Reminder => ({
  key: `cp:${g.id}:${nextCheckpointAt(g)}`,
  title: `⚑ Checkpoint 到期 · ${g.title}`,
  body: '停下来看看：做了什么、学到什么、下一步往哪走。',
  wsId: g.id,
});

const phaseReminder = (p: Plan, ph: Phase & { due: string }): Reminder => ({
  key: `due:${ph.id}:${ph.due}`,
  title: `阶段逾期 · ${ph.title}`,
  body: `「${p.title}」的阶段目标日期是 ${fmtDate(dueAt(ph.due)).slice(5)}。完成它、修正目标，或调整日期。`,
  wsId: p.id,
});

const sessionReminder = (ses: Session): Reminder => ({
  key: `ses:${ses.runId}`,
  title: '✻ 专注时间到了',
  body: `已经超过计划的 ${ses.plannedMin} 分钟${ses.intent ? `（${ses.intent}）` : ''}。休息一下，或结束 Session 留个记录。`,
  wsId: ses.wsId ?? undefined,
});

const openPhases = (s: AppState) =>
  s.plans.filter((p) => p.status === 'active').flatMap((p) => p.phases.filter((ph): ph is Phase & { due: string } => ph.status !== 'done' && !!ph.due).map((ph) => ({ p, ph })));

/** Reminders that are due now (the server pushes these). */
export function dueReminders(s: AppState, now = Date.now()): Reminder[] {
  const out: Reminder[] = [];
  for (const g of s.goals) if (checkpointDue(g, now)) out.push(checkpointReminder(g));
  for (const { p, ph } of openPhases(s)) if (now > dueAt(ph.due)) out.push(phaseReminder(p, ph));
  // Every running session, whichever device runs it (sessions can run in parallel).
  for (const ses of s.sessions.filter((x) => x.endedAt == null)) {
    if (now - runStartedAt(s, ses.runId) > ses.plannedMin * 60_000) out.push(sessionReminder(ses));
  }
  return out;
}

/** An overdue phase is mentioned the next morning, not at midnight. */
const MORNING_AFTER_DUE = 9 * 3_600_000 + 1000;

/**
 * Reminders this device can schedule ahead (local notifications): the ones that will
 * become due within `horizon`. Only this device's session — another device reminds of its own.
 */
export function reminderSchedule(s: AppState, now = Date.now(), horizon = 30 * DAY): ScheduledReminder[] {
  const out: ScheduledReminder[] = [];
  const add = (r: Reminder, at: number) => at > now && at <= now + horizon && out.push({ ...r, at });
  for (const g of s.goals) if (g.status === 'active') add(checkpointReminder(g), nextCheckpointAt(g));
  for (const { p, ph } of openPhases(s)) add(phaseReminder(p, ph), dueAt(ph.due) + MORNING_AFTER_DUE);
  const ses = activeSession(s);
  if (ses) add(sessionReminder(ses), runStartedAt(s, ses.runId) + ses.plannedMin * 60_000);
  return out.sort((a, b) => a.at - b.at);
}
