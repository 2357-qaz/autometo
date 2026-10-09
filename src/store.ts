import { useSyncExternalStore } from 'react';
import type { AppState, Goal, Plan, Workspace } from './types';

export const STORAGE_KEY = 'automedo.v0';
const UNDO_LIMIT = 50;

export function emptyState(now = Date.now()): AppState {
  return {
    version: 1,
    plans: [],
    goals: [],
    sessions: [],
    compacts: [],
    fatigue: [],
    settings: { dailyBudget: 200_000 },
    hie: { tier: 'core', effort: 'medium' },
    ui: {
      mode: 'plan',
      activePlanId: null,
      activeGoalId: null,
      lastSeenAt: now,
      dismissedCompactId: null,
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
  const s = raw as unknown as AppState;
  const plans = s.plans.map((p) => ({ ...p, phases: p.phases ?? [], tasks: p.tasks ?? [], log: p.log ?? [] }));
  const goals = s.goals.map((g) => ({
    ...g,
    moves: g.moves ?? [],
    checkpoints: g.checkpoints ?? [],
    log: g.log ?? [],
    cadenceDays: g.cadenceDays || 7,
  }));
  for (const w of [...plans, ...goals]) {
    if (typeof w.id !== 'string' || typeof w.title !== 'string') throw new Error('Plan/Goal 缺少 id 或 title');
  }
  const sessions = s.sessions.map((x) => ({ ...x, runId: x.runId ?? x.id }));
  return {
    ...base,
    ...s,
    plans,
    goals,
    sessions,
    fatigue: Array.isArray(s.fatigue) ? s.fatigue : [],
    settings: { ...base.settings, ...(isObj(s.settings) ? s.settings : {}) },
    hie: { ...base.hie, ...(isObj(s.hie) ? s.hie : {}) },
    ui: { ...base.ui, ...(isObj(s.ui) ? s.ui : {}) },
  };
}

export interface LoadResult {
  state: AppState;
  error: string | null;
}

export function loadFromStorage(): LoadResult {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { state: emptyState(), error: '无法访问浏览器本地存储（可能处于隐私模式）。本次修改不会被保存。' };
  }
  if (!raw) return { state: emptyState(), error: null };
  try {
    return { state: normalize(JSON.parse(raw)), error: null };
  } catch (e) {
    // Keep the broken payload so nothing is lost silently.
    const backupKey = `${STORAGE_KEY}.corrupt.${Date.now()}`;
    try {
      localStorage.setItem(backupKey, raw);
    } catch {
      /* ignore */
    }
    return {
      state: emptyState(),
      error: `本地数据读取失败：${(e as Error).message}。原始数据已备份到 ${backupKey}。`,
    };
  }
}

type Listener = () => void;

export interface Store {
  get(): AppState;
  /** Apply a mutation on a cloned draft. Returns the mutator's result. */
  mutate<R>(label: string | null, fn: (d: AppState) => R): R;
  replace(next: AppState, label: string): void;
  undo(): string | null;
  canUndo(): boolean;
  subscribe(l: Listener): () => void;
  saveError(): string | null;
}

export function createStore(initial: AppState, persist = true): Store {
  let state = initial;
  let saveErr: string | null = null;
  const undo: { state: AppState; label: string }[] = [];
  const listeners = new Set<Listener>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    saveTimer = null;
    if (!persist) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveErr = null;
    } catch (e) {
      saveErr = `保存失败：${(e as Error).message}`;
    }
    listeners.forEach((l) => l());
  };
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 150);
  };
  if (persist && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (saveTimer) save();
    });
  }
  const set = (next: AppState) => {
    state = next;
    listeners.forEach((l) => l());
    scheduleSave();
  };

  return {
    get: () => state,
    mutate(label, fn) {
      const draft = structuredClone(state);
      const r = fn(draft);
      if (label) {
        undo.push({ state, label });
        if (undo.length > UNDO_LIMIT) undo.shift();
      }
      set(draft);
      return r;
    },
    replace(next, label) {
      undo.push({ state, label });
      set(next);
    },
    undo() {
      const prev = undo.pop();
      if (!prev) return null;
      // Keep ui-ephemeral fields from current state so undo doesn't jump around too much.
      set({ ...prev.state, ui: { ...prev.state.ui, lastSeenAt: state.ui.lastSeenAt } });
      return prev.label;
    },
    canUndo: () => undo.length > 0,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    saveError: () => saveErr,
  };
}

export function useStore(store: Store): AppState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
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
