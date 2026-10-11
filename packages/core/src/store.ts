// Framework-agnostic state container with undo. Persistence is injected so the
// same store runs in the browser (localStorage), the terminal (file) or tests (none).
import type { AppState } from './types';

const UNDO_LIMIT = 50;

export interface PersistAdapter {
  /** Write the full state. Throw to report a failure (shown to the user). */
  save(state: AppState): void;
}

type Listener = () => void;

export interface Store {
  get(): AppState;
  /** Apply a mutation on a cloned draft. A non-null label makes it undoable. */
  mutate<R>(label: string | null, fn: (d: AppState) => R): R;
  replace(next: AppState, label: string): void;
  undo(): string | null;
  canUndo(): boolean;
  subscribe(l: Listener): () => void;
  saveError(): string | null;
  /**
   * Write any pending change immediately (e.g. before the page/process exits).
   * Returns false if it could not be written (see saveError); it stays pending.
   */
  flush(): boolean;
}

export function createStore(initial: AppState, persist?: PersistAdapter, debounceMs = 150): Store {
  let state = initial;
  let saveErr: string | null = null;
  const undo: { state: AppState; label: string }[] = [];
  const listeners = new Set<Listener>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // `dirty` stays set until a write succeeds: a failed save is retried (with backoff)
  // and by every flush, instead of being forgotten with its timer.
  let dirty = false;
  let failures = 0;

  const save = (): boolean => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!persist || !dirty) return true;
    try {
      persist.save(state);
      dirty = false;
      failures = 0;
      saveErr = null;
    } catch (e) {
      saveErr = `保存失败：${(e as Error).message}`;
      failures += 1;
      saveTimer = setTimeout(save, Math.min(30_000, 1000 * 2 ** (failures - 1)));
      (saveTimer as { unref?: () => void }).unref?.(); // never keep a CLI process alive just to retry
    }
    listeners.forEach((l) => l());
    return !dirty;
  };
  const scheduleSave = () => {
    if (!persist) return;
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, failures ? Math.min(30_000, 1000 * 2 ** (failures - 1)) : debounceMs);
  };
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
      set({ ...prev.state, ui: { ...prev.state.ui, lastSeenAt: state.ui.lastSeenAt } });
      return prev.label;
    },
    canUndo: () => undo.length > 0,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    saveError: () => saveErr,
    flush() {
      return save();
    },
  };
}
