// Record store on SQLite (node:sqlite, no native build step).
import { DatabaseSync } from 'node:sqlite';
import type { DeleteGuard, Rejection, SyncRecord, SyncRequest, SyncResponse } from '@automedo/core';

/** Thrown (before anything is written) when a sync would delete a lot and wasn't confirmed. */
export class MassDeleteError extends Error {
  constructor(readonly guard: DeleteGuard) {
    super('confirm-delete');
  }
}

/** Deleting more than half of the server's content records counts as "a lot" from this many on. */
const MASS_DELETE_MIN = 20;

export interface RecordDb {
  /** Underlying connection, for other server modules (push). */
  raw: DatabaseSync;
  sync(req: SyncRequest): SyncResponse;
  all(): SyncRecord[];
  stats(): { records: number; tombstones: number; cursor: number };
  close(): void;
}

export function openDb(path: string): RecordDb {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- FULL: a sync the client was told succeeded survives a power cut, not just a crash.
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS records (
      id      TEXT PRIMARY KEY,
      kind    TEXT NOT NULL,
      parent  TEXT,
      rev     TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      data    TEXT,
      client  TEXT
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
    -- One row per accepted change: lets a client's cursor be checked against this
    -- database's actual history (a restored or replaced database fails the check).
    CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, rev TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT OR IGNORE INTO journal (seq, id, rev) SELECT seq, id, rev FROM records;
    CREATE INDEX IF NOT EXISTS journal_id ON journal(id, rev);
    CREATE INDEX IF NOT EXISTS records_parent ON records(parent);
  `);
  // Identity of this database (a new, empty one gets a new epoch).
  const epochRow = db.prepare("SELECT v FROM meta WHERE k = 'epoch'").get() as { v: string } | undefined;
  const epoch = epochRow?.v ?? Math.random().toString(36).slice(2, 12);
  if (!epochRow) db.prepare("INSERT INTO meta (k, v) VALUES ('epoch', ?)").run(epoch);
  const journalAt = db.prepare('SELECT rev FROM journal WHERE seq = ?');
  const journal = db.prepare('INSERT OR REPLACE INTO journal (seq, id, rev) VALUES (?, ?, ?)');
  const everApplied = db.prepare('SELECT 1 AS x FROM journal WHERE id = ? AND rev = ? LIMIT 1');
  const liveChildren = db.prepare('SELECT * FROM records WHERE parent = ? AND deleted = 0');
  const get = db.prepare('SELECT * FROM records WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO records (id, kind, parent, rev, seq, deleted, data, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, parent = excluded.parent, rev = excluded.rev,
      seq = excluded.seq, deleted = excluded.deleted, data = excluded.data, client = excluded.client`);
  const since = db.prepare('SELECT * FROM records WHERE seq > ? ORDER BY seq');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM records');
  const allRows = db.prepare('SELECT * FROM records ORDER BY seq');
  // "Content" for the ratio rule: not settings, and not log entries (they only go away with
  // their plan/goal, which the workspace rules already cover, and would dilute the ratio).
  const liveContent = db.prepare("SELECT COUNT(*) AS n FROM records WHERE deleted = 0 AND kind NOT IN ('settings', 'hie', 'log')");
  const liveWorkspaces = db.prepare("SELECT COUNT(*) AS n FROM records WHERE deleted = 0 AND kind IN ('plan', 'goal')");

  type Row = { id: string; kind: SyncRecord['kind']; parent: string | null; rev: string; seq: number; deleted: number; data: string | null };
  /** `epoch.seq.rev` — names a position in this database's history, not just a number. */
  const tagFor = (seq: number) => `${epoch}.${seq}.${seq ? ((journalAt.get(seq) as { rev: string } | undefined)?.rev ?? '') : ''}`;
  /** Is the client's cursor still a point of our history? (False after a restore/replace.) */
  const validCursor = (cursor: number, tag: string | undefined, head: number) => {
    if (!tag) return cursor <= head; // older clients: at least catch a cursor beyond our history
    return tag === tagFor(cursor) && cursor <= head;
  };
  const toRecord = (r: Row): SyncRecord => ({
    id: r.id,
    kind: r.kind,
    parent: r.parent ?? undefined,
    rev: r.rev,
    ...(r.deleted ? { deleted: true } : { data: JSON.parse(r.data ?? 'null') }),
  });

  const isWs = (k: string) => k === 'plan' || k === 'goal';
  /**
   * Whether a change applies. With a `base` (current clients) an edit applies only on
   * top of exactly the revision it started from, so nobody's edit is silently replaced:
   * the client gets the current version back and merges. Without one, last writer wins.
   */
  function decide(c: SyncRecord, cur: Row | undefined, structural = true): 'accept' | 'same' | Rejection['reason'] {
    if (cur && cur.rev === c.rev) {
      // A retry of something already applied — but only if it really is the same change.
      const sameContent = !!cur.deleted === !!c.deleted && (c.deleted || cur.data === JSON.stringify(c.data ?? null)) && (cur.parent ?? undefined) === c.parent;
      return sameContent ? 'same' : 'conflict';
    }
    if (c.base === undefined) return !cur || cur.rev < c.rev ? 'accept' : 'conflict';
    if (cur && (everApplied.get(c.id, c.rev) as { x: number } | undefined)) return 'superseded';
    if ((cur?.rev ?? '') !== c.base) return 'conflict';
    if (!structural) return 'accept';
    // New content inside a plan/goal deleted elsewhere would be invisible: refuse it.
    if (!c.deleted && c.parent && (get.get(c.parent) as Row | undefined)?.deleted) return 'parent-deleted';
    // Deleting a plan/goal that has content the deleting device did not know about.
    if (c.deleted && isWs(c.kind) && liveChildren.all(c.id).length) return 'has-children';
    return 'accept';
  }

  /**
   * Refuse a request that deletes a lot at once — two or more plans/goals, the last
   * plan/goal, or over half of a non-trivial server — unless the user confirmed that
   * many deletions. Counts only deletions that would actually win (live record, newer rev).
   */
  function guardDeletes(req: SyncRequest) {
    let deletes = 0;
    let contentDeletes = 0;
    const ids: string[] = [];
    const workspaces: DeleteGuard['workspaces'] = [];
    for (const c of req.changes) {
      if (!c.deleted) continue;
      const cur = get.get(c.id) as Row | undefined;
      if (!cur || cur.deleted || decide(c, cur, false) !== 'accept') continue;
      deletes += 1;
      ids.push(c.id);
      if (cur.kind !== 'log') contentDeletes += 1;
      if (cur.kind === 'plan' || cur.kind === 'goal') {
        let title = '';
        try {
          title = String((JSON.parse(cur.data ?? 'null') as { title?: unknown } | null)?.title ?? '');
        } catch {
          // keep it untitled
        }
        workspaces.push({ kind: cur.kind, title });
      }
    }
    // A confirmation covers exactly the records the user was shown, not "up to N".
    const confirmed = new Set(req.confirmDeleteIds ?? []);
    if (deletes === 0 || ids.every((id) => confirmed.has(id))) return;
    const live = (liveContent.get() as { n: number }).n;
    const lastWorkspace = workspaces.length > 0 && workspaces.length >= (liveWorkspaces.get() as { n: number }).n;
    if (workspaces.length >= 2 || lastWorkspace || (contentDeletes >= MASS_DELETE_MIN && contentDeletes * 2 > live)) {
      throw new MassDeleteError({ error: 'confirm-delete', deletes, live, workspaces, ids });
    }
  }

  return {
    raw: db,
    sync(req) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = (maxSeq.get() as { m: number }).m;
        // The client's position is not part of this database's history: nothing is
        // applied; the client must reconcile from scratch (and re-send what it has).
        if (!validCursor(req.cursor, req.cursorTag, seq)) {
          db.exec('ROLLBACK');
          return { cursor: 0, cursorTag: tagFor(0), records: [], reset: true };
        }
        guardDeletes(req);
        const accepted = new Set<string>();
        const rejected: Rejection[] = [];
        const extra: Row[] = [];
        // Parents before children; deletions of children before their plan/goal.
        const rank = (c: SyncRecord) => (c.deleted ? (isWs(c.kind) ? 3 : 2) : isWs(c.kind) ? 0 : 1);
        for (const c of [...req.changes].sort((a, b) => rank(a) - rank(b))) {
          const cur = get.get(c.id) as Row | undefined;
          const verdict = decide(c, cur);
          if (verdict === 'same') {
            accepted.add(c.id);
            continue;
          }
          if (verdict !== 'accept') {
            rejected.push({ id: c.id, reason: verdict });
            if (verdict === 'parent-deleted') extra.push(get.get(c.parent!) as Row);
            if (verdict === 'has-children') extra.push(...(liveChildren.all(c.id) as Row[]));
            continue;
          }
          seq += 1;
          upsert.run(c.id, c.kind, c.parent ?? null, c.rev, seq, c.deleted ? 1 : 0, c.deleted ? null : JSON.stringify(c.data ?? null), req.clientId);
          journal.run(seq, c.id, c.rev);
          accepted.add(c.id);
        }
        // Everything newer than the client's cursor, minus what it just sent us…
        const out = (since.all(req.cursor) as Row[]).filter((r) => !accepted.has(r.id)).map(toRecord);
        // …plus the current version of anything refused (and what it conflicts with),
        // so the client can merge and converge.
        const seen = new Set(out.map((r) => r.id));
        const add = (r: Row | undefined) => {
          if (r && !seen.has(r.id)) {
            seen.add(r.id);
            out.push(toRecord(r));
          }
        };
        for (const r of rejected) add(get.get(r.id) as Row | undefined);
        for (const r of extra) add(r);
        const cursorTag = tagFor(seq);
        db.exec('COMMIT');
        return { cursor: seq, cursorTag, records: out, ...(rejected.length ? { rejected } : {}) };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    all: () => (allRows.all() as Row[]).filter((r) => !r.deleted).map(toRecord),
    stats() {
      const rows = allRows.all() as Row[];
      return { records: rows.filter((r) => !r.deleted).length, tombstones: rows.filter((r) => r.deleted).length, cursor: (maxSeq.get() as { m: number }).m };
    },
    close: () => db.close(),
  };
}
