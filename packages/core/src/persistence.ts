// Durable storage for state + sync bookkeeping in ONE document.
//
// The sync cursor/base and the data they describe must hit the disk together:
// a new cursor with old data would make stale records look like local edits
// (and push them over newer versions, or resurrect deleted ones). Writing both
// in a single atomic write — one localStorage key, or one file renamed into
// place — makes that write the commit point of a sync round.
import { emptyState, normalize } from './state';
import type { PersistAdapter, Store } from './store';
import type { SyncMeta } from './sync';
import type { AppState } from './types';

export interface DocIO {
  read(): string | null;
  /** Must replace the whole document atomically (or throw). */
  write(text: string): void;
}

export interface DocPersistence {
  /** Parsed state (sync meta stripped), or an error after which the caller should back up `raw`. */
  load(): { state: AppState; error: string | null; raw: string | null };
  persist: PersistAdapter;
  loadMeta(): SyncMeta | null;
  /** Persist meta *together with the store's current state*, in one write. */
  saveMeta(m: SyncMeta): void;
  /** Bind the store whose state is written alongside the meta. */
  attach(store: Store): void;
  /** Re-read after another process changed the document; returns the fresh state. */
  reload(): AppState | null;
}

type Doc = AppState & { syncMeta?: SyncMeta };

export function createDocPersistence(io: DocIO, legacyMeta?: () => SyncMeta | null): DocPersistence {
  let meta: SyncMeta | null = null;
  let store: Store | null = null;
  const serialize = (state: AppState) => JSON.stringify(meta ? { ...state, syncMeta: meta } : state);
  const parse = (raw: string) => {
    const doc = JSON.parse(raw) as Doc;
    const { syncMeta, ...rest } = doc;
    return { state: normalize(rest), meta: syncMeta ?? null };
  };

  return {
    load() {
      const raw = io.read();
      if (!raw) {
        meta = legacyMeta?.() ?? null;
        return { state: emptyState(), error: null, raw: null };
      }
      try {
        const p = parse(raw);
        // Older versions kept the meta elsewhere; adopt it once, then it lives in the doc.
        meta = p.meta ?? legacyMeta?.() ?? null;
        return { state: p.state, error: null, raw };
      } catch (e) {
        return { state: emptyState(), error: (e as Error).message, raw };
      }
    },
    persist: {
      save(state) {
        io.write(serialize(state));
      },
    },
    loadMeta: () => meta,
    saveMeta(m) {
      meta = m;
      if (store) io.write(serialize(store.get()));
    },
    attach(s) {
      store = s;
    },
    reload() {
      const raw = io.read();
      if (!raw) return null;
      try {
        const p = parse(raw);
        meta = p.meta ?? meta;
        return p.state;
      } catch {
        return null;
      }
    },
  };
}
