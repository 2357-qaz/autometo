// Durable storage for state + sync bookkeeping in ONE document.
//
// The sync bookkeeping (revisions, outbox, cursor) and the data it describes must hit
// the disk together: a single atomic write — one localStorage key, or one file renamed
// into place — is the commit point of every edit and every sync round.
import { emptyState, normalize } from './state';
import type { PersistAdapter, Store } from './store';
import { migrateMeta, newSyncMeta, recordLocal, type SyncMeta } from './sync';
import type { AppState } from './types';
import { repairDuplicateIds } from './validate';

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
  /** Change the meta and persist it *together with the store's current state*, in one write. */
  updateMeta(fn: (m: SyncMeta) => SyncMeta): void;
  /** Bind the store whose state is written alongside the meta; its local edits get revisions. */
  attach(store: Store): void;
  /** Re-read after another process changed the document; returns the fresh state. */
  reload(): AppState | null;
}

type Doc = AppState & { syncMeta?: unknown };

export function createDocPersistence(io: DocIO, legacyMeta?: () => unknown): DocPersistence {
  let meta: SyncMeta | null = null;
  let store: Store | null = null;
  const serialize = (state: AppState) => JSON.stringify(meta ? { ...state, syncMeta: meta } : state);
  const parse = (raw: string) => {
    const doc = JSON.parse(raw) as Doc;
    const { syncMeta, ...rest } = doc;
    const state = repairDuplicateIds(normalize(rest));
    return { state, meta: syncMeta, };
  };

  return {
    load() {
      const raw = io.read();
      if (!raw) {
        meta = migrateMeta(legacyMeta?.(), emptyState());
        return { state: emptyState(), error: null, raw: null };
      }
      try {
        const p = parse(raw);
        // Older versions kept the meta elsewhere / in another shape; adopt it once.
        meta = migrateMeta(p.meta ?? legacyMeta?.(), p.state);
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
    updateMeta(fn) {
      meta = fn(meta ?? newSyncMeta());
      if (store) io.write(serialize(store.get()));
    },
    attach(s) {
      store = s;
      // Stamp every local edit right away; the store saves state + meta together after it.
      s.onLocalChange((changes) => {
        meta = recordLocal(meta ?? newSyncMeta(), changes);
      });
    },
    reload() {
      const raw = io.read();
      if (!raw) return null;
      try {
        const p = parse(raw);
        meta = migrateMeta(p.meta, p.state) ?? meta;
        return p.state;
      } catch {
        return null;
      }
    },
  };
}
