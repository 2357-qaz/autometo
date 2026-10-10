// Browser glue for the core store: localStorage persistence + React subscription.
import { useSyncExternalStore } from 'react';
import { createStore, emptyState, normalize, type AppState, type Store } from '@automedo/core';

export const STORAGE_KEY = 'automedo.v0';

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

export function createBrowserStore(initial: AppState): Store {
  const store = createStore(initial, { save: (s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) });
  window.addEventListener('beforeunload', () => store.flush());
  return store;
}

export function useStore(store: Store): AppState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
