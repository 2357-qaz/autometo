// Data model helpers: empty state, validation/migration of stored JSON, selectors.
import type { AppState, Goal, LogEntry, Plan, Tier, Workspace } from './types';

export function emptyState(now = Date.now()): AppState {
  return {
    version: 1,
    plans: [],
    goals: [],
    sessions: [],
    compacts: [],
    fatigue: [],
    settings: { dailyBudget: 200_000 },
    hie: { tier: 'sonnet', effort: 'medium' },
    ui: {
      mode: 'plan',
      activePlanId: null,
      activeGoalId: null,
      lastSeenAt: now,
      dismissedCompactId: null,
      deviceId: Math.random().toString(36).slice(2, 10),
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate + normalize unknown JSON into AppState. Throws with a readable message. */
export function normalize(raw: unknown): AppState {
  if (!isObj(raw)) throw new Error('不是有效的 AuTomeDo 数据（根节点不是对象）');
  if (raw.version === undefined) throw new Error('这不是 AuTomeDo 的备份文件');
  if (raw.version !== 1) throw new Error(`不支持的数据版本：${String(raw.version)}`);
  for (const k of ['plans', 'goals', 'sessions', 'compacts'] as const) {
    if (!Array.isArray(raw[k])) throw new Error(`缺少字段：${k}`);
  }
  const base = emptyState();
  // Sync bookkeeping belongs to a device, never to imported/exported data.
  const { syncMeta: _ignored, writeSeq: _seq, ...rest } = raw as Record<string, unknown>;
  void _ignored;
  void _seq;
  const s = rest as unknown as AppState;
  const plans = s.plans.map((p) => ({ ...p, phases: p.phases ?? [], tasks: p.tasks ?? [], versions: p.versions ?? [], log: migrateLog(p.log) }));
  const goals = s.goals.map((g) => ({
    ...g,
    moves: g.moves ?? [],
    checkpoints: g.checkpoints ?? [],
    log: migrateLog(g.log),
    cadenceDays: g.cadenceDays || 7,
  }));
  for (const w of [...plans, ...goals]) {
    if (typeof w.id !== 'string' || typeof w.title !== 'string') throw new Error('Plan/Goal 缺少 id 或 title');
  }
  const sessions = s.sessions.map((x) => ({ ...x, runId: x.runId ?? x.id, tier: migrateTier(x.tier) }));
  return {
    ...base,
    ...s,
    plans,
    goals,
    sessions,
    fatigue: Array.isArray(s.fatigue) ? s.fatigue : [],
    settings: { ...base.settings, ...(isObj(s.settings) ? s.settings : {}) },
    hie: { ...base.hie, ...(isObj(s.hie) ? s.hie : {}), tier: migrateTier(isObj(s.hie) ? s.hie.tier : undefined) },
    ui: { ...base.ui, ...(isObj(s.ui) ? s.ui : {}) },
  };
}

// Logs before the structured Execution Log only had { kind, text }.
const KIND_TO_TYPE: Record<string, LogEntry['type']> = { create: 'create', revise: 'revise', note: 'note', checkpoint: 'checkpoint', compact: 'compact' };
function migrateLog(log: unknown): LogEntry[] {
  if (!Array.isArray(log)) return [];
  let prev = 0;
  return log.map((e: Record<string, unknown>) => {
    const entry = e.type ? ({ ...e } as unknown as LogEntry) : ({ id: String(e.id), at: Number(e.at), text: String(e.text ?? ''), type: KIND_TO_TYPE[String(e.kind)] ?? 'legacy' } as LogEntry);
    // Older data can have several events in the same millisecond; keep their order explicit.
    entry.at = Math.max(entry.at, prev + 1);
    prev = entry.at;
    return entry;
  });
}

// Tier names changed from lite/core/deep to haiku/sonnet/opus.
const TIER_ALIAS: Record<string, Tier> = { lite: 'haiku', core: 'sonnet', deep: 'opus', haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };
function migrateTier(t: unknown): Tier {
  return (typeof t === 'string' && TIER_ALIAS[t]) || 'sonnet';
}

export function findWs(s: AppState, id: string | null | undefined): Workspace | undefined {
  if (!id) return undefined;
  return s.plans.find((p) => p.id === id) ?? s.goals.find((g) => g.id === id);
}

export function activePlan(s: AppState): Plan | undefined {
  return s.plans.find((p) => p.id === s.ui.activePlanId);
}

export function activeGoal(s: AppState): Goal | undefined {
  return s.goals.find((g) => g.id === s.ui.activeGoalId);
}

export function currentWs(s: AppState): Workspace | undefined {
  return s.ui.mode === 'plan' ? activePlan(s) : activeGoal(s);
}
