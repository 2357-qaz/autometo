// Human Inference Engine — a playful metaphor for personal effort budgeting.
// "Tokens" here are NOT a measurement of brain power or fatigue.
import type { AppState, Effort, Session, Tier } from './types';
import { startOfDay } from './util';

export const TIERS: Record<Tier, { label: string; rate: number; hint: string }> = {
  haiku: { label: 'Haiku', rate: 400, hint: '轻量：回复消息、整理、杂事' },
  sonnet: { label: 'Sonnet', rate: 800, hint: '常规：日常推进、写作、编码' },
  opus: { label: 'Opus', rate: 1500, hint: '深度：难题、设计、需要整块专注' },
};

export const EFFORTS: Record<Effort, { label: string; mult: number; hint: string }> = {
  low: { label: 'low', mult: 0.6, hint: '放松推进' },
  medium: { label: 'medium', mult: 1, hint: '正常投入' },
  high: { label: 'high', mult: 1.5, hint: '全力以赴（think hard）' },
};

export const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];
export const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high'];

export const FATIGUE_LABELS = ['', '精力充沛', '状态不错', '一般', '有点累', '需要休息'];

/** Token multiplier per fatigue level (index 0 = not reported): tired work costs more. */
export const FATIGUE_MULT = [1, 1, 1.25, 2, 4, 8];

export function fatigueMult(level: number | null | undefined): number {
  return FATIGUE_MULT[level ?? 0] ?? 1;
}

export function ratePerMin(tier: Tier, effort: Effort, fatigue?: number | null): number {
  return TIERS[tier].rate * EFFORTS[effort].mult * fatigueMult(fatigue);
}

/**
 * Tokens of one session. An ended session's total was fixed when it ended (with the
 * fatigue that applied then); a running one is priced at the current fatigue.
 */
export function sessionTokens(s: Pick<Session, 'tier' | 'effort' | 'startedAt' | 'endedAt' | 'tokens'>, now = Date.now(), fatigue?: number | null): number {
  if (s.tokens != null) return s.tokens;
  const end = s.endedAt ?? now;
  return Math.round(((end - s.startedAt) / 60_000) * ratePerMin(s.tier, s.effort, fatigue));
}

/** Tokens per minute a session is charged at: its fixed average once ended, else the live rate. */
function sessionRate(s: Session, fatigue: number | null): number {
  if (s.endedAt != null && s.tokens != null) {
    const mins = (s.endedAt - s.startedAt) / 60_000;
    return mins > 0 ? s.tokens / mins : 0;
  }
  return ratePerMin(s.tier, s.effort, fatigue);
}

export function estimateTokens(tier: Tier, effort: Effort, minutes: number, fatigue?: number | null): number {
  return Math.round(minutes * ratePerMin(tier, effort, fatigue));
}

export function tokensToday(state: Pick<AppState, 'sessions' | 'fatigue'>, now = Date.now()): number {
  const sod = startOfDay(now);
  const fat = latestFatigue(state, now);
  let sum = 0;
  for (const s of state.sessions) {
    const end = s.endedAt ?? now;
    if (end < sod) continue;
    // Count only the part of a session that falls into today.
    const start = Math.max(s.startedAt, sod);
    if (s.endedAt != null && s.tokens != null && s.startedAt >= sod) {
      sum += s.tokens;
    } else {
      sum += Math.round(((end - start) / 60_000) * sessionRate(s, fat));
    }
  }
  return sum;
}

/** Whether a session/task runs on this device. Untagged (older) ones count as this device's. */
export const onThisDevice = (tag: string | undefined, state: Pick<AppState, 'ui'>) => !tag || !state.ui.deviceId || tag === state.ui.deviceId;

/** This device's running session. Other devices may run their own at the same time. */
export function activeSession(state: Pick<AppState, 'sessions' | 'ui'>): Session | undefined {
  return state.sessions.find((s) => s.endedAt == null && onThisDevice(s.device, state));
}

/** Sessions running on other devices right now (shown, never silently ended). */
export function otherSessions(state: Pick<AppState, 'sessions' | 'ui'>): Session[] {
  return state.sessions.filter((s) => s.endedAt == null && !onThisDevice(s.device, state));
}

export function latestFatigue(state: Pick<AppState, 'fatigue'>, now = Date.now()): number | null {
  const sod = startOfDay(now);
  const today = state.fatigue.filter((f) => f.at >= sod);
  return today.length ? today[today.length - 1].level : null;
}

export type BudgetLevel = 'ok' | 'warn' | 'low' | 'over';

export function budgetLevel(used: number, budget: number): BudgetLevel {
  if (budget <= 0) return 'ok';
  const left = 1 - used / budget;
  if (left <= 0) return 'over';
  if (left <= 0.15) return 'low';
  if (left <= 0.4) return 'warn';
  return 'ok';
}

/** Gentle suggestion combining budget and self-reported fatigue. */
export function hieAdvice(used: number, budget: number, fatigue: number | null): string | null {
  const lvl = budgetLevel(used, budget);
  if (lvl === 'over') return '今日预算已用完。可以收尾：/compact 留下上下文，明天继续。';
  if (fatigue != null && fatigue >= 5) return '你标记了需要休息。建议切到 Haiku 档或直接休息。';
  if (lvl === 'low') return '预算即将用完，建议 /compact 保存进度。';
  if (fatigue != null && fatigue >= 4) return '有点累了：试试 /model haiku 或 /effort low。';
  return null;
}

/** Tokens of a run so far; `fatigue` previews the total if the run ended now at that level. */
export function runSegmentsTokens(state: Pick<AppState, 'sessions' | 'fatigue'>, runId: string, now = Date.now(), fatigue?: number | null): number {
  const fat = fatigue || latestFatigue(state, now);
  return state.sessions.filter((s) => s.runId === runId).reduce((a, s) => a + sessionTokens(s, now, fat), 0);
}

export function runStartedAt(state: Pick<AppState, 'sessions'>, runId: string): number {
  return Math.min(...state.sessions.filter((s) => s.runId === runId).map((s) => s.startedAt));
}

/** Milliseconds between two timestamps that fall inside focus sessions. */
export function focusedMsBetween(state: Pick<AppState, 'sessions'>, from: number, to: number): number {
  let sum = 0;
  for (const s of state.sessions) {
    const a = Math.max(from, s.startedAt);
    const b = Math.min(to, s.endedAt ?? to);
    if (b > a) sum += b - a;
  }
  return sum;
}

/** HIE tokens spent between two timestamps (overlap with focus sessions). */
export function tokensBetween(state: Pick<AppState, 'sessions' | 'fatigue'>, from: number, to: number): number {
  const fat = latestFatigue(state, to);
  let sum = 0;
  for (const s of state.sessions) {
    const a = Math.max(from, s.startedAt);
    const b = Math.min(to, s.endedAt ?? to);
    if (b > a) sum += ((b - a) / 60_000) * sessionRate(s, fat);
  }
  return Math.round(sum);
}
