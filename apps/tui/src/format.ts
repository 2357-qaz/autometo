// Turns AuTomeDo data into coloured text lines. Used by both the Ink UI
// (rendered as <Text>) and one-shot CLI commands (rendered as ANSI).
import {
  diffPlan,
  fmtDate,
  fmtDuration,
  fmtTokens,
  startOfDay,
  TIERS,
  type DiffLine,
  type Effort,
  type LogEntry,
  type Plan,
  type Session,
  type Tier,
  type Workspace,
} from '@automedo/core';
import { checkpointDue, currentPhase, diffSummary, dueAt, fmtAgo, nextCheckpointAt, orderedTasks, type Goal } from './core-ops';

/** Terminal display width: CJK / full-width characters take two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

export function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(1, width - displayWidth(s)));
}

export const C = {
  accent: '#d97757',
  link: '#e9a283',
  teal: '#4fb3a6',
  violet: '#a68cf2',
  green: '#6fbf73',
  red: '#ef6f6c',
  yellow: '#e5b85c',
  blue: '#7aa7e0',
  fg: '#e8e6dc',
  fg2: '#c2bfb4',
  dim: '#8b887f',
  faint: '#5f5c55',
  addBg: '#1d3220',
  delBg: '#3a1f1f',
  addFg: '#9fd9a2',
  delFg: '#f2a19f',
} as const;

export interface Seg {
  t: string;
  c?: string;
  bg?: string;
  b?: boolean;
  s?: boolean; // strikethrough
}
export type Line = Seg[];

const seg = (t: string, c?: string, extra: Partial<Seg> = {}): Seg => ({ t, c, ...extra });

export const TIER_COLOR: Record<Tier, string> = { haiku: C.green, sonnet: C.accent, opus: C.violet };
const EFFORT_N: Record<Effort, number> = { low: 1, medium: 2, high: 3 };
const EFFORT_COLOR: Record<Effort, string> = { low: C.dim, medium: C.yellow, high: C.accent };

export function tierSegs(tier: Tier): Seg[] {
  return [seg(TIERS[tier].label, TIER_COLOR[tier], { b: true })];
}
export function effortSegs(effort: Effort): Seg[] {
  const n = EFFORT_N[effort];
  return [seg('▰'.repeat(n), EFFORT_COLOR[effort]), seg('▱'.repeat(3 - n), C.faint), seg(` ${effort}`, effort === 'low' ? C.dim : effort === 'medium' ? C.fg2 : C.fg)];
}

export function bar(ratio: number, width = 10): string {
  const r = Math.min(1, Math.max(0, ratio || 0));
  const full = Math.round(r * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function dayLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = startOfDay(now);
  if (startOfDay(t) === today) return `今天 · ${md}`;
  if (startOfDay(t) === today - 86_400_000) return `昨天 · ${md}`;
  return `${md} 周${WEEK[d.getDay()]}`;
}

export function daySeparator(t: number, width = 60): Line {
  const label = ` ${dayLabel(t)} `;
  return [seg('──' + label + '─'.repeat(Math.max(4, width - label.length * 1.6 - 2)), C.faint)];
}

const short = (ms: number) => fmtDuration(ms).replace(/ \d+s$/, '');

/** "⏺ Name(arg)" header + "⎿" body lines, like a Claude Code tool call. */
function tool(name: string, arg: string | null, color: string, meta: Seg[] | null, body: Line[]): Line[] {
  const head: Line = [seg('⏺ ', color), seg(name, C.fg, { b: true })];
  if (arg !== null) head.push(seg('('), seg(arg, C.fg2), seg(')'));
  if (meta?.length) head.push(seg('  '), ...meta);
  const out: Line[] = [head];
  body.forEach((l, i) => out.push([seg(i === 0 ? '  ⎿  ' : '     ', C.faint), ...l]));
  return out;
}

export function diffLines(lines: DiffLine[]): Line[] {
  return lines.map((l) => {
    const num = seg(String(l.num ?? '').padStart(3) + ' ', C.faint);
    const note = l.note ? [seg('  ' + l.note, l.sign === '!' ? C.yellow : C.faint)] : [];
    if (l.sign === '+') return [num, seg(`+ ${l.text}`, C.addFg, { bg: C.addBg }), ...note];
    if (l.sign === '-') return [num, seg(`- ${l.text}`, C.delFg, { bg: C.delBg }), ...note];
    if (l.sign === '~') return [num, seg('~ ', C.yellow), seg(l.text, C.fg2), ...note];
    if (l.sign === '!') return [num, seg('! ', C.yellow), seg(l.text, C.fg2), ...note];
    return [num, seg('  '), seg(l.text, C.fg2), ...note];
  });
}

const STRUCTURAL: LogEntry['type'][] = ['add', 'remove', 'edit', 'phase-add'];

function summarize(lines: DiffLine[]): string {
  const a = lines.filter((l) => l.sign === '+').length;
  const r = lines.filter((l) => l.sign === '-').length;
  const m = lines.filter((l) => l.sign === '~').length;
  return [a && `${a} 处新增`, r && `${r} 处移除`, m && `${m} 处修改`].filter(Boolean).join('，') || '已更新';
}

/** One or more structural edits rendered as a single Write/Update(Plan) block. */
export function updateLines(events: LogEntry[], ws: Workspace): Line[] {
  const lines = events.flatMap((e) => e.diff ?? [{ sign: '~' as const, text: e.text }]);
  const writing = ws.kind === 'plan' && (!ws.versions.length || events[0].at < ws.versions[0].at);
  return tool(writing ? 'Write' : 'Update', ws.kind === 'plan' ? 'Plan' : 'Goal', C.blue, null, [[seg(summarize(lines), C.dim)], ...diffLines(lines)]);
}

export function sessionHeadLines(e: LogEntry, seg0?: Session): Line[] {
  const meta: Seg[] = seg0
    ? [...tierSegs(seg0.tier), seg(' '), ...effortSegs(seg0.effort), seg(` · ${seg0.plannedMin}m`, C.faint)]
    : [seg(e.detail ?? '', C.faint)];
  return [[], [seg('> ', C.dim), seg(e.title || '专注 Session', C.fg, { b: true }), seg('   '), ...meta]];
}

export function eventLines(e: LogEntry, ws: Workspace, sessions: Session[] = []): Line[] {
  const t = e.title ?? '';
  const dur = e.durMs != null ? [seg(`${short(e.durMs)}${e.tokens ? ` · ↑ ${fmtTokens(e.tokens)}` : ''}`, C.faint)] : null;
  switch (e.type) {
    case 'create':
      return [[seg('✻ ', C.accent), seg(e.text, C.fg2)]];
    case 'start':
      return tool('Start', t, C.accent, null, e.detail ? [[seg(e.detail, C.dim)]] : []);
    case 'done':
      return tool('Done', t, C.green, dur, e.reason ? [[seg(e.reason, C.dim)]] : []);
    case 'block':
      return tool('Block', t, C.red, null, [[seg(e.reason ?? '（未写原因）', e.reason ? C.fg2 : C.faint)]]);
    case 'unblock':
      return tool('Unblock', t, C.faint, null, []);
    case 'pause':
      return tool('Pause', t, C.faint, null, []);
    case 'reopen':
      return tool('Reopen', t, C.yellow, null, []);
    case 'skip':
      return tool('Skip', t, C.yellow, null, [...diffLines(e.diff ?? []), ...(e.reason ? [[seg(e.reason, C.dim)]] : [])]);
    case 'defer':
      return tool('Defer', t, C.yellow, null, [[seg(e.detail ?? '', C.dim)], ...(e.reason ? [[seg(`原因：${e.reason}`, C.fg2)]] : [])]);
    case 'revise':
      return tool('Update', ws.kind === 'plan' ? 'Plan' : 'Goal', C.blue, e.detail ? [seg(e.detail, C.faint)] : null, [
        [seg(`修正「${t}」的阶段目标`, C.dim)],
        ...diffLines(e.diff ?? []),
        ...(e.reason ? [[seg(`原因：${e.reason}`, C.fg2)]] : []),
      ]);
    case 'commit':
      return tool('Commit', `v${e.version}`, C.teal, null, [[seg(e.detail ?? '', C.dim)]]);
    case 'phase':
      return tool('Phase', t, C.teal, null, [[seg(e.detail ?? e.text, C.dim)]]);
    case 'note':
      return [[seg('# ', C.faint), seg(e.text, C.fg2)]];
    case 'checkpoint':
      return tool('Checkpoint', `#${e.version}`, C.violet, e.detail ? [seg(e.detail, C.faint)] : null, [
        ...(e.reason ? [[seg(`学到：${e.reason}`, C.fg2)]] : []),
        ...diffLines(e.diff ?? []),
      ]);
    case 'compact':
      return tool('Compact', null, C.blue, null, [[seg('保存了工作快照，可在下次 resume', C.dim)]]);
    case 'session-start':
      return sessionHeadLines(e, sessions.find((s) => s.runId === e.runId));
    case 'session-end':
      return [
        [seg('✻ ', C.accent), seg(`Session 结束 · ${short(e.durMs ?? 0)} · ↑ ${fmtTokens(e.tokens ?? 0)} tokens${e.detail ? ` · ${e.detail}` : ''}`, C.dim)],
        ...(e.reason ? [[seg('  ⎿  ', C.faint), seg(e.reason, C.fg2)]] : []),
      ];
    case 'add':
    case 'remove':
    case 'edit':
    case 'phase-add':
      return updateLines([e], ws);
    default:
      return [[seg('· ', C.faint), seg(e.text, C.dim)]];
  }
}

/**
 * The history of a workspace as printable blocks: day separators, merged
 * structural edits, one block per event otherwise.
 */
export function historyBlocks(ws: Workspace, sessions: Session[], limit = 80): { key: string; lines: Line[] }[] {
  const events = ws.log.slice(-limit);
  const out: { key: string; lines: Line[] }[] = [];
  let lastDay = -1;
  let i = 0;
  if (ws.log.length > events.length) out.push({ key: 'more', lines: [[seg(`… 更早的 ${ws.log.length - events.length} 条记录（automedo log -n 500 查看）`, C.faint)]] });
  while (i < events.length) {
    const e = events[i];
    const day = startOfDay(e.at);
    const sep = day !== lastDay ? [[] as Line, daySeparator(e.at)] : [];
    lastDay = day;
    if (STRUCTURAL.includes(e.type)) {
      const group = [e];
      while (i + 1 < events.length && STRUCTURAL.includes(events[i + 1].type) && startOfDay(events[i + 1].at) === day && events[i + 1].at - group[group.length - 1].at < 30 * 60_000) group.push(events[++i]);
      out.push({ key: e.id, lines: [...sep, ...updateLines(group, ws)] });
    } else {
      out.push({ key: e.id, lines: [...sep, ...eventLines(e, ws, sessions)] });
    }
    i++;
  }
  return out;
}

export function planDiffLines(p: Plan, v?: number): Line[] {
  const d = diffPlan(p, v);
  if (!d) return [[seg('还没有计划版本。第一次开始任务时会自动建立基准 v1，或输入 /commit。', C.yellow)]];
  const st = d.stats;
  const head = [
    st.added && `+${st.added}`,
    st.removed && `−${st.removed}`,
    st.changed && `~${st.changed}`,
    st.deferred && `延期 ${st.deferred}`,
    st.blocked && `阻塞 ${st.blocked}`,
    st.late && `逾期 ${st.late}`,
    st.revisions && `修正 ${st.revisions} 次`,
  ].filter(Boolean).join(' · ');
  const body: Line[] = [[seg(head || '与计划完全一致', C.dim), seg(`   基准 v${d.base.v} · ${fmtDate(d.base.at)} · ${d.base.message}`, C.faint)]];
  for (const ph of d.phases) {
    const color = ph.sign === '+' ? C.addFg : ph.sign === '-' ? C.delFg : C.fg2;
    body.push([], [seg(ph.sign === ' ' ? '    ' : `  ${ph.sign} `, ph.sign === '~' ? C.yellow : color), seg(`## ${ph.title}`, color, { s: ph.sign === '-' })]);
    body.push(...diffLines(ph.lines));
  }
  body.push([]);
  body.push(
    d.firstDrift
      ? [seg(`⚑ 首次偏离：${fmtDate(d.firstDrift.at)}${d.firstDriftPhase ? ` ·「${d.firstDriftPhase}」` : ''} · `, C.yellow), seg(d.firstDrift.text, C.fg2)]
      : [seg('✓ 目前还没有偏离基准', C.green)],
  );
  const versions = p.versions.map((x) => `v${x.v}`).join(' ');
  return [[], ...tool('Diff', `v${d.base.v} → 现在`, C.blue, [seg(versions, C.faint)], body)];
}

// Tomo, the pixel notebook, drawn with half blocks (two pixel rows per text row).
const ART = [
  '.DCCCCCCCCCCP.',
  '.DCCCCCCCCCCPP',
  '.DCCCCCCCCCCPP',
  '.DCCEECCCEECPP',
  '.DCCEECCCEECPP',
  '.DCKCCCCCCKCPP',
  '.DCCCCMMCCCCPP',
  '.DCCCCCCCCCCPP',
  '.DCCCCCCCCCCPP',
  '.DCCCCCCCCCCP.',
  '......R.......',
  '..FF..R..FF...',
];
const PX: Record<string, string> = { C: C.accent, D: '#b5603f', P: '#efe3cf', E: '#1a1512', K: '#f2a48c', M: '#1a1512', R: C.teal, F: '#8a4b36' };

export function mascotLines(): Line[] {
  const out: Line[] = [];
  for (let y = 0; y < ART.length; y += 2) {
    const line: Line = [];
    for (let x = 0; x < ART[y].length; x++) {
      const top = PX[ART[y][x]];
      const bottom = PX[ART[y + 1]?.[x] ?? '.'];
      if (!top && !bottom) line.push(seg(' '));
      else if (top && bottom) line.push(seg('▀', top, { bg: bottom }));
      else if (top) line.push(seg('▀', top));
      else line.push(seg('▄', bottom));
    }
    out.push(line);
  }
  return out;
}

export function welcomeLines(hasData: boolean): Line[] {
  const m = mascotLines();
  const text: Line[] = [
    [seg('✻ ', C.accent), seg('Welcome to AuTomeDo', C.fg, { b: true })],
    [],
    [seg('嗨，我是 Tomo，你的计划本。', C.fg2)],
    [seg('像编写 Agent 计划一样组织自己的工作。', C.dim)],
    [],
    [seg(hasData ? 'ctrl+o 打开 Plan / Goal · ' : '', C.dim), seg('输入标题回车开始 · / 查看命令 · shift+tab 切换模式', C.dim)],
  ];
  return m.map((l, i) => [...l, seg('   '), ...(text[i] ?? [])]);
}

export function helpLines(commands: { name: string; args?: string; desc: string }[]): Line[] {
  const out: Line[] = [[], [seg('命令', C.dim)]];
  for (const c of commands) out.push([seg(pad(`  /${c.name}`, 14), C.accent), seg(pad(c.args ?? '', 26), C.faint), seg(c.desc, C.fg2)]);
  out.push([seg(pad('  直接输入', 14), C.accent), seg(pad('', 26)), seg('添加任务（Plan）或行动（Goal）', C.fg2)]);
  out.push([seg(pad('  # 内容', 14), C.accent), seg(pad('', 26)), seg('写一条记录', C.fg2)]);
  out.push([], [seg('快捷键', C.dim)]);
  const keys: [string, string][] = [
    ['shift+tab', '切换 Plan / Goal 模式'],
    ['ctrl+o', '打开 / 切换 / 删除 Plan 与 Goal'],
    ['ctrl+f', '开始 / 结束专注 Session'],
    ['ctrl+n', '完成当前任务并开始下一个'],
    ['ctrl+z', '撤销'],
    ['↑ ↓', '输入历史；输入 / 时选择命令'],
    ['tab', '补全命令'],
    ['esc', '清空输入 / 取消表单'],
    ['ctrl+c', '清空输入；空输入时再按一次退出'],
  ];
  for (const [k, d] of keys) out.push([seg(pad(`  ${k}`, 14), C.accent), seg(d, C.fg2)]);
  return out;
}

// ───────────────────────── workspace header & dock ─────────────────────────


const VERDICT: Record<string, string> = { 'on-track': '顺利', drifting: '偏航', blocked: '受阻', pivot: '转向' };

export function wsHeaderLines(ws: Workspace): Line[] {
  if (ws.kind === 'plan') {
    const ordered = orderedTasks(ws);
    const counted = ordered.filter((t) => t.status !== 'skipped');
    const done = counted.filter((t) => t.status === 'done').length;
    const ph = currentPhase(ws);
    const pd = diffPlan(ws);
    const meta: Seg[] = [];
    if (ph) {
      meta.push(seg(`Phase ${ws.phases.indexOf(ph) + 1}/${ws.phases.length} · ${ph.title}`, C.teal));
      if (ph.due) meta.push(seg(` · 目标 ${ph.due.slice(5)}`, Date.now() > dueAt(ph.due) && ph.status !== 'done' ? C.yellow : C.dim));
      meta.push(seg('   '));
    }
    meta.push(seg(bar(counted.length ? done / counted.length : 0, 8), C.teal), seg(` ${done}/${counted.length}`, C.dim));
    meta.push(seg('   '), seg(pd ? `相对 v${pd.base.v}：${diffSummary(pd) ?? '无偏差'}` : '开始第一个任务时建立基准 v1', pd ? C.link : C.faint));
    return [[seg('⏸ ', C.teal), seg(ws.title, C.fg, { b: true }), ...(ws.status !== 'active' ? [seg(`  [${ws.status}]`, C.faint)] : [])], [seg('  '), ...meta]];
  }
  const g = ws as Goal;
  const last = g.checkpoints[g.checkpoints.length - 1];
  const meta: Seg[] = last
    ? [seg(bar(last.progress / 100, 8), C.violet), seg(` ${last.progress}% · ${VERDICT[last.verdict]} · ${fmtAgo(last.at)}`, C.dim)]
    : [seg('还没有 Checkpoint——先干起来', C.faint)];
  meta.push(seg('   '), checkpointDue(g) ? seg('⚑ Checkpoint 到期（/checkpoint）', C.yellow) : seg(`下次 Checkpoint ${fmtDate(nextCheckpointAt(g)).slice(5)}`, C.faint));
  return [[seg('⏵⏵ ', C.violet), seg(g.title, C.fg, { b: true }), ...(g.status !== 'active' ? [seg(`  [${g.status}]`, C.faint)] : [])], [seg('   '), ...meta]];
}

/** Current task + next todos, numbered so `/done 3` etc. are easy. */
export function dockLines(ws: Workspace, max = 5): Line[] {
  const ordered = orderedTasks(ws);
  const num = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const active = ordered.find((t) => t.status === 'active');
  const phase = ws.kind === 'plan' ? currentPhase(ws) : undefined;
  const open = ordered.filter((t) => t.status !== 'done' && t.status !== 'skipped' && t.id !== active?.id);
  const now = phase ? open.filter((t) => t.phaseId === phase.id) : open;
  const later = phase ? open.filter((t) => t.phaseId !== phase.id) : [];
  const list = [...now, ...later];
  const doneN = ordered.filter((t) => t.status === 'done').length;
  const out: Line[] = [];
  if (active) out.push([seg('◼ ', C.accent), seg(active.title, C.accent, { b: true }), seg(`  #${num(active.id)}`, C.faint)]);
  else if (ws.kind === 'goal' && !list.length) out.push([seg('⏺ ', C.accent), seg('下一步：', C.dim), seg(ws.nextAction || '写一个 30 分钟内能开始的动作（/nextaction）', ws.nextAction ? C.fg : C.faint, { b: !!ws.nextAction })]);
  else if (list.length) out.push([seg('◇ ', C.faint), seg('没有进行中的任务 · /start 开始下一个', C.dim)]);
  else if (ordered.length) out.push([seg('✓ ', C.green), seg('全部完成 · /compact 收尾', C.fg2)]);
  else out.push([seg('◇ ', C.faint), seg('还没有任务——直接输入一件要做的事', C.dim)]);
  for (const t of list.slice(0, max)) {
    const isLater = later.includes(t);
    const glyph = t.status === 'blocked' ? '✗' : '☐';
    out.push([seg(`${glyph} `, t.status === 'blocked' ? C.red : C.fg2), seg(t.title, t.status === 'blocked' ? C.red : isLater ? C.dim : C.fg), seg(`  #${num(t.id)}`, C.faint)]);
  }
  const foot: string[] = [];
  if (list.length > max) foot.push(`… 还有 ${list.length - max} 项`);
  if (doneN) foot.push(`☒ ${doneN} 已完成`);
  if (foot.length) out.push([seg(foot.join(' · '), C.faint)]);
  return out.map((l, i) => [seg(i === 0 ? '  ⎿  ' : '     ', C.faint), ...l]);
}
