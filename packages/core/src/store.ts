// Framework-agnostic state container with undo. Persistence is injected so the
// same store runs in the browser (localStorage), the terminal (file) or tests (none).
//
// Every local edit is also described at record level (see sync.ts): sync stamps those
// changes with revisions, and undo reverts exactly the records an edit touched — never
// whatever arrived from other devices in the meantime.
import { lanesStale, syncLanes } from './ops';
import { compose, decompose, diffRecords, sameRec, type Rec, type RecordChange } from './sync';
import type { AppState } from './types';

const UNDO_LIMIT = 50;

export interface PersistAdapter {
  /**
   * Write the full state. Throw to report a failure (shown to the user). May return
   * the state actually written (merged with another writer's changes): it is adopted.
   */
  save(state: AppState): AppState | void;
}

type Listener = () => void;

export interface UndoResult {
  label: string;
  /** Records restored. */
  undone: number;
  /** Records left alone because they changed since (on another device, by sync). */
  skipped: number;
}

export interface Store {
  get(): AppState;
  /** Apply a mutation on a cloned draft. A non-null label makes it undoable. */
  mutate<R>(label: string | null, fn: (d: AppState) => R): R;
  replace(next: AppState, label: string): void;
  /**
   * Install state that is not a local edit — merged from the server, or reloaded after
   * another process wrote the file. No undo entry, not recorded as an edit, and not by
   * itself a reason to save (the caller persists it, or it already is on disk).
   */
  applyExternal(next: AppState): void;
  /** Revert the last undoable edit, record by record, where nothing changed since. */
  undo(): UndoResult | null;
  canUndo(): boolean;
  subscribe(l: Listener): () => void;
  /** Local edits at record level, as they happen (before the state is saved). */
  onLocalChange(l: (changes: RecordChange[]) => void): () => void;
  saveError(): string | null;
  /**
   * Write any pending change immediately (e.g. before the page/process exits).
   * Returns false if it could not be written (see saveError); it stays pending.
   */
  flush(): boolean;
}

interface UndoEntry {
  label: string;
  changes: RecordChange[];
  ui: AppState['ui'];
}

export function createStore(initial: AppState, persist?: PersistAdapter, debounceMs = 150): Store {
  let state = initial;
  let recs: Map<string, Rec> = decompose(initial);
  let saveErr: string | null = null;
  const undo: UndoEntry[] = [];
  const listeners = new Set<Listener>();
  const localListeners = new Set<(changes: RecordChange[]) => void>();
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
      const written = persist.save(state);
      if (written && written !== state) {
        state = written; // merged with another writer's changes
        recs = decompose(written);
      }
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
  const set = (next: AppState, nextRecs: Map<string, Rec>) => {
    state = next;
    recs = nextRecs;
    listeners.forEach((l) => l());
    scheduleSave();
  };
  /** A local edit: tell the recorders first, so their bookkeeping is saved with the state. */
  const commitLocal = (next: AppState): RecordChange[] => {
    const nextRecs = decompose(next);
    const changes = diffRecords(recs, nextRecs);
    if (changes.length) localListeners.forEach((l) => l(changes));
    set(next, nextRecs);
    return changes;
  };
  const pushUndo = (e: UndoEntry) => {
    undo.push(e);
    if (undo.length > UNDO_LIMIT) undo.shift();
  };

  const store: Store = {
    get: () => state,
    mutate(label, fn) {
      const draft = structuredClone(state);
      const r = fn(draft);
      syncLanes(draft); // part of the same edit (and of its undo)
      const ui = state.ui;
      const changes = commitLocal(draft);
      if (label) pushUndo({ label, changes, ui });
      return r;
    },
    replace(next, label) {
      const ui = state.ui;
      pushUndo({ label, changes: commitLocal(next), ui });
    },
    applyExternal(next) {
      state = next;
      recs = decompose(next);
      listeners.forEach((l) => l());
      // Another device stopped (or started) one of this device's subtasks: re-price this
      // device's Fable session as a local edit of its own, once the merge is done.
      if (lanesStale(state)) queueMicrotask(() => lanesStale(state) && store.mutate(null, () => {}));
    },
    undo() {
      const e = undo.pop();
      if (!e) return null;
      const cur = new Map(recs);
      let undone = 0;
      let skipped = 0;
      for (const c of e.changes) {
        // Only revert a record still exactly as this edit left it.
        if (!sameRec(cur.get(c.id), c.after)) {
          skipped++;
          continue;
        }
        if (c.before) cur.set(c.id, c.before);
        else cur.delete(c.id);
        undone++;
      }
      const ui = { ...e.ui, lastSeenAt: state.ui.lastSeenAt };
      if (undone) {
        const next = compose(cur.values(), ui);
        syncLanes(next); // a partly skipped undo can leave the lanes and the session apart
        commitLocal(next);
      } else if (!e.changes.length) set({ ...state, ui }, recs); // a UI-only step
      return { label: e.label, undone, skipped };
    },
    canUndo: () => undo.length > 0,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onLocalChange(l) {
      localListeners.add(l);
      return () => localListeners.delete(l);
    },
    saveError: () => saveErr,
    flush() {
      return save();
    },
  };
  return store;
}

/** One line for the UI after an undo. */
export function describeUndo(r: UndoResult | null): { text: string; error: boolean } {
  if (!r) return { text: '没有可撤销的操作', error: true };
  if (r.skipped && !r.undone) return { text: `没能撤销「${r.label}」：相关内容已在其他设备上修改`, error: true };
  if (r.skipped) return { text: `已撤销：${r.label}（${r.skipped} 处已在其他设备上修改，保留未动）`, error: false };
  return { text: `已撤销：${r.label}`, error: false };
}
