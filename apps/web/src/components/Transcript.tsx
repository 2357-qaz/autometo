import { useState, type ReactNode } from 'react';
import type { DiffLine, LogEntry, Plan, Session, Workspace } from '@automedo/core';
import { useApp } from '../ctx';
import { diffPlan } from '@automedo/core';
import { EffortLabel, TierLabel } from './Hie';
import { fmtDate, fmtDuration, fmtTokens, startOfDay } from '@automedo/core';
import { DiffLines } from './DiffLines';

type Block =
  | { key: string; kind: 'session'; runId: string; start?: LogEntry; end?: LogEntry; events: LogEntry[]; at: number }
  | { key: string; kind: 'loose'; events: LogEntry[]; at: number };

const STRUCTURAL: LogEntry['type'][] = ['add', 'remove', 'edit', 'phase-add'];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function dayLabel(t: number): string {
  const d = new Date(t);
  const today = startOfDay(Date.now());
  const sod = startOfDay(t);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (sod === today) return `今天 · ${md}`;
  if (sod === today - 86_400_000) return `昨天 · ${md}`;
  return `${md} 周${WEEK[d.getDay()]}`;
}

function buildBlocks(log: LogEntry[]): Block[] {
  const out: Block[] = [];
  const open = new Map<string, Extract<Block, { kind: 'session' }>>();
  for (const e of log) {
    if (e.type === 'session-start' && e.runId) {
      const b = { key: e.id, kind: 'session' as const, runId: e.runId, start: e, events: [], at: e.at };
      open.set(e.runId, b);
      out.push(b);
      continue;
    }
    const sb = e.runId ? open.get(e.runId) : undefined;
    if (sb) {
      if (e.type === 'session-end') {
        sb.end = e;
        open.delete(e.runId!);
      } else sb.events.push(e);
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === 'loose' && startOfDay(last.at) === startOfDay(e.at) && !open.size) last.events.push(e);
    else out.push({ key: e.id, kind: 'loose', events: [e], at: e.at });
  }
  return out;
}

/** Merge consecutive structural edits into one Update(...) item, like a single file edit. */
type Item = { kind: 'event'; e: LogEntry } | { kind: 'update'; events: LogEntry[] };
function toItems(events: LogEntry[]): Item[] {
  const out: Item[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (STRUCTURAL.includes(e.type)) {
      if (last?.kind === 'update' && e.at - last.events[last.events.length - 1].at < 30 * 60_000) last.events.push(e);
      else out.push({ kind: 'update', events: [e] });
    } else out.push({ kind: 'event', e });
  }
  return out;
}

function Tool(props: { name: string; arg?: ReactNode; color?: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ev">
      <div className="ev-h">
        <span className={`dot ${props.color ?? ''}`}>⏺</span>
        <span className="ev-name">
          <span className="bold">{props.name}</span>
          {props.arg != null && <>(<span className="ev-arg">{props.arg}</span>)</>}
        </span>
        {props.meta && <span className="ev-meta">{props.meta}</span>}
      </div>
      {props.children && (
        <div className="ev-b">
          <span className="elbow">⎿</span>
          <div>{props.children}</div>
        </div>
      )}
    </div>
  );
}

function durTok(e: LogEntry) {
  if (e.durMs == null) return null;
  return (
    <>
      {fmtDuration(e.durMs).replace(/ \d+s$/, '')}
      {e.tokens ? ` · ↑ ${fmtTokens(e.tokens)}` : ''}
    </>
  );
}

function summarize(lines: DiffLine[]): string {
  const a = lines.filter((l) => l.sign === '+').length;
  const r = lines.filter((l) => l.sign === '-').length;
  const m = lines.filter((l) => l.sign === '~').length;
  return [a && `${a} 处新增`, r && `${r} 处移除`, m && `${m} 处修改`].filter(Boolean).join('，') || '已更新';
}

function EventView({ e, ws }: { e: LogEntry; ws: Workspace }) {
  const t = e.title ?? '';
  switch (e.type) {
    case 'create':
      return (
        <div className="ev ev-create">
          <span className="accent">✻</span> {e.text}
        </div>
      );
    case 'start':
      return <Tool name="Start" arg={t} color="accent">{e.detail && <span className="dim">{e.detail}</span>}</Tool>;
    case 'done':
      return <Tool name="Done" arg={t} color="green" meta={durTok(e)}>{e.reason && <span className="dim">{e.reason}</span>}</Tool>;
    case 'block':
      return <Tool name="Block" arg={t} color="red"><span className={e.reason ? 'fg-2' : 'faint'}>{e.reason ?? '（未写原因）'}</span></Tool>;
    case 'unblock':
      return <Tool name="Unblock" arg={t} color="dimdot" />;
    case 'pause':
      return <Tool name="Pause" arg={t} color="dimdot" />;
    case 'reopen':
      return <Tool name="Reopen" arg={t} color="yellow" />;
    case 'skip':
      return (
        <Tool name="Skip" arg={t} color="yellow">
          {e.diff && <DiffLines lines={e.diff} />}
          {e.reason && <div className="dim">{e.reason}</div>}
        </Tool>
      );
    case 'defer':
      return (
        <Tool name="Defer" arg={t} color="yellow">
          <span className="dim">{e.detail}</span>
          {e.reason && <div className="fg-2">原因：{e.reason}</div>}
        </Tool>
      );
    case 'split':
      return (
        <Tool name="Split" arg={t} color="pink">
          {e.diff && <DiffLines lines={e.diff} />}
          {e.reason && <div className="fg-2">完成标准：{e.reason}</div>}
          {e.detail && <div className="dim">{e.detail}</div>}
        </Tool>
      );
    case 'revise':
      return (
        <Tool name="Update" arg={ws.kind === 'plan' ? 'Plan' : 'Goal'} color="blue" meta={e.detail}>
          <span className="dim">修正「{t}」的阶段目标</span>
          {e.diff && <DiffLines lines={e.diff} />}
          {e.reason && <div className="reason">原因：{e.reason}</div>}
        </Tool>
      );
    case 'commit':
      return <Tool name="Commit" arg={`v${e.version}`} color="teal"><span className="dim">{e.detail}</span></Tool>;
    case 'phase':
      return <Tool name="Phase" arg={t} color="teal"><span className="dim">{e.detail ?? e.text}</span></Tool>;
    case 'note':
      return (
        <div className="ev ev-note">
          <span className="faint">#</span> <span className="pre">{e.text}</span>
        </div>
      );
    case 'checkpoint':
      return (
        <Tool name="Checkpoint" arg={`#${e.version}`} color="violet" meta={e.detail}>
          {e.reason && <div className="fg-2">学到：{e.reason}</div>}
          {e.diff && <DiffLines lines={e.diff} />}
        </Tool>
      );
    case 'compact':
      return <Tool name="Compact" color="blue"><span className="dim">保存了工作快照，可在下次 Resume</span></Tool>;
    case 'legacy':
    default:
      return (
        <div className="ev ev-note">
          <span className="faint">·</span> <span className="dim pre">{e.text}</span>
        </div>
      );
  }
}

function UpdateView({ events, ws }: { events: LogEntry[]; ws: Workspace }) {
  const lines = events.flatMap((e) => e.diff ?? [{ sign: '~' as const, text: e.text }]);
  // Before the baseline exists we are still writing the plan, not changing it.
  const writing = ws.kind === 'plan' && (!ws.versions.length || events[0].at < ws.versions[0].at);
  return (
    <Tool name={writing ? 'Write' : 'Update'} arg={ws.kind === 'plan' ? 'Plan' : 'Goal'} color="blue">
      <span className="dim">{summarize(lines)}</span>
      <DiffLines lines={lines} />
    </Tool>
  );
}

function SessionHead({ start, seg }: { start?: LogEntry; seg?: Session }) {
  return (
    <div className="user-msg">
      <span className="caret">&gt;</span>
      <span className="grow">{start?.title || <span className="dim">专注 Session</span>}</span>
      <span className="nowrap um-meta">
        {seg ? (
          <>
            <TierLabel tier={seg.tier} /> <EffortLabel effort={seg.effort} /> <span className="faint">· {seg.plannedMin}m</span>
          </>
        ) : (
          <span className="faint">{start?.detail}</span>
        )}
      </span>
    </div>
  );
}

function SessionEnd({ e }: { e: LogEntry }) {
  return (
    <div className="ev ev-end">
      <div>
        <span className="accent">✻</span> <span className="dim">Session 结束 · {fmtDuration(e.durMs ?? 0).replace(/ \d+s$/, '')} · ↑ {fmtTokens(e.tokens ?? 0)} tokens{e.detail ? ` · ${e.detail}` : ''}</span>
      </div>
      {e.reason && (
        <div className="ev-b">
          <span className="elbow">⎿</span>
          <div className="fg-2">{e.reason}</div>
        </div>
      )}
    </div>
  );
}

export function Transcript({ ws, diff, onCloseDiff, onDiff }: { ws: Workspace; diff: { planId: string; v?: number; at: number } | null; onCloseDiff: () => void; onDiff: (v?: number) => void }) {
  const { state } = useApp();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const blocks = buildBlocks(ws.log);
  const today = startOfDay(Date.now());
  let lastDay = -1;

  return (
    <div className="transcript">
      {blocks.map((b, i) => {
        const day = startOfDay(b.at);
        const sep = day !== lastDay ? <div className="day-sep" key={b.key + 'sep'}><span>{dayLabel(b.at)}</span></div> : null;
        lastDay = day;
        const live = b.kind === 'session' && !b.end;
        const collapsed = !live && !expanded.has(b.key) && day !== today && i < blocks.length - 2;
        const toggle = () => setExpanded((s) => { const n = new Set(s); if (n.has(b.key)) n.delete(b.key); else n.add(b.key); return n; });
        const seg = b.kind === 'session' ? state.sessions.find((x) => x.runId === b.runId) : undefined;
        if (collapsed) {
          const n = b.events.length;
          return (
            <div key={b.key}>
              {sep}
              <button className="collapsed" onClick={toggle}>
                <span className="faint">▸</span>{' '}
                {b.kind === 'session' ? (
                  <>
                    <span className="fg-2">{b.start?.title || '专注 Session'}</span>
                    <span className="faint"> · {b.end?.durMs ? fmtDuration(b.end.durMs).replace(/ \d+s$/, '') : ''}{b.end?.tokens ? ` · ↑ ${fmtTokens(b.end.tokens)}` : ''} · {n} 个事件</span>
                  </>
                ) : (
                  <span className="faint">{n} 个事件 · {b.events.slice(0, 3).map((e) => e.title ?? e.text).join('，')}{n > 3 ? '…' : ''}</span>
                )}
              </button>
            </div>
          );
        }
        return (
          <div key={b.key} className={`blk ${b.kind}`}>
            {sep}
            {b.kind === 'session' && <SessionHead start={b.start} seg={seg} />}
            {toItems(b.events).map((it, j) =>
              it.kind === 'event' ? <EventView key={it.e.id} e={it.e} ws={ws} /> : <UpdateView key={it.events[0].id + j} events={it.events} ws={ws} />,
            )}
            {b.kind === 'session' && b.end && <SessionEnd e={b.end} />}
            {expanded.has(b.key) && (
              <button className="collapsed" onClick={toggle}><span className="faint">▴ 收起</span></button>
            )}
          </div>
        );
      })}
      {diff && ws.kind === 'plan' && diff.planId === ws.id && <PlanDiffView plan={ws} v={diff.v} onClose={onCloseDiff} onPick={onDiff} />}
    </div>
  );
}

export function PlanDiffView({ plan, v, onClose, onPick }: { plan: Plan; v?: number; onClose: () => void; onPick: (v?: number) => void }) {
  const d = diffPlan(plan, v);
  if (!d) return null;
  const { stats } = d;
  const head = [
    stats.added && `+${stats.added}`,
    stats.removed && `−${stats.removed}`,
    stats.changed && `~${stats.changed}`,
    stats.deferred && `延期 ${stats.deferred}`,
    stats.blocked && `阻塞 ${stats.blocked}`,
    stats.late && `逾期 ${stats.late}`,
    stats.revisions && `修正 ${stats.revisions} 次`,
  ].filter(Boolean).join(' · ');
  const base = d.base;
  return (
    <div className="ev diff-block" id="plan-diff">
      <div className="ev-h">
        <span className="dot blue">⏺</span>
        <span className="ev-name"><span className="bold">Diff</span>(<span className="ev-arg">v{base.v} → 现在</span>)</span>
        <span className="ev-meta">
          {plan.versions.map((x) => (
            <button key={x.v} className={`vbtn ${x.v === base.v ? 'on' : ''}`} onClick={() => onPick(x.v)} title={x.message}>v{x.v}</button>
          ))}
          <button className="vbtn" onClick={onClose} title="关闭">✕</button>
        </span>
      </div>
      <div className="ev-b">
        <span className="elbow">⎿</span>
        <div>
          <div className="dim">{head || '与计划完全一致'}　<span className="faint">基准 v{base.v} · {fmtDate(base.at)} · {base.message}</span></div>
          {d.phases.map((ph) => (
            <div key={ph.phaseId} className="diff-phase">
              <div className={`dph s-${ph.sign === '+' ? 'add' : ph.sign === '-' ? 'del' : ph.sign === '~' ? 'mod' : 'ctx'}`}>
                <span className="sg">{ph.sign === ' ' ? '' : ph.sign}</span>## {ph.title}
              </div>
              <DiffLines lines={ph.lines} />
            </div>
          ))}
          {d.firstDrift ? (
            <div className="drift">
              ⚑ 首次偏离：{fmtDate(d.firstDrift.at)}
              {d.firstDriftPhase && <> · 「{d.firstDriftPhase}」</>} · <span className="fg-2">{d.firstDrift.text}</span>
            </div>
          ) : (
            <div className="drift ok">✓ 目前还没有偏离基准</div>
          )}
        </div>
      </div>
    </div>
  );
}
