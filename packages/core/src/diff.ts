// Plan Diff: compare a committed plan version against what actually happened.
import type { DiffLine, LogEntry, Plan, PlanVersion, Task } from './types';
import { dueAt, orderedTasks } from './ops';
import { DAY, fmtDate } from './util';

export interface PhaseDiff {
  phaseId: string;
  title: string;
  sign: ' ' | '+' | '-' | '~';
  lines: DiffLine[];
}

export interface PlanDiff {
  base: PlanVersion;
  phases: PhaseDiff[];
  stats: { added: number; removed: number; changed: number; deferred: number; blocked: number; late: number; revisions: number };
  firstDrift: LogEntry | null;
  firstDriftPhase: string | null;
}

const GLYPH: Record<Task['status'], string> = { pending: '☐', active: '◼', done: '☒', blocked: '✗', skipped: '⊘' };

/** Event types that mean "reality departed from the committed plan". */
const DRIFT: LogEntry['type'][] = ['add', 'remove', 'defer', 'revise', 'skip', 'block', 'phase-add'];

export function isDrift(e: LogEntry): boolean {
  if (DRIFT.includes(e.type)) return true;
  // Renames or moves of tasks/phases also count; plain objective tweaks do not.
  return e.type === 'edit' && !!e.diff?.some((l) => l.sign === '-' || l.note?.includes('→') || l.text.startsWith('阶段') || l.text.includes('目标日期'));
}

export function diffPlan(p: Plan, version?: number, now = Date.now()): PlanDiff | null {
  const base = version != null ? p.versions.find((v) => v.v === version) : p.versions[0];
  if (!base) return null;
  const after = p.log.filter((e) => e.at >= base.at);
  const deferCount = new Map<string, number>();
  const blockCount = new Map<string, number>();
  for (const e of after) {
    if (e.taskId && e.type === 'defer') deferCount.set(e.taskId, (deferCount.get(e.taskId) ?? 0) + 1);
    if (e.taskId && e.type === 'block') blockCount.set(e.taskId, (blockCount.get(e.taskId) ?? 0) + 1);
  }
  const addedAt = new Map(after.filter((e) => e.type === 'add' && e.taskId).map((e) => [e.taskId!, e.at]));
  const baseTask = new Map(base.tasks.map((t) => [t.id, t]));
  const basePhase = new Map(base.phases.map((ph) => [ph.id, ph]));
  const ordered = orderedTasks(p);
  const num = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const stats = { added: 0, removed: 0, changed: 0, deferred: 0, blocked: 0, late: 0, revisions: p.versions.filter((v) => v.v > base.v).length };

  const phases: PhaseDiff[] = [];
  const seenTasks = new Set<string>();
  for (const ph of p.phases) {
    const bp = basePhase.get(ph.id);
    const lines: DiffLine[] = [];
    let sign: PhaseDiff['sign'] = bp ? ' ' : '+';
    if (bp && bp.title !== ph.title) {
      lines.push({ sign: '~', text: `阶段  ${bp.title} → ${ph.title}` });
      sign = '~';
    }
    if (bp && bp.goal !== ph.goal) {
      lines.push({ sign: '-', text: `目标  ${bp.goal || '（无）'}` }, { sign: '+', text: `目标  ${ph.goal || '（无）'}` });
      sign = '~';
      stats.changed++;
    }
    // Schedule: planned due vs actual completion.
    const due = ph.due ?? bp?.due;
    if (due) {
      const end = dueAt(due);
      if (ph.status === 'done' && ph.doneAt && ph.doneAt > end) {
        lines.push({ sign: '!', text: `计划 ${due.slice(5)} → 完成 ${fmtDate(ph.doneAt).slice(5)}`, note: `+${Math.ceil((ph.doneAt - end) / DAY)}d` });
        stats.late++;
      } else if (ph.status !== 'done' && now > end) {
        lines.push({ sign: '!', text: `计划 ${due.slice(5)} 完成 · 尚未完成`, note: `+${Math.ceil((now - end) / DAY)}d` });
        stats.late++;
      }
      if (bp?.due && ph.due && bp.due !== ph.due) lines.push({ sign: '~', text: `目标日期  ${bp.due} → ${ph.due}` });
    }
    if (!bp) stats.added++;
    for (const t of ordered.filter((x) => x.phaseId === ph.id)) {
      seenTasks.add(t.id);
      const bt = baseTask.get(t.id);
      const n = num(t.id);
      const g = GLYPH[t.status];
      const notes: string[] = [];
      const dc = deferCount.get(t.id);
      const bc = blockCount.get(t.id);
      if (dc) {
        notes.push(`延期 ×${dc}`);
        stats.deferred++;
      }
      if (bc) {
        notes.push(`阻塞 ×${bc}`);
        stats.blocked++;
      }
      if (!bt) {
        if (t.status === 'skipped') continue;
        const at = addedAt.get(t.id);
        lines.push({ sign: '+', num: n, text: `${g} ${t.title}`, note: [`新增${at ? ' ' + fmtDate(at).slice(5) : ''}`, ...notes].join(' · ') });
        stats.added++;
      } else if (t.status === 'skipped') {
        lines.push({ sign: '-', num: n, text: `☐ ${bt.title}`, note: '跳过' });
        stats.removed++;
      } else if (bt.title !== t.title || bt.phaseId !== t.phaseId) {
        const moved = bt.phaseId !== t.phaseId ? `从「${basePhase.get(bt.phaseId ?? '')?.title ?? '?'}」移入` : '';
        if (bt.title !== t.title) lines.push({ sign: '-', num: n, text: `☐ ${bt.title}` });
        lines.push({ sign: bt.title !== t.title ? '+' : '~', num: n, text: `${g} ${t.title}`, note: [moved, ...notes].filter(Boolean).join(' · ') || undefined });
        stats.changed++;
      } else {
        lines.push({ sign: notes.length ? '!' : ' ', num: n, text: `${g} ${t.title}`, note: notes.join(' · ') || undefined });
      }
    }
    // Tasks from the baseline that no longer exist in this phase.
    for (const bt of base.tasks.filter((x) => x.phaseId === ph.id)) {
      if (!p.tasks.some((t) => t.id === bt.id)) {
        lines.push({ sign: '-', text: `☐ ${bt.title}`, note: '移除' });
        stats.removed++;
      }
    }
    if (sign === ' ' && lines.some((l) => l.sign !== ' ')) sign = '~';
    phases.push({ phaseId: ph.id, title: ph.title, sign, lines });
  }
  // Whole phases that were removed.
  for (const bp of base.phases) {
    if (p.phases.some((x) => x.id === bp.id)) continue;
    const lines = base.tasks.filter((t) => t.phaseId === bp.id && !seenTasks.has(t.id) && !p.tasks.some((x) => x.id === t.id)).map((t) => ({ sign: '-' as const, text: `☐ ${t.title}` }));
    stats.removed += 1 + lines.length;
    phases.push({ phaseId: bp.id, title: bp.title, sign: '-', lines });
  }

  const firstDrift = after.find((e) => e.at > base.at && isDrift(e)) ?? null;
  let firstDriftPhase: string | null = null;
  if (firstDrift) {
    const pid = firstDrift.phaseId ?? p.tasks.find((t) => t.id === firstDrift.taskId)?.phaseId;
    firstDriftPhase = p.phases.find((x) => x.id === pid)?.title ?? basePhase.get(pid ?? '')?.title ?? null;
  }
  return { base, phases, stats, firstDrift, firstDriftPhase };
}

/** One-line summary like "+2 −1 ~1", or null when nothing changed. */
export function diffSummary(d: PlanDiff): string | null {
  const { added, removed, changed, deferred, late } = d.stats;
  const parts = [added && `+${added}`, removed && `−${removed}`, changed && `~${changed}`, deferred && `延期 ${deferred}`, late && `逾期 ${late}`].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}
