// Weekly review: what got done, where plans drifted and why, where the time and tokens
// went, and how effort related to fatigue. Rule-based over the Execution Log and the
// HIE sessions — no LLM involved.
import { sessionUsage, TIER_ORDER, TIERS } from './hie';
import type { AppState, EventType, LogEntry, Tier, Verdict, Workspace } from './types';
import { DAY, fmtDate, fmtSpan, fmtTokens, startOfDay } from './util';

export interface ReviewRange {
  from: number;
  to: number;
  /** 0 = this week, -1 = last week, … */
  offset: number;
}

export interface ReviewTotals {
  done: number;
  added: number;
  deferred: number;
  blocked: number;
  revised: number;
  focusMs: number;
  tokens: number;
  sessions: number;
  /** Days with any focus session or completed task. */
  activeDays: number;
}

export interface ReviewDay {
  start: number;
  focusMs: number;
  tokens: number;
  /** Highest fatigue reported that day (null: none). */
  fatigue: number | null;
  done: number;
  overBudget: boolean;
}

export interface ReviewWorkspace {
  id: string;
  kind: 'plan' | 'goal';
  title: string;
  done: string[];
  added: number;
  focusMs: number;
  tokens: number;
  /** Goals: checkpoints of the week (oldest first). */
  checkpoints: { at: number; progress: number; verdict: Verdict }[];
}

export interface ReviewDrift {
  at: number;
  ws: string;
  type: Extract<EventType, 'revise' | 'defer' | 'block' | 'skip' | 'remove'>;
  title: string;
  reason?: string;
  detail?: string;
}

export interface Review {
  range: ReviewRange;
  totals: ReviewTotals;
  /** Same totals for the week before, to compare with. */
  previous: ReviewTotals;
  days: ReviewDay[];
  workspaces: ReviewWorkspace[];
  drift: ReviewDrift[];
  /** Focused time per tier. */
  tiers: Record<Tier, number>;
  /** Ended sessions: actual vs planned duration (1 = on plan). Null without any. */
  overrun: number | null;
  insights: string[];
  budget: number;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Monday 00:00 → next Monday 00:00 (local time), `offset` weeks from the current one. */
export function weekRange(offset = 0, now = Date.now()): ReviewRange {
  const today = startOfDay(now);
  const back = (new Date(today).getDay() + 6) % 7; // days since Monday
  // Step by calendar days (not 7 × 24 h), so daylight-saving changes don't shift the week.
  const monday = new Date(today);
  monday.setDate(monday.getDate() - back + offset * 7);
  const next = new Date(monday);
  next.setDate(next.getDate() + 7);
  return { from: monday.getTime(), to: next.getTime(), offset };
}

const DRIFT = new Set<EventType>(['revise', 'defer', 'block', 'skip', 'remove']);

function events(state: AppState, from: number, to: number): { ws: Workspace; e: LogEntry }[] {
  const out: { ws: Workspace; e: LogEntry }[] = [];
  for (const ws of [...state.plans, ...state.goals]) for (const e of ws.log) if (e.at >= from && e.at < to) out.push({ ws, e });
  return out.sort((a, b) => a.e.at - b.e.at);
}

/** Day by day (calendar days, so daylight-saving changes don't matter). */
function dayStats(state: AppState, from: number, to: number, now: number): ReviewDay[] {
  const evs = events(state, from, to);
  const out: ReviewDay[] = [];
  for (let d = new Date(from); d.getTime() < to; d.setDate(d.getDate() + 1)) {
    const start = d.getTime();
    const end = new Date(start).setDate(new Date(start).getDate() + 1);
    const usage = sessionUsage(state, start, end, now);
    const tokens = usage.reduce((a, u) => a + u.tokens, 0);
    const marks = state.fatigue.filter((f) => f.at >= start && f.at < end).map((f) => f.level);
    out.push({
      start,
      focusMs: usage.reduce((a, u) => a + u.ms, 0),
      tokens,
      fatigue: marks.length ? Math.max(...marks) : null,
      done: evs.filter((x) => x.e.type === 'done' && x.e.at >= start && x.e.at < end).length,
      overBudget: tokens > state.settings.dailyBudget,
    });
  }
  return out;
}

function totals(state: AppState, from: number, to: number, now: number): ReviewTotals {
  const evs = events(state, from, to);
  const count = (t: EventType) => evs.filter((x) => x.e.type === t).length;
  const usage = sessionUsage(state, from, to, now);
  const days = dayStats(state, from, to, now).filter((d) => d.focusMs > 0 || d.done > 0);
  return {
    done: count('done'),
    added: count('add'),
    deferred: count('defer'),
    blocked: count('block'),
    revised: count('revise'),
    focusMs: usage.reduce((a, u) => a + u.ms, 0),
    tokens: usage.reduce((a, u) => a + u.tokens, 0),
    sessions: new Set(usage.map((u) => u.s.runId ?? u.s.id)).size,
    activeDays: days.length,
  };
}

export function generateReview(state: AppState, offset = 0, now = Date.now()): Review {
  const range = weekRange(offset, now);
  const { from, to } = range;
  const budget = state.settings.dailyBudget;
  const evs = events(state, from, to);

  const days = dayStats(state, from, to, now);

  const usage = sessionUsage(state, from, to, now);
  const workspaces: ReviewWorkspace[] = [];
  for (const ws of [...state.plans, ...state.goals]) {
    const mine = evs.filter((x) => x.ws.id === ws.id);
    const u = usage.filter((x) => x.s.wsId === ws.id);
    const checkpoints = ws.kind === 'goal' ? ws.checkpoints.filter((c) => c.at >= from && c.at < to).map((c) => ({ at: c.at, progress: c.progress, verdict: c.verdict })) : [];
    const w: ReviewWorkspace = {
      id: ws.id,
      kind: ws.kind,
      title: ws.title,
      done: mine.filter((x) => x.e.type === 'done').map((x) => x.e.title ?? x.e.text),
      added: mine.filter((x) => x.e.type === 'add').length,
      focusMs: u.reduce((a, x) => a + x.ms, 0),
      tokens: u.reduce((a, x) => a + x.tokens, 0),
      checkpoints,
    };
    if (w.done.length || w.added || w.focusMs || checkpoints.length || mine.some((x) => DRIFT.has(x.e.type))) workspaces.push(w);
  }
  workspaces.sort((a, b) => b.tokens - a.tokens || b.done.length - a.done.length);

  const drift: ReviewDrift[] = evs
    .filter((x) => DRIFT.has(x.e.type))
    .map((x) => ({ at: x.e.at, ws: x.ws.title, type: x.e.type as ReviewDrift['type'], title: x.e.title ?? x.e.text, reason: x.e.reason, detail: x.e.detail }));

  const tiers = Object.fromEntries(TIER_ORDER.map((t) => [t, 0])) as Record<Tier, number>;
  for (const u of usage) tiers[u.s.tier] += u.ms;

  // Ended runs that started this week: how long they took vs what was planned.
  const runs = new Map<string, { planned: number; ms: number; open: boolean }>();
  for (const s of state.sessions) {
    const id = s.runId ?? s.id;
    const r = runs.get(id) ?? { planned: s.plannedMin * 60_000, ms: 0, open: false };
    r.ms += (s.endedAt ?? now) - s.startedAt;
    if (s.endedAt == null) r.open = true;
    runs.set(id, r);
  }
  const startedHere = new Set(state.sessions.filter((s) => s.startedAt >= from && s.startedAt < to).map((s) => s.runId ?? s.id));
  const ended = [...runs].filter(([id, r]) => startedHere.has(id) && !r.open && r.planned > 0).map(([, r]) => r.ms / r.planned);
  const overrun = ended.length ? ended.reduce((a, b) => a + b, 0) / ended.length : null;

  const review: Review = {
    range,
    totals: totals(state, from, to, now),
    previous: totals(state, weekRange(offset - 1, now).from, from, now),
    days,
    workspaces,
    drift,
    tiers,
    overrun,
    insights: [],
    budget,
  };
  review.insights = insights(review, evs);
  return review;
}

const weekday = (t: number) => WEEKDAYS[new Date(t).getDay()];

/** A few things worth noticing, most important first. Phrased as observations, not verdicts. */
function insights(r: Review, evs: { ws: Workspace; e: LogEntry }[]): string[] {
  const out: string[] = [];
  // The same task pushed back again and again.
  const deferrals = new Map<string, { n: number; title: string }>();
  for (const x of evs) {
    if (x.e.type !== 'defer' || !x.e.taskId) continue;
    const d = deferrals.get(x.e.taskId) ?? { n: 0, title: x.e.title ?? '' };
    d.n += 1;
    deferrals.set(x.e.taskId, d);
  }
  const most = [...deferrals.values()].sort((a, b) => b.n - a.n)[0];
  if (most && most.n >= 2) out.push(`「${most.title}」被延期了 ${most.n} 次：拆小一点，或者确认它还该不该做`);
  // Scope growing faster than it is done.
  for (const w of r.workspaces) {
    if (w.kind === 'plan' && w.added >= w.done.length + 3) out.push(`「${w.title}」新增 ${w.added} 项、完成 ${w.done.length} 项：范围在扩大，值得 /revise 一下阶段目标`);
  }
  // Tired but still pushing hard.
  const strained = r.days.filter((d) => d.fatigue != null && d.fatigue >= 4 && d.tokens >= r.budget * 0.8);
  if (strained.length) out.push(`${strained.map((d) => weekday(d.start)).join('、')}疲劳 ≥4 时仍用了八成以上预算：累的时候试试 Haiku 档或 low 强度`);
  const over = r.days.filter((d) => d.overBudget).length;
  if (over >= 2) out.push(`${over} 天超出每日预算（${fmtTokens(r.budget)}）：预算偏紧，或者节奏偏满`);
  if (r.overrun != null && r.overrun >= 1.3) out.push(`Session 平均用了计划时长的 ${Math.round(r.overrun * 100)}%：开始时多估一点`);
  const focus = TIER_ORDER.reduce((a, t) => a + r.tiers[t], 0);
  const deep = r.tiers.opus + r.tiers.fable;
  if (focus > 3 * 3_600_000 && deep / focus > 0.6) out.push(`${Math.round((deep / focus) * 100)}% 的专注时间在 Opus / Fable 档：不是所有事都需要最高档`);
  for (const w of r.workspaces) {
    const bad = w.checkpoints.filter((c) => c.verdict === 'blocked' || c.verdict === 'drifting');
    if (bad.length) out.push(`目标「${w.title}」的 Checkpoint 判断为${bad[bad.length - 1].verdict === 'blocked' ? '受阻' : '偏离'}：下一步行动还清楚吗？`);
  }
  if (!r.totals.focusMs && !r.totals.done) out.push('这一周没有专注记录也没有完成任务：休息也是计划的一部分');
  return out.slice(0, 5);
}

const VERDICT: Record<Verdict, string> = { 'on-track': '顺利', drifting: '偏离', blocked: '受阻', pivot: '转向' };
const DRIFT_LABEL: Record<ReviewDrift['type'], string> = { revise: '修正', defer: '延期', block: '阻塞', skip: '跳过', remove: '移除' };
export const reviewLabels = { verdict: VERDICT, drift: DRIFT_LABEL, weekday };

/** "本周" / "上周" / "10-06 – 10-12". */
export function reviewTitle(r: Review): string {
  const span = `${fmtDate(r.range.from).slice(5)} – ${fmtDate(r.range.to - DAY).slice(5)}`;
  return r.range.offset === 0 ? `本周 ${span}` : r.range.offset === -1 ? `上周 ${span}` : span;
}

/** Signed difference to last week, e.g. "+3" / "−1" / "持平". */
export function delta(now: number, before: number, fmt: (n: number) => string = String): string {
  if (now === before) return '持平';
  return now > before ? `+${fmt(now - before)}` : `−${fmt(before - now)}`;
}

/** The review as Markdown (to copy into notes). */
export function reviewMarkdown(r: Review): string {
  const t = r.totals;
  const p = r.previous;
  const out: string[] = [`# 周回顾 · ${reviewTitle(r)}`, ''];
  out.push(
    `完成 ${t.done} 项（${delta(t.done, p.done)}）· 专注 ${fmtSpan(t.focusMs)}（${delta(t.focusMs, p.focusMs, fmtSpan)}）· ${fmtTokens(t.tokens)} tokens · ${t.activeDays} 天有投入`,
  );
  if (r.insights.length) out.push('', '## 值得注意', ...r.insights.map((x) => `- ${x}`));
  out.push('', '## 每天', '| 日 | 专注 | tokens | 疲劳 | 完成 |', '|---|---|---|---|---|');
  for (const d of r.days) out.push(`| ${weekday(d.start)} ${fmtDate(d.start).slice(5)} | ${d.focusMs ? fmtSpan(d.focusMs) : '–'} | ${d.tokens ? fmtTokens(d.tokens) : '–'}${d.overBudget ? ' ⚠' : ''} | ${d.fatigue ?? '–'} | ${d.done || '–'} |`);
  if (r.workspaces.length) {
    out.push('', '## 计划与目标');
    for (const w of r.workspaces) {
      out.push('', `### ${w.title}`, `${w.focusMs ? `专注 ${fmtSpan(w.focusMs)} · ${fmtTokens(w.tokens)} tokens · ` : ''}完成 ${w.done.length}${w.added ? ` · 新增 ${w.added}` : ''}`);
      for (const d of w.done) out.push(`- ✓ ${d}`);
      for (const c of w.checkpoints) out.push(`- Checkpoint ${fmtDate(c.at).slice(5)}：${c.progress}% · ${VERDICT[c.verdict]}`);
    }
  }
  if (r.drift.length) {
    out.push('', '## 偏离与修正');
    for (const d of r.drift) out.push(`- ${weekday(d.at)} ${DRIFT_LABEL[d.type]}「${d.title}」（${d.ws}）${d.reason ? `：${d.reason}` : ''}`);
  }
  const focus = TIER_ORDER.reduce((a, t) => a + r.tiers[t], 0);
  if (focus) {
    out.push('', '## 投入方式', `档位：${TIER_ORDER.filter((x) => r.tiers[x]).map((x) => `${TIERS[x].label} ${fmtSpan(r.tiers[x])}`).join(' · ')}`);
    if (r.overrun != null) out.push(`Session 实际用时为计划的 ${Math.round(r.overrun * 100)}%`);
  }
  return out.join('\n');
}
