// Record store on SQLite (node:sqlite, no native build step).
import { DatabaseSync } from 'node:sqlite';
import type { SyncRecord, SyncRequest, SyncResponse } from '@automedo/core';

export interface RecordDb {
  sync(req: SyncRequest): SyncResponse;
  all(): SyncRecord[];
  stats(): { records: number; tombstones: number; cursor: number };
  close(): void;
}

export function openDb(path: string): RecordDb {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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
  `);
  const get = db.prepare('SELECT * FROM records WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO records (id, kind, parent, rev, seq, deleted, data, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, parent = excluded.parent, rev = excluded.rev,
      seq = excluded.seq, deleted = excluded.deleted, data = excluded.data, client = excluded.client`);
  const since = db.prepare('SELECT * FROM records WHERE seq > ? ORDER BY seq');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM records');
  const allRows = db.prepare('SELECT * FROM records ORDER BY seq');

  type Row = { id: string; kind: SyncRecord['kind']; parent: string | null; rev: string; seq: number; deleted: number; data: string | null };
  const toRecord = (r: Row): SyncRecord => ({
    id: r.id,
    kind: r.kind,
    parent: r.parent ?? undefined,
    rev: r.rev,
    ...(r.deleted ? { deleted: true } : { data: JSON.parse(r.data ?? 'null') }),
  });

  return {
    sync(req) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = (maxSeq.get() as { m: number }).m;
        const accepted = new Set<string>();
        const rejected: string[] = [];
        for (const c of req.changes) {
          const cur = get.get(c.id) as Row | undefined;
          // Last writer wins: revisions are time-ordered strings.
          if (cur && cur.rev >= c.rev) {
            rejected.push(c.id);
            continue;
          }
          seq += 1;
          upsert.run(c.id, c.kind, c.parent ?? null, c.rev, seq, c.deleted ? 1 : 0, c.deleted ? null : JSON.stringify(c.data ?? null), req.clientId);
          accepted.add(c.id);
        }
        // Everything newer than the client's cursor, minus what it just sent us…
        const out = (since.all(req.cursor) as Row[]).filter((r) => !accepted.has(r.id)).map(toRecord);
        // …plus the winning version of anything we refused, so the client converges.
        const seen = new Set(out.map((r) => r.id));
        for (const id of rejected) {
          if (seen.has(id)) continue;
          const r = get.get(id) as Row | undefined;
          if (r) out.push(toRecord(r));
        }
        db.exec('COMMIT');
        return { cursor: seq, records: out };
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
