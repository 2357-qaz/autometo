// Local-first sync, record level.
//
// The nested AppState is decomposed into flat records (plan meta, phase, task,
// version, log entry, session, …). Every local edit is recorded AT EDIT TIME: the
// records it changed get a fresh revision and go into the device's outbox. A sync
// sends the outbox as is — so a retry re-sends the same revisions (idempotent) —
// and applies the server's newer records. Nothing is ever inferred from what is
// "missing" in the state: deletions are only ever explicit, recorded edits.
// Conflicts resolve last-writer-wins per record by revision (time of the edit).
// First contact, a server switch and a server whose history went back (restored
// database) all go through one reconciliation that compares revisions record by record.
import type { AppState, Checkpoint, Compact, FatigueMark, Goal, LogEntry, Phase, Plan, PlanVersion, Session, Task } from './types';
import { emptyState } from './state';

export type RecordKind =
  | 'plan'
  | 'goal'
  | 'phase'
  | 'task'
  | 'version'
  | 'checkpoint'
  | 'log'
  | 'session'
  | 'compact'
  | 'fatigue'
  | 'settings'
  | 'hie';

/** A record as stored locally (no revision yet). */
export interface Rec {
  id: string;
  kind: RecordKind;
  parent?: string;
  data: unknown;
}

/** A record on the wire / on the server. */
export interface SyncRecord {
  id: string;
  kind: RecordKind;
  parent?: string;
  rev: string;
  deleted?: boolean;
  data?: unknown;
  /**
   * The revision this edit started from ('' = the record did not exist). The server
   * applies the edit only on top of exactly that revision; otherwise it refuses and
   * sends the current version, and the client merges. Absent: plain last-writer-wins.
   */
  base?: string;
}

/** Why the server did not apply a change (it also sends the relevant current records). */
export interface Rejection {
  id: string;
  /**
   * conflict: the record changed since `base` — merge and resend.
   * superseded: this exact revision was applied before and has been built upon since.
   * parent-deleted: its plan/goal was deleted elsewhere.
   * has-children: a plan/goal still has content this request did not delete.
   */
  reason: 'conflict' | 'superseded' | 'parent-deleted' | 'has-children';
}

export interface SyncRequest {
  clientId: string;
  cursor: number;
  /** Opaque server identity of `cursor` (see SyncResponse.cursorTag). */
  cursorTag?: string;
  changes: SyncRecord[];
  /** Record ids whose deletion the user confirmed (see DeleteGuard). Only these may pass. */
  confirmDeleteIds?: string[];
}

/**
 * The server refuses (HTTP 409, nothing applied) a sync that would delete a lot at
 * once until the user confirms it — a safety net against a client bug wiping data.
 */
export interface DeleteGuard {
  error: 'confirm-delete';
  /** Live records this request would delete. */
  deletes: number;
  /** Live content records (excluding logs and settings) on the server before the request. */
  live: number;
  /** Plans/goals among them. */
  workspaces: { kind: 'plan' | 'goal'; title: string }[];
  /** Exactly the records this request would delete — what a confirmation covers. */
  ids: string[];
}

export interface SyncResponse {
  cursor: number;
  /** Identifies this cursor position in this database's history; send it back next time. */
  cursorTag?: string;
  records: SyncRecord[];
  /** The server's history no longer contains our cursor (e.g. restored database): reconcile. */
  reset?: boolean;
  rejected?: Rejection[];
}

/** What a device persists (together with its state) for syncing. */
export interface SyncMeta {
  clientId: string;
  /** Last revision timestamp issued or seen by this client (ms) — a hybrid clock. */
  lastT: number;
  /** id → revision of the version of each record this device holds (local edit or applied remote). */
  revs: Record<string, string>;
  /** id → revision of a local change the server has not acknowledged. Not in the state ⇒ a deletion. */
  outbox: Record<string, string>;
  /** Server this bookkeeping belongs to; a cursor is meaningless against any other. */
  url?: string;
  cursor: number;
  cursorTag?: string;
  /** The full reconciliation with `url` is done; until then the next sync reconciles. */
  synced?: boolean;
  /** For each pending record: the version its first unsent edit started from (3-way merge base). */
  bases?: Record<string, PendingBase>;
  /** Concurrent edits that were merged and need the user's attention (newest last). */
  conflicts?: ConflictNote[];
}

export interface PendingBase {
  /** '' = the record did not exist. */
  rev: string;
  data?: unknown;
  parent?: string;
}

/** Something two devices changed at the same time: merged, and shown, never silent. */
export interface ConflictNote {
  at: number;
  id: string;
  kind: RecordKind;
  title: string;
  /**
   * fields: both edited; per field the later edit was kept (the other value is here).
   * kept-edited: deleted elsewhere while edited here — kept (with this device's edits).
   * kept-deleted: deleted here while edited elsewhere — kept (with the other edits).
   * kept-workspace: a plan/goal deleted while another device added to it — kept.
   */
  what: 'fields' | 'kept-edited' | 'kept-deleted' | 'kept-workspace';
  fields?: { name: string; mine: unknown; theirs: unknown; kept: 'mine' | 'theirs' }[];
}

export function newSyncMeta(clientId = randomId()): SyncMeta {
  return { clientId, lastT: 0, revs: {}, outbox: {}, cursor: 0 };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ───────────────────────── revisions ─────────────────────────

/** Fixed-width so plain string comparison orders revisions by time, then client. */
export function makeRev(t: number, clientId: string): string {
  return `${t.toString(36).padStart(9, '0')}.${clientId}`;
}

/**
 * Several writers can share one device's clientId (two browser tabs, two terminals on
 * one data file): each JS realm adds its own writer id, and within a realm time never
 * repeats — so no two local changes anywhere ever get the same revision.
 */
const WRITER = Math.random().toString(36).slice(2, 7);
let lastMinted = 0;

/** A new revision for a change made here, at `t` or later. */
export function mintRev(clientId: string, t: number): { rev: string; t: number } {
  const at = Math.max(t, lastMinted + 1);
  lastMinted = at;
  return { rev: makeRev(at, `${clientId}-${WRITER}`), t: at };
}

export function revTime(rev: string): number {
  return parseInt(rev.split('.')[0], 36);
}

// ───────────────────────── canonical hashing ─────────────────────────

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** FNV-1a over the canonical JSON — enough to detect "did this record change". */
export function hashData(v: unknown): string {
  const s = canonical(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// ───────────────────────── decompose / compose ─────────────────────────

const without = <T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> => {
  const c = { ...o };
  for (const k of keys) delete c[k];
  return c;
};

/** Split state into records. `ui` is device-local and never synced. */
export function decompose(s: AppState, onDuplicate?: (id: string) => void): Map<string, Rec> {
  const out = new Map<string, Rec>();
  const put = (r: Rec) => {
    if (onDuplicate && out.has(r.id)) onDuplicate(r.id);
    out.set(r.id, r);
  };
  for (const p of s.plans) {
    const pid = `plan:${p.id}`;
    // updatedAt is derived on compose; syncing it would make unrelated edits collide.
    put({ id: pid, kind: 'plan', data: without(p, 'phases', 'tasks', 'versions', 'log', 'updatedAt') });
    p.phases.forEach((ph, i) => put({ id: `phase:${ph.id}`, kind: 'phase', parent: pid, data: { ...ph, _o: i } }));
    p.tasks.forEach((t, i) => put({ id: `task:${t.id}`, kind: 'task', parent: pid, data: { ...t, _o: i } }));
    // Old versions are keyed by number; new ones by their own id, so two devices
    // committing "v3" at the same time keep both snapshots.
    for (const v of p.versions) put({ id: v.id ? `ver:${p.id}:#${v.id}` : `ver:${p.id}:${v.v}`, kind: 'version', parent: pid, data: v });
    for (const e of p.log) put({ id: `log:${e.id}`, kind: 'log', parent: pid, data: e });
  }
  for (const g of s.goals) {
    const gid = `goal:${g.id}`;
    put({ id: gid, kind: 'goal', data: without(g, 'moves', 'checkpoints', 'log', 'updatedAt') });
    g.moves.forEach((t, i) => put({ id: `task:${t.id}`, kind: 'task', parent: gid, data: { ...t, _o: i } }));
    for (const c of g.checkpoints) put({ id: `cp:${c.id}`, kind: 'checkpoint', parent: gid, data: c });
    for (const e of g.log) put({ id: `log:${e.id}`, kind: 'log', parent: gid, data: e });
  }
  for (const x of s.sessions) put({ id: `ses:${x.id}`, kind: 'session', data: x });
  for (const c of s.compacts) put({ id: `cmp:${c.id}`, kind: 'compact', data: c });
  for (const f of s.fatigue) put({ id: `fat:${f.at}:${f.level}`, kind: 'fatigue', data: f });
  put({ id: 'settings', kind: 'settings', data: s.settings });
  put({ id: 'hie', kind: 'hie', data: s.hie });
  return out;
}

type Ordered<T> = T & { _o?: number };
// Equal positions happen when two devices append at the same time: break the tie by id,
// so every device ends up with the same order instead of keeping its own.
const byOrder = <T extends { id: string }>(a: Ordered<T>, b: Ordered<T>) => (a._o ?? 0) - (b._o ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const strip = <T>(x: Ordered<T>): T => {
  const c = { ...x };
  delete c._o;
  return c;
};

/** Rebuild state from records, keeping this device's `ui`. Orphans are dropped. */
export function compose(records: Iterable<Rec>, ui: AppState['ui']): AppState {
  const s = emptyState();
  s.ui = { ...ui };
  const plans = new Map<string, Plan>();
  const goals = new Map<string, Goal>();
  const children: Rec[] = [];
  for (const r of records) {
    switch (r.kind) {
      case 'plan': {
        const p = r.data as Plan;
        plans.set(r.id, { ...p, phases: [], tasks: [], versions: [], log: [], updatedAt: p.createdAt });
        break;
      }
      case 'goal': {
        const g = r.data as Goal;
        goals.set(r.id, { ...g, moves: [], checkpoints: [], log: [], updatedAt: g.createdAt });
        break;
      }
      case 'session':
        s.sessions.push(r.data as Session);
        break;
      case 'compact':
        s.compacts.push(r.data as Compact);
        break;
      case 'fatigue':
        s.fatigue.push(r.data as FatigueMark);
        break;
      case 'settings':
        s.settings = { ...s.settings, ...(r.data as AppState['settings']) };
        break;
      case 'hie':
        s.hie = { ...s.hie, ...(r.data as AppState['hie']) };
        break;
      default:
        children.push(r);
    }
  }
  const phases = new Map<string, Ordered<Phase>[]>();
  const tasks = new Map<string, Ordered<Task>[]>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const r of children) {
    const parent = r.parent ?? '';
    const ws = plans.get(parent) ?? goals.get(parent);
    if (!ws) continue; // orphan (its plan/goal was deleted)
    switch (r.kind) {
      case 'phase':
        push(phases, parent, r.data as Ordered<Phase>);
        break;
      case 'task':
        push(tasks, parent, r.data as Ordered<Task>);
        break;
      case 'version':
        if (ws.kind === 'plan') ws.versions.push(r.data as PlanVersion);
        break;
      case 'checkpoint':
        if (ws.kind === 'goal') ws.checkpoints.push(r.data as Checkpoint);
        break;
      case 'log':
        ws.log.push(r.data as LogEntry);
        break;
    }
  }
  for (const [id, p] of plans) {
    p.phases = (phases.get(id) ?? []).sort(byOrder).map(strip);
    const phaseIds = new Set(p.phases.map((x) => x.id));
    // A task whose phase was deleted elsewhere falls back to the first phase.
    p.tasks = (tasks.get(id) ?? []).sort(byOrder).map(strip).map((t) => (t.phaseId && !phaseIds.has(t.phaseId) ? { ...t, phaseId: p.phases[0]?.id ?? null } : t));
    p.versions.sort((a, b) => a.v - b.v || a.at - b.at || ((a.id ?? '') < (b.id ?? '') ? -1 : 1));
    // Concurrent commits can share a number: renumber in that (deterministic) order so
    // every device shows the same unique v1…vn and /diff vN stays unambiguous.
    if (p.versions.some((x, i) => i > 0 && x.v === p.versions[i - 1].v)) p.versions = p.versions.map((x, i) => ({ ...x, v: i + 1 }));
  }
  for (const [id, g] of goals) {
    g.moves = (tasks.get(id) ?? []).sort(byOrder).map(strip);
    g.checkpoints.sort((a, b) => a.at - b.at);
  }
  for (const ws of [...plans.values(), ...goals.values()]) {
    ws.log.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    ws.updatedAt = Math.max(ws.createdAt, ws.log[ws.log.length - 1]?.at ?? 0);
  }
  s.plans = [...plans.values()].sort((a, b) => b.createdAt - a.createdAt);
  s.goals = [...goals.values()].sort((a, b) => b.createdAt - a.createdAt);
  s.sessions.sort((a, b) => a.startedAt - b.startedAt);
  s.compacts.sort((a, b) => a.at - b.at);
  s.fatigue.sort((a, b) => a.at - b.at);
  // Keep the device's selection valid; a freshly connected device opens the first item.
  if (!s.plans.some((p) => p.id === s.ui.activePlanId)) s.ui.activePlanId = s.plans[0]?.id ?? null;
  if (!s.goals.some((g) => g.id === s.ui.activeGoalId)) s.ui.activeGoalId = s.goals[0]?.id ?? null;
  return s;
}

// ───────────────────────── client-side sync steps ─────────────────────────

const recHash = (r: Rec) => hashData(r.data) + (r.parent ?? '');

/** A record changed by one local edit (or one undo): absent before ⇒ created, absent after ⇒ deleted. */
export interface RecordChange {
  id: string;
  before?: Rec;
  after?: Rec;
}

export function diffRecords(prev: Map<string, Rec>, next: Map<string, Rec>): RecordChange[] {
  const out: RecordChange[] = [];
  for (const [id, r] of next) {
    const b = prev.get(id);
    if (!b || recHash(b) !== recHash(r)) out.push({ id, before: b, after: r });
  }
  for (const [id, b] of prev) if (!next.has(id)) out.push({ id, before: b });
  return out;
}

export const sameRec = (a: Rec | undefined, b: Rec | undefined) => (a && b ? recHash(a) === recHash(b) : a === b);

/** Stamp a local edit: each changed record gets a new revision now and joins the outbox. */
export function recordLocal(meta: SyncMeta, changes: RecordChange[], now = Date.now()): SyncMeta {
  if (!changes.length) return meta;
  // One revision for the whole edit (revisions only need to be unique per record): the
  // clock then stays at the real edit time instead of running ahead by one per record,
  // so "the later edit" means the one actually made later.
  const { rev, t } = mintRev(meta.clientId, Math.max(now, meta.lastT + 1));
  const revs = { ...meta.revs };
  const outbox = { ...meta.outbox };
  const bases = { ...meta.bases };
  for (const c of changes) {
    // The first unsent edit of a record remembers what it started from.
    if (!outbox[c.id]) bases[c.id] = { rev: revs[c.id] ?? '', data: c.before?.data, parent: c.before?.parent };
    revs[c.id] = rev;
    outbox[c.id] = rev;
  }
  return { ...meta, revs, outbox, bases, lastT: t };
}

export interface Prepared {
  request: SyncRequest;
  /** id → revision as sent, to tell acknowledged entries from ones edited again meanwhile. */
  sent: Record<string, string>;
}

/** The outbox as a request: current content of each pending record (or a tombstone). */
export function prepareSync(state: AppState, meta: SyncMeta, now = Date.now()): Prepared {
  const recs = decompose(state);
  let t = Math.max(now, meta.lastT);
  const pending: Record<string, string> = { ...meta.outbox };
  // Never reconciled with anyone yet: everything this device has is new to the server.
  if (!meta.synced) {
    for (const [id, r] of recs) {
      if (pending[id] || isUntouchedDefault(r)) continue;
      if (meta.revs[id]) pending[id] = meta.revs[id];
      else ({ rev: pending[id], t } = mintRev(meta.clientId, t + 1));
    }
  }
  const changes: SyncRecord[] = [];
  for (const [id, rev] of Object.entries(pending)) {
    const r = recs.get(id);
    const base = meta.bases?.[id]?.rev;
    const b = base === undefined ? {} : { base };
    changes.push(r ? { id, kind: r.kind, parent: r.parent, rev, data: r.data, ...b } : { id, kind: kindOf(id), rev, deleted: true, ...b });
  }
  return { request: { clientId: meta.clientId, cursor: meta.cursor, cursorTag: meta.cursorTag, changes }, sent: pending };
}

const DEFAULTS: Partial<Record<RecordKind, string>> = (() => {
  const e = emptyState();
  return { settings: hashData(e.settings), hie: hashData(e.hie) };
})();

function isUntouchedDefault(r: Rec): boolean {
  const d = DEFAULTS[r.kind];
  return d !== undefined && hashData(r.data) === d;
}

function kindOf(id: string): RecordKind {
  const p = id.split(':')[0];
  const map: Record<string, RecordKind> = { plan: 'plan', goal: 'goal', phase: 'phase', task: 'task', ver: 'version', cp: 'checkpoint', log: 'log', ses: 'session', cmp: 'compact', fat: 'fatigue' };
  return map[p] ?? (id as RecordKind);
}

export interface Applied {
  state: AppState;
  meta: SyncMeta;
  changed: boolean;
}

function put(merged: Map<string, Rec>, r: SyncRecord): boolean {
  const cur = merged.get(r.id);
  if (r.deleted) return merged.delete(r.id);
  const rec: Rec = { id: r.id, kind: r.kind, parent: r.parent, data: r.data };
  merged.set(r.id, rec);
  return !cur || recHash(cur) !== recHash(rec);
}

const maxTime = (meta: SyncMeta, records: SyncRecord[]) => records.reduce((m, r) => Math.max(m, revTime(r.rev) || 0), meta.lastT);
const same = (a: unknown, b: unknown) => hashData(a) === hashData(b);
const isWsKind = (k: RecordKind) => k === 'plan' || k === 'goal';
/** Bookkeeping fields: merged silently (later wins), never worth a notice. */
const QUIET = new Set(['updatedAt', '_o', 'lastSeenAt']);
const MAX_NOTES = 50;

function titleOf(data: unknown, id: string): string {
  const d = (data ?? {}) as Record<string, unknown>;
  return String(d.title ?? d.intent ?? d.text ?? d.message ?? id);
}

type Merge = { rec: Rec | undefined; pending: boolean; note?: Omit<ConflictNote, 'at'> };

/**
 * Three-way merge of a record edited here (`mine`, pending at `mineRev`) and on the server
 * (`theirs`), from the version both started from. Field by field: what only one side
 * changed is taken from it; a field both changed differently keeps the later edit and the
 * other value goes into a conflict note. Edit vs delete keeps the edit. Nothing is dropped
 * silently.
 */
export function merge3(base: PendingBase, mine: Rec | undefined, theirs: SyncRecord, mineRev: string): Merge {
  const title = titleOf(mine?.data ?? theirs.data ?? base.data, theirs.id);
  const note = (what: ConflictNote['what'], fields?: ConflictNote['fields']) => ({ id: theirs.id, kind: theirs.kind, title, what, fields });
  if (theirs.deleted) {
    if (!mine) return { rec: undefined, pending: false };
    return { rec: mine, pending: true, note: note('kept-edited') };
  }
  const theirsRec: Rec = { id: theirs.id, kind: theirs.kind, parent: theirs.parent, data: theirs.data };
  if (!mine) {
    // They did not really change it: our deletion still applies.
    if (base.data !== undefined && same(theirs.data, base.data) && theirs.parent === base.parent) return { rec: undefined, pending: true };
    return { rec: theirsRec, pending: false, note: note('kept-deleted') };
  }
  const b = (base.data ?? {}) as Record<string, unknown>;
  const m = (mine.data ?? {}) as Record<string, unknown>;
  const t = (theirs.data ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const fields: NonNullable<ConflictNote['fields']> = [];
  const later: 'mine' | 'theirs' = mineRev > theirs.rev ? 'mine' : 'theirs';
  const pick = <T>(bv: T, mv: T, tv: T, name: string): T => {
    const mC = !same(mv, bv);
    const tC = !same(tv, bv);
    if (!mC) return tv;
    if (!tC || same(mv, tv)) return mv;
    if (!QUIET.has(name)) fields.push({ name, mine: mv, theirs: tv, kept: later });
    return later === 'mine' ? mv : tv;
  };
  for (const k of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
    const v = pick(b[k], m[k], t[k], k);
    if (v !== undefined) out[k] = v;
  }
  const parent = pick(base.parent, mine.parent, theirs.parent, 'parent');
  const rec: Rec = { id: theirs.id, kind: theirs.kind, parent, data: out };
  const conflict = fields.length ? note('fields', fields) : undefined;
  if (same(out, theirs.data) && parent === theirs.parent) return { rec: theirsRec, pending: false, note: conflict };
  return { rec, pending: true, note: conflict };
}

/** Mutable working set while merging server records into the local state. */
interface Work {
  merged: Map<string, Rec>;
  revs: Record<string, string>;
  outbox: Record<string, string>;
  bases: Record<string, PendingBase>;
  notes: ConflictNote[];
  changed: boolean;
  t: number;
  clientId: string;
  now: number;
}

function startWork(current: AppState, meta: SyncMeta, now: number): Work {
  return {
    merged: decompose(current),
    revs: { ...meta.revs },
    outbox: { ...meta.outbox },
    bases: { ...meta.bases },
    notes: [],
    changed: false,
    t: Math.max(now, meta.lastT),
    clientId: meta.clientId,
    now,
  };
}

function finish(w: Work, current: AppState, meta: SyncMeta, patch: Partial<SyncMeta>, records: SyncRecord[]): Applied {
  const conflicts = [...(meta.conflicts ?? []), ...w.notes].slice(-MAX_NOTES);
  return {
    state: w.changed ? compose(w.merged.values(), current.ui) : current,
    meta: { ...meta, revs: w.revs, outbox: w.outbox, bases: w.bases, conflicts, lastT: Math.max(w.t, maxTime(meta, records)), ...patch },
    changed: w.changed,
  };
}

/** Take the server's version of a record. */
function take(w: Work, r: SyncRecord) {
  w.changed = put(w.merged, r) || w.changed;
  w.revs[r.id] = r.rev;
  delete w.outbox[r.id];
  delete w.bases[r.id];
}

/** Keep (or set) local content and queue it on top of the server's current version. */
function rebase(w: Work, r: SyncRecord, rec: Rec | undefined) {
  const before = w.merged.get(r.id);
  if (rec) w.merged.set(r.id, rec);
  else w.merged.delete(r.id);
  if (!sameRec(before, rec)) w.changed = true;
  const m = mintRev(w.clientId, w.t + 1);
  w.t = m.t;
  const rev = m.rev;
  w.revs[r.id] = w.outbox[r.id] = rev;
  w.bases[r.id] = { rev: r.rev, data: r.deleted ? undefined : r.data, parent: r.parent };
}

/** The server's current version of a record this device has a pending edit of. */
function settle(w: Work, r: SyncRecord, reason?: Rejection['reason']) {
  const pending = w.outbox[r.id];
  const base = w.bases[r.id];
  // Our exact revision is already in the server's history and was built upon since.
  if (reason === 'superseded') return take(w, r);
  // The plan/goal we deleted has content we did not know about: keep it.
  if (reason === 'has-children') {
    w.notes.push({ at: w.now, id: r.id, kind: r.kind, title: titleOf(r.data, r.id), what: 'kept-workspace' });
    return take(w, r);
  }
  if (!base) {
    // No base known (older pending entry): last writer wins.
    if (pending > r.rev) return;
    return take(w, r);
  }
  if (base.rev === r.rev) return; // the server is still where our edit started: it applies as is
  const m = merge3(base, w.merged.get(r.id), r, pending);
  if (m.note) w.notes.push({ at: w.now, ...m.note });
  if (m.pending) rebase(w, r, m.rec);
  else take(w, { ...r, ...(m.rec ? { data: m.rec.data, parent: m.rec.parent } : {}) });
}

/** A plan/goal deleted on the server while this device still has unsent content in it. */
function hasPendingChildren(w: Work, wsId: string): boolean {
  for (const id of Object.keys(w.outbox)) if (w.merged.get(id)?.parent === wsId) return true;
  return false;
}

function incoming(w: Work, r: SyncRecord, reason?: Rejection['reason']) {
  if (w.outbox[r.id]) return settle(w, r, reason);
  const known = w.revs[r.id];
  if (known && known > r.rev) return; // we hold something newer (the server will hear of it)
  if (r.deleted && isWsKind(r.kind) && w.merged.has(r.id) && hasPendingChildren(w, r.id)) {
    w.notes.push({ at: w.now, id: r.id, kind: r.kind, title: titleOf(w.merged.get(r.id)!.data, r.id), what: 'kept-workspace' });
    return rebase(w, r, w.merged.get(r.id));
  }
  take(w, r);
}

/**
 * Merge a server response into the CURRENT state (which may have changed while the
 * request was in flight). Sent entries the server applied are acknowledged — or, if
 * edited again meanwhile, now based on what was sent. Refused ones stay pending and are
 * merged with the server's current version.
 */
export function applyResponse(current: AppState, meta: SyncMeta, sent: SyncRecord[], response: SyncResponse, now = Date.now()): Applied {
  const w = startWork(current, meta, now);
  const refused = new Map((response.rejected ?? []).map((r) => [r.id, r.reason]));
  for (const c of sent) {
    if (refused.has(c.id)) continue;
    if (w.outbox[c.id] === c.rev) {
      delete w.outbox[c.id];
      delete w.bases[c.id];
    } else if (w.outbox[c.id]) {
      w.bases[c.id] = { rev: c.rev, data: c.deleted ? undefined : c.data, parent: c.parent };
    }
  }
  const returned = new Set(response.records.map((r) => r.id));
  for (const r of response.records) incoming(w, r, refused.get(r.id));
  // Refused as a conflict but the server has no such record (any more): it is new there.
  for (const [id, reason] of refused) if (reason === 'conflict' && !returned.has(id) && w.bases[id]) w.bases[id] = { rev: '' };
  return finish(w, current, meta, { cursor: response.cursor, cursorTag: response.cursorTag, synced: true }, response.records);
}

/**
 * Full reconciliation against everything a server holds (first contact, another
 * server, or a server whose history went back). Per record: a pending edit is merged
 * with the server's version (or, without a known base, the newer revision wins); what
 * only this device has is queued for upload. A record this device never edited itself
 * (no revision: older data, untouched defaults) yields to the server — except settings
 * changed before revisions existed, which compete by their own edit time.
 */
export function reconcile(current: AppState, meta: SyncMeta, server: SyncResponse, now = Date.now()): Applied {
  const w = startWork(current, meta, now);
  const local = new Map(w.merged);
  const fresh = () => {
    const m = mintRev(w.clientId, w.t + 1);
    w.t = m.t;
    return m.rev;
  };
  const refused = new Map((server.rejected ?? []).map((r) => [r.id, r.reason]));
  const onServer = new Set(server.records.map((r) => r.id));
  // First, what only this device has: queued as new. (Before looking at the server's
  // records, so a plan deleted there still sees the new content this device put in it.)
  for (const [id, r] of local) {
    if (onServer.has(id) || isUntouchedDefault(r)) continue;
    if (!w.outbox[id]) w.outbox[id] = w.revs[id] ??= fresh();
    w.bases[id] = { rev: '' };
  }
  for (const r of server.records) {
    const known = w.outbox[r.id] ?? w.revs[r.id];
    if (known === r.rev && !refused.has(r.id)) {
      delete w.outbox[r.id]; // the server has exactly our version
      delete w.bases[r.id];
      continue;
    }
    if (w.outbox[r.id]) {
      settle(w, r, refused.get(r.id));
      continue;
    }
    if (known && known > r.rev) {
      // We hold a newer version the server lost (e.g. restored backup): send it on top of theirs.
      w.outbox[r.id] = known;
      w.bases[r.id] = { rev: r.rev, data: r.deleted ? undefined : r.data, parent: r.parent };
      continue;
    }
    const l = local.get(r.id);
    if (!known && !r.deleted && l && (r.kind === 'settings' || r.kind === 'hie') && !isUntouchedDefault(l)) {
      const localAt = (l.data as { updatedAt?: number }).updatedAt ?? 0;
      const remoteAt = (r.data as { updatedAt?: number } | undefined)?.updatedAt ?? revTime(r.rev);
      if (localAt > remoteAt) {
        w.outbox[r.id] = w.revs[r.id] = fresh();
        w.bases[r.id] = { rev: r.rev, data: r.data, parent: r.parent };
        continue;
      }
    }
    incoming(w, r);
  }
  // A pending deletion of something the server never had: nothing to tell it.
  for (const id of Object.keys(w.outbox)) {
    if (!onServer.has(id) && !w.merged.has(id)) {
      delete w.outbox[id];
      delete w.bases[id];
    }
  }
  return finish(w, current, meta, { cursor: server.cursor, cursorTag: server.cursorTag }, server.records);
}

/** Change one record of a state (used to act on a conflict note). */
export function withRecord(state: AppState, id: string, fn: (r: Rec | undefined) => Rec | undefined): AppState {
  const recs = decompose(state);
  const next = fn(recs.get(id));
  if (next) recs.set(id, next);
  else recs.delete(id);
  return compose(recs.values(), state.ui);
}

/**
 * Bring a stored meta to the current format. Older versions kept a `base` of content
 * hashes instead of revisions: whatever differed from it was an unsent local change,
 * so it becomes the outbox (once, from a state/meta pair that was written atomically).
 */
export function migrateMeta(raw: unknown, state: AppState, now = Date.now()): SyncMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<SyncMeta> & { base?: Record<string, string> };
  if (typeof m.clientId !== 'string') return null;
  const meta: SyncMeta = {
    clientId: m.clientId,
    lastT: Number(m.lastT) || 0,
    revs: m.revs ?? {},
    outbox: m.outbox ?? {},
    url: m.url,
    cursor: Number(m.cursor) || 0,
    cursorTag: m.cursorTag,
    synced: m.synced,
    bases: m.bases ?? {},
    conflicts: m.conflicts ?? [],
  };
  if (m.base && !m.revs) {
    const base = m.base;
    const recs = decompose(state);
    // One revision for the whole set of unsent changes, as if made in one edit.
    const { rev, t } = mintRev(meta.clientId, Math.max(now, meta.lastT + 1));
    for (const [id, r] of recs) {
      if (base[id] === undefined && isUntouchedDefault(r)) continue;
      if (base[id] !== recHash(r)) meta.outbox[id] = meta.revs[id] = rev;
    }
    for (const id of Object.keys(base)) if (!recs.has(id)) meta.outbox[id] = meta.revs[id] = rev;
    meta.lastT = t;
    meta.synced = meta.cursor > 0 || Object.keys(base).length > 0;
  }
  return meta;
}
