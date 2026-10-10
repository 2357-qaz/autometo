// File storage under ~/.automedo (override with AUTOMEDO_HOME).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyState, normalize, type AppState, type PersistAdapter, type SyncConfig, type SyncMeta, type SyncStorage } from '@automedo/core';

export function homeDir(): string {
  return process.env.AUTOMEDO_HOME || join(homedir(), '.automedo');
}

const file = (name: string) => join(homeDir(), name);

function ensureDir() {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
}

/** Write via temp file + rename so a crash never leaves half a file behind. */
function writeAtomic(path: string, data: string, mode = 0o600) {
  ensureDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export interface Loaded {
  state: AppState;
  error: string | null;
}

export function loadState(): Loaded {
  const path = file('state.json');
  if (!existsSync(path)) return { state: emptyState(), error: null };
  const raw = readFileSync(path, 'utf8');
  try {
    return { state: normalize(JSON.parse(raw)), error: null };
  } catch (e) {
    const backup = `${path}.corrupt.${Date.now()}`;
    writeAtomic(backup, raw);
    return { state: emptyState(), error: `数据文件读取失败：${(e as Error).message}。原文件已备份到 ${backup}` };
  }
}

let lastWrite = 0;

export const filePersist: PersistAdapter = {
  save(state) {
    writeAtomic(file('state.json'), JSON.stringify(state));
    lastWrite = statSync(file('state.json')).mtimeMs;
  },
};

/** Call `onChange` when another process (e.g. `automedo done`) rewrote the data file. */
export function watchState(onChange: () => void): () => void {
  ensureDir();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const w = watch(homeDir(), (_ev, name) => {
    if (name !== 'state.json') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        if (statSync(file('state.json')).mtimeMs > lastWrite + 1) onChange();
      } catch {
        /* file briefly missing during rename */
      }
    }, 120);
  });
  return () => w.close();
}

export const fileSyncStorage: SyncStorage = {
  loadConfig: () => readJson<SyncConfig>(file('sync.json')),
  saveConfig: (c) => (c ? writeAtomic(file('sync.json'), JSON.stringify(c, null, 2)) : rmSync(file('sync.json'), { force: true })),
  loadMeta: () => readJson<SyncMeta>(file('sync-meta.json')),
  saveMeta: (m) => writeAtomic(file('sync-meta.json'), JSON.stringify(m)),
};
