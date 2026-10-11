// Local-first sync, record level.
//
// The nested AppState is decomposed into flat records (plan meta, phase, task,
// version, log entry, session, …). Each sync compares the current records with
// the snapshot from the last successful sync, so domain operations never have to
// track revisions themselves. Conflicts resolve last-writer-wins per record using
// a monotonic revision; deletions travel as tombstones. Log entries, versions and
// checkpoints are immutable, so in practice they just union across devices.
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
}

export interface SyncRequest {
  clientId: string;
  cursor: number;
  changes: SyncRecord[];
  /** The user confirmed a mass deletion of up to this many records (see DeleteGuard). */
  confirmDeletes?: number;
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
}

export interface SyncResponse {
  cursor: number;
  records: SyncRecord[];
}

/** What a client persists between syncs. */
export interface SyncMeta {
  clientId: string;
  cursor: number;
  /** id → content hash, as of the last successful sync. */
  base: Record<string, string>;
  /** Last revision timestamp issued by this client (ms). */
  lastT: number;
  /** Server this bookkeeping belongs to; a cursor/base is meaningless against any other. */
  url?: string;
}

export function newSyncMeta(clientId = randomId()): SyncMeta {
  return { clientId, cursor: 0, base: {}, lastT: 0 };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ───────────────────────── revisions ─────────────────────────

/** Fixed-width so plain string comparison orders revisions by time, then client. */
export function makeRev(t: number, clientId: string): string {
  return `${t.toString(36).padStart(9, '0')}.${clientId}`;
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

export interface Prepared {
  request: SyncRequest;
  /** Records as they were when the request was built. */
  snapshot: Map<string, Rec>;
  /** Hashes of the snapshot, for detecting edits made while the request was in flight. */
  hashes: Map<string, string>;
  lastT: number;
}

/** Diff current state against the last synced base and stamp the changes. */
export function prepareSync(state: AppState, meta: SyncMeta, now = Date.now()): Prepared {
  const snapshot = decompose(state);
  const hashes = new Map<string, string>();
  const changes: SyncRecord[] = [];
  let t = Math.max(now, meta.lastT);
  const next = () => makeRev(++t, meta.clientId);
  for (const [id, r] of snapshot) {
    const h = hashData(r.data) + (r.parent ?? '');
    hashes.set(id, h);
    // Untouched defaults are "unset", not a choice: never let them overwrite another
    // device's settings. Once synced, changing back to the default is a real change.
    if (meta.base[id] === undefined && isUntouchedDefault(r)) continue;
    if (meta.base[id] !== h) changes.push({ id, kind: r.kind, parent: r.parent, rev: next(), data: r.data });
  }
  for (const id of Object.keys(meta.base)) {
    if (!snapshot.has(id)) changes.push({ id, kind: kindOf(id), rev: next(), deleted: true });
  }
  return { request: { clientId: meta.clientId, cursor: meta.cursor, changes }, snapshot, hashes, lastT: t };
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

/**
 * Merge the server's answer into the *current* state. Records the user edited
 * while the request was in flight win locally and are pushed on the next sync.
 */
export function applySync(
  current: AppState,
  prepared: Prepared,
  response: SyncResponse,
  meta: SyncMeta,
  opts: { pullOnly?: boolean } = {},
): { state: AppState; meta: SyncMeta; changed: boolean } {
  const now = decompose(current);
  const editedSince = (id: string) => {
    const a = now.get(id);
    const before = prepared.hashes.get(id);
    if (!a) return before !== undefined; // deleted locally during flight
    return hashData(a.data) + (a.parent ?? '') !== before;
  };
  const merged = new Map(now);
  const base: Record<string, string> = {};
  if (!opts.pullOnly) {
    // Everything we sent is now the shared truth (unless edited again meanwhile).
    for (const [id, h] of prepared.hashes) if (!editedSince(id)) base[id] = h;
  }
  // Records edited or deleted while the request was in flight keep their *old* base
  // entry, so the next round still sends them — for a deletion that is what produces
  // the tombstone (a record missing from both snapshot and base would be forgotten).
  for (const id of new Set([...prepared.hashes.keys(), ...Object.keys(meta.base)])) {
    if (!(id in base) && editedSince(id) && (meta.base[id] !== undefined || (!opts.pullOnly && prepared.hashes.has(id)))) {
      base[id] = meta.base[id] ?? `inflight:${prepared.hashes.get(id)}`;
    }
  }
  let changed = false;
  for (const r of response.records) {
    if (editedSince(r.id)) continue;
    // First contact: a setting this device changed itself (offline, before ever syncing)
    // competes with the server's by *when it was changed*, not who talks first.
    if (opts.pullOnly && !r.deleted && (r.kind === 'settings' || r.kind === 'hie')) {
      const mine = now.get(r.id);
      if (mine && !isUntouchedDefault(mine)) {
        const localAt = (mine.data as { updatedAt?: number }).updatedAt ?? 0;
        const remoteAt = (r.data as { updatedAt?: number } | undefined)?.updatedAt ?? revTime(r.rev);
        if (localAt > remoteAt) continue; // keep ours; it isn't in base, so it gets pushed next
      }
    }
    if (r.deleted) {
      if (merged.delete(r.id)) changed = true;
      delete base[r.id];
      continue;
    }
    const rec: Rec = { id: r.id, kind: r.kind, parent: r.parent, data: r.data };
    const h = hashData(rec.data) + (rec.parent ?? '');
    if ((merged.get(r.id) && hashData(merged.get(r.id)!.data) + (merged.get(r.id)!.parent ?? '')) !== h) changed = true;
    merged.set(r.id, rec);
    base[r.id] = h;
  }
  const maxRemoteT = response.records.reduce((m, r) => Math.max(m, revTime(r.rev) || 0), 0);
  return {
    state: changed ? compose(merged.values(), current.ui) : current,
    meta: { ...meta, cursor: response.cursor, base, lastT: Math.max(prepared.lastT, maxRemoteT) },
    changed,
  };
}
