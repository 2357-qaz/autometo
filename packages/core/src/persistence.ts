// Durable storage for state + sync bookkeeping in ONE document.
//
// The sync bookkeeping (revisions, outbox, cursor) and the data it describes must hit
// the disk together: a single atomic write — one localStorage key, or one file renamed
// into place — is the commit point of every edit and every sync round.
//
// Several writers may share the document (two terminals, a TUI and a one-shot command,
// two browser tabs). Each write carries a sequence number; if the document changed since
// this writer last saw it, its own changes are merged record by record onto the newer
// document (the newer revision wins where both changed the same record) instead of
// overwriting it.
import { emptyState, normalize } from './state';
import type { PersistAdapter, Store } from './store';
import { compose, decompose, diffRecords, merge3, migrateMeta, newSyncMeta, recordLocal, sameRec, type PendingBase, type SyncMeta } from './sync';
import type { AppState } from './types';
import { repairDuplicateIds } from './validate';

export interface DocIO {
  read(): string | null;
  /** Must replace the whole document atomically (or throw). */
  write(text: string): void;
  /** Run read → merge → write without another writer interleaving (files: a lock). */
  exclusive?<T>(fn: () => T): T;
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
  /**
   * Another writer changed the document: merge it with this writer's state. Returns the
   * merged state to install (store.applyExternal), or null if there was nothing new.
   */
  reload(): AppState | null;
}

interface Parsed {
  state: AppState;
  meta: SyncMeta | null;
  seq: number;
}

/** Meta of two writers of the same document: union of what either knows or still has to send. */
export function mergeMeta(ours: SyncMeta | null, theirs: SyncMeta | null): SyncMeta | null {
  if (!ours || !theirs) return ours ?? theirs;
  const revs: Record<string, string> = { ...theirs.revs };
  for (const [id, r] of Object.entries(ours.revs)) if (!revs[id] || r > revs[id]) revs[id] = r;
  const outbox: Record<string, string> = {};
  // An entry stays pending unless the other writer already has that revision acknowledged
  // (it synced it: same revision known, no longer in its outbox) or holds a newer one.
  const pending = (a: SyncMeta, b: SyncMeta, id: string) => {
    const r = a.outbox[id];
    return r !== undefined && r === revs[id] && !(b.revs[id] === r && b.outbox[id] === undefined);
  };
  const bases: Record<string, PendingBase> = {};
  for (const id of new Set([...Object.keys(ours.outbox), ...Object.keys(theirs.outbox)])) {
    if (pending(ours, theirs, id) || pending(theirs, ours, id)) {
      outbox[id] = revs[id];
      // The base of the side whose edit is still pending (the oldest unsent starting point).
      const base = (ours.outbox[id] === revs[id] ? ours : theirs).bases?.[id] ?? (ours.bases?.[id] || theirs.bases?.[id]);
      if (base) bases[id] = base;
    }
  }
  const seenNote = new Set<string>();
  const conflicts = [...(theirs.conflicts ?? []), ...(ours.conflicts ?? [])]
    .filter((n) => !seenNote.has(`${n.at}:${n.id}`) && seenNote.add(`${n.at}:${n.id}`))
    .sort((a, b) => a.at - b.at)
    .slice(-50);
  // Both sides' data are in the merge, so the further sync position applies (same server).
  const pos = ours.url === theirs.url && ours.cursor > theirs.cursor ? ours : theirs;
  return {
    clientId: theirs.clientId,
    lastT: Math.max(ours.lastT, theirs.lastT),
    revs,
    outbox,
    url: pos.url,
    cursor: pos.cursor,
    cursorTag: pos.cursorTag,
    synced: pos.synced,
    bases,
    conflicts,
  };
}

/** Apply this writer's changes since `base` onto the other writer's newer document. */
export function mergeDocs(base: AppState, ours: { state: AppState; meta: SyncMeta | null }, theirs: { state: AppState; meta: SyncMeta | null }) {
  const b = decompose(base);
  const t = decompose(theirs.state);
  const merged = new Map(t);
  for (const c of diffRecords(b, decompose(ours.state))) {
    const tr = t.get(c.id);
    if (!sameRec(tr, b.get(c.id))) {
      // Both writers changed this record: merge field by field from the common version
      // (the later edit wins a field both changed). Same device, so no notice.
      const theirsRev = theirs.meta?.revs[c.id] ?? '';
      const m = merge3(
        { rev: '', data: c.before?.data, parent: c.before?.parent },
        c.after,
        tr ? { id: c.id, kind: tr.kind, parent: tr.parent, data: tr.data, rev: theirsRev } : { id: c.id, kind: c.after?.kind ?? c.before!.kind, rev: theirsRev, deleted: true },
        ours.meta?.revs[c.id] ?? '',
      );
      if (m.rec) merged.set(c.id, m.rec);
      else merged.delete(c.id);
      continue;
    }
    if (c.after) merged.set(c.id, c.after);
    else merged.delete(c.id);
  }
  return { state: compose(merged.values(), ours.state.ui), meta: mergeMeta(ours.meta, theirs.meta) };
}

function parseDoc(raw: string): Parsed {
  const { syncMeta, writeSeq, ...rest } = JSON.parse(raw) as AppState & { syncMeta?: unknown; writeSeq?: number };
  const state = repairDuplicateIds(normalize(rest));
  return { state, meta: migrateMeta(syncMeta, state), seq: Number(writeSeq) || 0 };
}

/** Why a stored document cannot be loaded (the check `load` applies), or null if it can. */
export function documentError(raw: string): string | null {
  try {
    parseDoc(raw);
    return null;
  } catch (e) {
    return (e as Error).message || String(e);
  }
}

export function createDocPersistence(io: DocIO, legacyMeta?: () => unknown): DocPersistence {
  let meta: SyncMeta | null = null;
  let store: Store | null = null;
  /** The document as this writer last read or wrote it: the base of a merge. */
  let seen = 0;
  let base: AppState = emptyState();

  const parse = parseDoc;
  const exclusive = <T>(fn: () => T): T => (io.exclusive ? io.exclusive(fn) : fn());

  /** Write `state` + meta; if someone else wrote meanwhile, merge first. Returns what was written. */
  const writeDoc = (state: AppState): AppState => exclusive(() => {
    let out = state;
    let diskSeq = seen;
    const raw = io.read();
    if (raw) {
      let disk: Parsed | null = null;
      try {
        disk = parse(raw);
      } catch {
        disk = null; // unreadable: ours replaces it (it was readable when we loaded it)
      }
      if (disk && disk.seq !== seen) {
        const m = mergeDocs(base, { state, meta }, disk);
        out = m.state;
        meta = m.meta;
        diskSeq = disk.seq;
      }
    }
    const seq = Math.max(seen, diskSeq) + 1;
    io.write(JSON.stringify(meta ? { ...out, syncMeta: meta, writeSeq: seq } : { ...out, writeSeq: seq }));
    seen = seq;
    base = out;
    return out;
  });

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
        meta = p.meta ?? migrateMeta(legacyMeta?.(), p.state);
        seen = p.seq;
        base = p.state;
        return { state: p.state, error: null, raw };
      } catch (e) {
        return { state: emptyState(), error: (e as Error).message, raw };
      }
    },
    persist: {
      save: (state) => writeDoc(state),
    },
    loadMeta: () => meta,
    updateMeta(fn) {
      meta = fn(meta ?? newSyncMeta());
      if (!store) return;
      const current = store.get();
      const written = writeDoc(current);
      if (written !== current) store.applyExternal(written);
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
      if (!raw || !store) return null;
      let disk: Parsed;
      try {
        disk = parse(raw);
      } catch {
        return null;
      }
      if (disk.seq === seen) return null; // our own write
      const m = mergeDocs(base, { state: store.get(), meta }, disk);
      meta = m.meta;
      seen = disk.seq;
      base = disk.state;
      return m.state;
    },
  };
}
