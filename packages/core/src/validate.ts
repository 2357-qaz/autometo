// Identity checks for imported or stored data. Sync splits the state into records keyed
// by entity id, so two entities sharing an id would silently collapse into one.
import { normalize } from './state';
import { decompose } from './sync';
import type { AppState } from './types';

/** Record ids that more than one entity maps to (each listed once). */
export function duplicateRecordIds(s: AppState): string[] {
  const dup = new Set<string>();
  decompose(s, (id) => {
    // Two identical fatigue marks are the same fact; anything else is a real collision.
    if (!id.startsWith('fat:')) dup.add(id);
  });
  return [...dup];
}

const TASK = new Set(['pending', 'active', 'done', 'blocked', 'skipped']);
const PHASE = new Set(['pending', 'active', 'done']);
const WS = new Set(['active', 'paused', 'done', 'archived']);
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);

/**
 * Validate a backup before it replaces the local data. Throws a readable message
 * instead of accepting something that sync would later lose or mangle.
 */
export function parseImport(raw: unknown): AppState {
  const s = normalize(raw);
  const problems: string[] = [];
  for (const w of [...s.plans, ...s.goals]) {
    if (!WS.has(w.status)) problems.push(`「${w.title}」的状态无效：${String(w.status)}`);
    if (!finite(w.createdAt)) problems.push(`「${w.title}」缺少有效的创建时间`);
    for (const t of w.kind === 'plan' ? w.tasks : w.moves) {
      if (typeof t.id !== 'string' || !t.id) problems.push(`「${w.title}」里有任务缺少 id`);
      if (!TASK.has(t.status)) problems.push(`任务「${t.title}」的状态无效：${String(t.status)}`);
    }
    if (w.kind === 'plan') for (const ph of w.phases) if (!PHASE.has(ph.status)) problems.push(`阶段「${ph.title}」的状态无效：${String(ph.status)}`);
    for (const e of w.log) if (!finite(e.at)) problems.push(`「${w.title}」的日志里有无效时间`);
  }
  for (const x of s.sessions) if (!finite(x.startedAt)) problems.push('有 Session 缺少有效的开始时间');
  const dups = duplicateRecordIds(s);
  if (dups.length) problems.push(`有 ${dups.length} 个 ID 被多条数据共用（如 ${dups.slice(0, 3).join('、')}），同步时会互相覆盖`);
  if (problems.length) throw new Error(`备份校验没有通过，已拒绝导入（本地数据未改动）：${problems.slice(0, 5).join('；')}${problems.length > 5 ? ` 等 ${problems.length} 处` : ''}`);
  return s;
}

/**
 * Stored data with colliding ids (e.g. from an older import): keep every entity by
 * giving later duplicates a deterministic new id, so all devices repair it the same way.
 */
export function repairDuplicateIds(s: AppState): AppState {
  if (!duplicateRecordIds(s).length) return s;
  const seen = new Set<string>();
  const unique = <T extends { id: string }>(prefix: string, x: T): T => {
    let id = x.id;
    for (let n = 2; seen.has(`${prefix}${id}`); n++) id = `${x.id}~${n}`;
    seen.add(`${prefix}${id}`);
    return id === x.id ? x : { ...x, id };
  };
  const out = structuredClone(s);
  for (const p of out.plans) {
    Object.assign(p, unique('plan:', p));
    p.phases = p.phases.map((x) => unique('phase:', x));
    p.tasks = p.tasks.map((x) => unique('task:', x));
    p.log = p.log.map((x) => unique('log:', x));
  }
  for (const g of out.goals) {
    Object.assign(g, unique('goal:', g));
    g.moves = g.moves.map((x) => unique('task:', x));
    g.checkpoints = g.checkpoints.map((x) => unique('cp:', x));
    g.log = g.log.map((x) => unique('log:', x));
  }
  out.sessions = out.sessions.map((x) => unique('ses:', x));
  out.compacts = out.compacts.map((x) => unique('cmp:', x));
  return out;
}
