// File storage under ~/.automedo (override with AUTOMEDO_HOME).
// state.json holds the state AND the sync meta, written atomically (temp file + rename),
// so a sync round is committed by a single rename.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDocPersistence, type AppState, type DocPersistence, type Store, type SyncConfig, type SyncMeta, type SyncStorage } from '@automedo/core';

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

/**
 * Cross-process lock around read → merge → write of state.json (a lock file created
 * exclusively). A lock older than 10 s is from a crashed process and is taken over.
 */
function withLock<T>(fn: () => T): T {
  ensureDir();
  const lock = file('state.json.lock');
  const deadline = Date.now() + 5000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) throw new Error('数据文件正被另一个 automedo 进程写入，稍后重试');
      Atomics.wait(nap, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

let lastWrite = 0;
let doc: DocPersistence | null = null;

/** The single state document (created on first use, after AUTOMEDO_HOME is known). */
function persistence(): DocPersistence {
  doc ??= createDocPersistence(
    {
      read: () => (existsSync(file('state.json')) ? readFileSync(file('state.json'), 'utf8') : null),
      write: (t) => {
        writeAtomic(file('state.json'), t);
        lastWrite = statSync(file('state.json')).mtimeMs;
      },
      exclusive: withLock,
    },
    // Versions before the single-document format kept the meta in its own file.
    () => {
      try {
        return readJson<SyncMeta>(file('sync-meta.json'));
      } catch {
        return null;
      }
    },
  );
  return doc;
}

export interface Loaded {
  state: AppState;
  error: string | null;
}

export function loadState(): Loaded {
  const r = persistence().load();
  if (!r.error) return { state: r.state, error: null };
  const backup = `${file('state.json')}.corrupt.${Date.now()}`;
  if (r.raw) writeAtomic(backup, r.raw);
  return { state: r.state, error: `数据文件读取失败：${r.error}。原文件已备份到 ${backup}` };
}

export const filePersist = { save: (s: AppState) => persistence().persist.save(s) };

/** Bind the store whose state is written together with the sync meta. */
export function attachStore(store: Store) {
  persistence().attach(store);
}

/** Another process (e.g. `automedo done`) rewrote the file: merge it with ours (null: nothing new). */
export function reloadState(): AppState | null {
  return persistence().reload();
}

/** Call `onChange` when another process rewrote the data file. */
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
  loadMeta: () => persistence().loadMeta(),
  updateMeta: (fn) => {
    persistence().updateMeta(fn);
    rmSync(file('sync-meta.json'), { force: true }); // migrated into state.json
  },
};
