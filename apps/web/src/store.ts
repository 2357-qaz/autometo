// Browser glue for the core store: one localStorage document (state + sync meta) + React subscription.
import { useSyncExternalStore } from 'react';
import { createDocPersistence, createStore, emptyState, type AppState, type Store, type SyncMeta } from '@automedo/core';

export const STORAGE_KEY = 'automedo.v0';
/** Where versions before the single-document format kept the sync meta. */
export const LEGACY_META_KEY = 'automedo.sync.meta';

function legacyMeta(): SyncMeta | null {
  try {
    const raw = localStorage.getItem(LEGACY_META_KEY);
    return raw ? (JSON.parse(raw) as SyncMeta) : null;
  } catch {
    return null;
  }
}

// State and sync meta share ONE key, so a sync is committed by a single atomic setItem.
export const persistence = createDocPersistence(
  {
    read: () => localStorage.getItem(STORAGE_KEY),
    write: (t) => localStorage.setItem(STORAGE_KEY, t),
  },
  legacyMeta,
);

export interface LoadResult {
  state: AppState;
  error: string | null;
}

export function loadFromStorage(): LoadResult {
  let loaded: ReturnType<typeof persistence.load>;
  try {
    loaded = persistence.load();
  } catch {
    return { state: emptyState(), error: '无法访问浏览器本地存储（可能处于隐私模式）。本次修改不会被保存。' };
  }
  if (!loaded.error) return { state: loaded.state, error: null };
  // Keep the broken payload so nothing is lost silently.
  const backupKey = `${STORAGE_KEY}.corrupt.${Date.now()}`;
  try {
    if (loaded.raw) localStorage.setItem(backupKey, loaded.raw);
  } catch {
    /* ignore */
  }
  return { state: emptyState(), error: `本地数据读取失败：${loaded.error}。原始数据已备份到 ${backupKey}。` };
}

export function createBrowserStore(initial: AppState): Store {
  const store = createStore(initial, persistence.persist);
  persistence.attach(store);
  window.addEventListener('beforeunload', () => store.flush());
  return store;
}

export function useStore(store: Store): AppState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
