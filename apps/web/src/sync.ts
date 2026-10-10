// Browser wiring for the shared SyncClient: localStorage-backed config/meta + window events.
import { useSyncExternalStore } from 'react';
import { SyncClient, type Store, type SyncConfig, type SyncMeta, type SyncStatus, type SyncStorage } from '@automedo/core';

const CONFIG_KEY = 'automedo.sync.config';
const META_KEY = 'automedo.sync.meta';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const storage: SyncStorage = {
  loadConfig: () => read<SyncConfig>(CONFIG_KEY),
  saveConfig: (c) => (c ? localStorage.setItem(CONFIG_KEY, JSON.stringify(c)) : localStorage.removeItem(CONFIG_KEY)),
  loadMeta: () => read<SyncMeta>(META_KEY),
  saveMeta: (m) => localStorage.setItem(META_KEY, JSON.stringify(m)),
};

export function createBrowserSync(store: Store): SyncClient {
  const client = new SyncClient(store, storage);
  client.start();
  const kick = () => client.getStatus().phase !== 'off' && void client.syncNow();
  window.addEventListener('online', kick);
  window.addEventListener('focus', kick);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick());
  return client;
}

export function useSyncStatus(client: SyncClient): SyncStatus {
  return useSyncExternalStore(
    (l) => client.subscribe(l),
    () => client.getStatus(),
    () => client.getStatus(),
  );
}
