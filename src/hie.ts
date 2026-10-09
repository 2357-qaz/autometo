// Human Inference Engine — a playful metaphor for personal effort budgeting.
// "Tokens" here are NOT a measurement of brain power or fatigue.
import type { AppState, Effort, Session, Tier } from './types';
import { startOfDay } from './util';

export const TIERS: Record<Tier, { label: string; rate: number; hint: string }> = {
  lite: { label: 'Lite', rate: 400, hint: '轻量：回复消息、整理、杂事' },
  core: { label: 'Core', rate: 800, hint: '常规：日常推进、写作、编码' },
  deep: { label: 'Deep', rate: 1500, hint: '深度：难题、设计、需要整块专注' },
};

export const EFFORTS: Record<Effort, { label: string; mult: number; hint: string }> = {
  low: { label: 'low', mult: 0.6, hint: '放松推进' },
  medium: { label: 'medium', mult: 1, hint: '正常投入' },
  high: { label: 'high', mult: 1.5, hint: '全力以赴（think hard）' },
};

export const TIER_ORDER: Tier[] = ['lite', 'core', 'deep'];
export const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high'];

export const FATIGUE_LABELS = ['', '精力充沛', '状态不错', '一般', '有点累', '需要休息'];

export function ratePerMin(tier: Tier, effort: Effort): number {
  return TIERS[tier].rate * EFFORTS[effort].mult;
}

export function sessionTokens(s: Pick<Session, 'tier' | 'effort' | 'startedAt' | 'endedAt' | 'tokens'>, now = Date.now()): number {
  if (s.tokens != null) return s.tokens;
  const end = s.endedAt ?? now;
  return Math.round(((end - s.startedAt) / 60_000) * ratePerMin(s.tier, s.effort));
}

export function estimateTokens(tier: Tier, effort: Effort, minutes: number): number {
  return Math.round(minutes * ratePerMin(tier, effort));
}

export function tokensToday(state: Pick<AppState, 'sessions'>, now = Date.now()): number {
  const sod = startOfDay(now);
  let sum = 0;
  for (const s of state.sessions) {
    const end = s.endedAt ?? now;
    if (end < sod) continue;
    // Count only the part of a session that falls into today.
    const start = Math.max(s.startedAt, sod);
    if (s.endedAt != null && s.tokens != null && s.startedAt >= sod) {
      sum += s.tokens;
    } else {
      sum += Math.round(((end - start) / 60_000) * ratePerMin(s.tier, s.effort));
    }
  }
  return sum;
}

export function activeSession(state: Pick<AppState, 'sessions'>): Session | undefined {
  return state.sessions.find((s) => s.endedAt == null);
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
  if (fatigue != null && fatigue >= 5) return '你标记了需要休息。建议切到 Lite 档或直接休息。';
  if (lvl === 'low') return '预算即将用完，建议 /compact 保存进度。';
  if (fatigue != null && fatigue >= 4) return '有点累了：试试 /model lite 或 /effort low。';
  return null;
}

export function runSegmentsTokens(state: Pick<AppState, 'sessions'>, runId: string, now = Date.now()): number {
  return state.sessions.filter((s) => s.runId === runId).reduce((a, s) => a + sessionTokens(s, now), 0);
}

export function runStartedAt(state: Pick<AppState, 'sessions'>, runId: string): number {
  return Math.min(...state.sessions.filter((s) => s.runId === runId).map((s) => s.startedAt));
}
