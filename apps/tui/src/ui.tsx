// The interactive terminal UI. History is printed once into the terminal's own
// scrollback (<Static>); only the bottom area (spinner, todos, prompt, status) redraws.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, measureElement, Static, Text, useApp, useInput, useStdout, type DOMElement, type Key } from 'ink';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSession,
  budgetLevel,
  pickSpec,
  type PickKind,
  COMMANDS,
  currentWs,
  execute,
  fmtAgo,
  fmtTokens,
  hieAdvice,
  fatigueMult,
  latestFatigue,
  matchCommands,
  needsArg,
  ops,
  runSegmentsTokens,
  runStartedAt,
  tokensToday,
  fmtDuration,
  type AppState,
  type Effort,
  type Tier,
  type CmdCtx,
  type Intent,
  type Store,
  type SyncClient,
  type SyncStatus,
  type Workspace,
} from '@automedo/core';
import { bar, C, displayWidth, dockLines, pad, effortSegs, eventLines, helpLines, historyBlocks, planDiffLines, tierSegs, welcomeLines, wsHeaderLines, type Line, type Seg } from './format';
import { formFor, type Field, type FormSpec, type SubmitResult, type Values } from './forms';
import { editLine, emptyLine, lineFrom, type LineState } from './lineedit';

// ───────────────────────── primitives ─────────────────────────

function SegText({ s }: { s: Seg }) {
  return (
    <Text color={s.c} backgroundColor={s.bg} bold={s.b} strikethrough={s.s}>
      {s.t}
    </Text>
  );
}

export function Lines({ lines }: { lines: Line[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="wrap">
          {l.length ? l.map((s, j) => <SegText key={j} s={s} />) : ' '}
        </Text>
      ))}
    </Box>
  );
}

function Cursorline({ st, placeholder, secret }: { st: LineState; placeholder?: string; secret?: boolean }) {
  const cs = Array.from(secret ? '•'.repeat(Array.from(st.value).length) : st.value);
  if (!cs.length)
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder ? <Text color={C.faint}>{placeholder}</Text> : null}
      </Text>
    );
  return (
    <Text>
      {cs.slice(0, st.cursor).join('')}
      <Text inverse>{cs[st.cursor] ?? ' '}</Text>
      {cs.slice(st.cursor + 1).join('')}
    </Text>
  );
}

// ───────────────────────── store hooks ─────────────────────────

function useStore(store: Store): AppState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
function useSync(sync: SyncClient): SyncStatus {
  return useSyncExternalStore((l) => sync.subscribe(l), () => sync.getStatus(), () => sync.getStatus());
}

// ───────────────────────── spinner ─────────────────────────

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Focusing', 'Crafting', 'Pondering', 'Tinkering', 'Grinding', 'Building', 'Untangling', 'Noodling'];

function Spinner({ state }: { state: AppState }) {
  const s = activeSession(state);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!s) return;
    const t = setInterval(() => setTick((x) => x + 1), 160);
    return () => clearInterval(t);
  }, [s?.id]);
  if (!s) return null;
  const elapsed = Date.now() - runStartedAt(state, s.runId);
  const verb = VERBS[parseInt(s.runId.slice(-4), 36) % VERBS.length];
  return (
    <Box marginTop={1}>
      <Text color={C.accent}>
        {GLYPHS[tick % GLYPHS.length]} {verb}…{' '}
      </Text>
      <Text color={C.dim}>
        ({fmtDuration(elapsed)} / {s.plannedMin}m · ↑ {fmtTokens(runSegmentsTokens(state, s.runId))} tokens · {tierSegs(s.tier)[0].t}
        {s.intent ? ` · ${s.intent}` : ''} · ctrl+f 结束)
      </Text>
      {elapsed > s.plannedMin * 60_000 && <Text color={C.yellow}> 已超过计划时长</Text>}
    </Box>
  );
}

// ───────────────────────── status line ─────────────────────────

type ConfirmIntent = Extract<Intent, { type: 'confirm' }>;
/** A choice made in place, in the bottom bar (instead of a form above). */
type Bar = { kind: 'pick'; what: PickKind; idx: number } | { kind: 'confirm'; intent: ConfirmIntent };

const PREVIEW_BG = '#3a3f4b';
const PICK_CMDS: Record<string, PickKind> = { model: 'tier', effort: 'effort', fatigue: 'fatigue' };

/** The prompt box while a bar choice is open: the options in a row, the current one bracketed. */
function BarLine({ bar, state }: { bar: Bar; state: AppState }) {
  if (bar.kind === 'confirm') {
    const i = bar.intent;
    return (
      <Text>
        <Text color={i.danger ? C.red : C.accent} bold>
          {i.title}
        </Text>
        <Text color={C.dim}>  {i.message}</Text>
      </Text>
    );
  }
  const spec = pickSpec(bar.what, state);
  const o = spec.options[bar.idx];
  return (
    <Text>
      <Text color={C.dim}>{spec.title}  </Text>
      {spec.options.map((x, k) => (
        <Text key={x.value}>
          {k === bar.idx ? (
            <Text color={C.accent} bold>
              ‹ {x.label} ›
            </Text>
          ) : (
            <Text color={k === spec.current ? C.fg2 : C.faint}>  {x.label}  </Text>
          )}
          <Text> </Text>
        </Text>
      ))}
      <Text color={C.dim}>  {o.hint}</Text>
    </Text>
  );
}

function StatusLine({ state, sync, notice, preview, keys }: { state: AppState; sync: SyncClient; notice: string | null; preview?: { what: PickKind; value: string }; keys?: string }) {
  const st = useSync(sync);
  const cols = (useStdout().stdout as NodeJS.WriteStream).columns ?? 100;
  const used = tokensToday(state);
  const budget = state.settings.dailyBudget;
  const lvl = budgetLevel(used, budget);
  const fat = preview?.what === 'fatigue' ? Number(preview.value) : latestFatigue(state);
  const tier = preview?.what === 'tier' ? (preview.value as Tier) : state.hie.tier;
  const effort = preview?.what === 'effort' ? (preview.value as Effort) : state.hie.effort;
  const hl = (what: PickKind, segs: Seg[]) => (preview?.what === what ? segs.map((x) => ({ ...x, bg: PREVIEW_BG })) : segs);
  const advice = currentWs(state) ? hieAdvice(used, budget, latestFatigue(state)) : null; // real values, not the preview
  const syncSeg: Seg =
    st.phase === 'off' ? { t: '本地', c: C.faint }
    : st.phase === 'syncing' ? { t: '⟳ 同步中', c: C.blue }
    : st.phase === 'offline' ? { t: '⚠ 离线', c: C.yellow }
    : st.confirm ? { t: '⏸ 同步暂停：大量删除待确认（/sync）', c: C.yellow }
    : st.phase === 'error' ? { t: `✗ ${st.error ?? '同步失败'}`, c: C.red }
    : { t: `✓ 已同步${st.lastSyncAt ? ` ${fmtAgo(st.lastSyncAt)}` : ''}`, c: C.dim };
  const dot: Seg = { t: ' · ', c: C.faint };
  const budgetSegs: Seg[] = [
    { t: bar(used / budget, 6), c: lvl === 'ok' ? C.dim : lvl === 'warn' ? C.yellow : C.red },
    { t: ` ${fmtTokens(used)}/${fmtTokens(budget)}`, c: lvl === 'ok' ? C.dim : lvl === 'warn' ? C.yellow : C.red },
  ];
  const fatigueSeg0: Seg = { t: fat ? `疲劳 ${fat}/5${fatigueMult(fat) > 1 ? ` ×${fatigueMult(fat)}` : ''}` : '疲劳 –', c: fat && fat >= 4 ? C.yellow : C.dim };
  const join = (groups: Seg[][]) => groups.flatMap((g, i) => (i ? [dot, ...g] : g));
  const mode = state.ui.mode;
  const message = notice ?? advice;
  const modeText = mode === 'plan' ? '⏸ plan mode on' : '⏵⏵ goal mode on';
  const width = (segs: Seg[]) => segs.reduce((a, x) => a + displayWidth(x.t), 0);
  // Drop the least important parts until both halves fit on one line.
  const variants = [
    { tab: true, help: !message, budget: true },
    { tab: true, help: false, budget: true },
    { tab: false, help: false, budget: true },
    { tab: false, help: false, budget: false },
  ];
  const build = (v: (typeof variants)[number]) => ({
    v,
    right: join([hl('tier', tierSegs(tier)), hl('effort', effortSegs(effort)), ...(v.budget ? [budgetSegs] : []), hl('fatigue', [fatigueSeg0]), [syncSeg]]),
    left: displayWidth(modeText) + (keys ? 2 + displayWidth(keys) : (v.tab ? 12 : 0) + (v.help ? 17 : 0)),
  });
  const fit = variants.map(build).find((x) => x.left + 2 + width(x.right) + 2 <= cols) ?? build(variants[variants.length - 1]);
  const shown = fit.right;
  return (
    <Box flexDirection="column">
      {message ? (
        <Box paddingX={1}>
          <Text color={C.yellow} wrap="wrap">
            {message}
          </Text>
        </Box>
      ) : null}
      <Box justifyContent="space-between" paddingX={1}>
        <Text wrap="truncate-end">
          <Text color={mode === 'plan' ? C.teal : C.violet}>{modeText}</Text>
          {keys ? (
            <Text color={C.accent}>  {keys}</Text>
          ) : (
            <>
              {fit.v.tab ? <Text color={C.faint}> (shift+tab)</Text> : null}
              {fit.v.help ? <Text color={C.faint}>  ? for shortcuts</Text> : null}
            </>
          )}
        </Text>
        <Text wrap="truncate-start">
          {shown.map((x, i) => (
            <SegText key={i} s={x} />
          ))}
        </Text>
      </Box>
    </Box>
  );
}

// ───────────────────────── inline form ─────────────────────────

interface FormState {
  i: number;
  values: Values;
  line: LineState;
  sel: number;
  busy: boolean;
  error: string | null;
}

function initField(f: Field, values: Values): Pick<FormState, 'line' | 'sel'> {
  const v = values[f.key];
  if (f.kind === 'text') return { line: lineFrom(String(v ?? f.initial ?? '')), sel: 0 };
  if (f.kind === 'select') return { line: emptyLine, sel: Math.max(0, f.options.findIndex((o) => o.value === String(v ?? f.initial))) };
  return { line: emptyLine, sel: 0 };
}

function defaultValues(spec: FormSpec): Values {
  const v: Values = {};
  for (const f of spec.fields) {
    if (f.kind === 'slider') v[f.key] = f.initial;
    if (f.kind === 'confirm') v[f.key] = f.initial;
    if (f.kind === 'editor') v[f.key] = f.initial;
    if (f.kind === 'select') v[f.key] = f.initial ?? f.options[0]?.value ?? '';
    if (f.kind === 'text' && f.initial) v[f.key] = f.initial;
  }
  return v;
}

/** Open $EDITOR on a temp file and return the edited text (or null if unchanged/failed). */
async function editInEditor(text: string, suspend: (cb: () => void) => Promise<void>): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'automedo-'));
  const file = join(dir, 'compact.md');
  writeFileSync(file, text);
  let out: string | null = null;
  await suspend(() => {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
    if (r.status === 0) out = readFileSync(file, 'utf8');
  });
  rmSync(dir, { recursive: true, force: true });
  return out;
}

function Form({ spec, onDone }: { spec: FormSpec; onDone: (r: SubmitResult | null) => void }) {
  const app = useApp() as ReturnType<typeof useApp> & { suspendTerminal?: (cb: () => void) => Promise<void> };
  const [st, setSt] = useState<FormState>(() => {
    const values = defaultValues(spec);
    return { i: 0, values, ...initField(spec.fields[0], values), busy: false, error: null };
  });
  const f = spec.fields[st.i];

  const commit = (v: string | number | boolean) => {
    const values = { ...st.values, [f.key]: v };
    if (f.kind === 'text' && f.required && !String(v).trim()) return setSt({ ...st, error: `请填写「${f.label}」` });
    if (st.i + 1 < spec.fields.length) {
      const nf = spec.fields[st.i + 1];
      return setSt({ ...st, i: st.i + 1, values, ...initField(nf, values), error: null });
    }
    setSt({ ...st, values, busy: true, error: null });
    void Promise.resolve(spec.submit(values)).then((r) => {
      if (r.error) setSt((s) => ({ ...s, values, busy: false, error: r.error! }));
      else onDone(r);
    });
  };

  useInput((input, key) => {
    if (st.busy) return;
    if (key.escape) return onDone(null);
    if (key.tab && key.shift && st.i > 0) {
      const pf = spec.fields[st.i - 1];
      return setSt({ ...st, i: st.i - 1, ...initField(pf, st.values), error: null });
    }
    switch (f.kind) {
      case 'text': {
        if (key.return) return commit(st.line.value.trim());
        const n = editLine(st.line, input, key);
        if (n) setSt({ ...st, line: n, error: null });
        return;
      }
      case 'select': {
        if (key.upArrow) return setSt({ ...st, sel: (st.sel - 1 + f.options.length) % f.options.length });
        if (key.downArrow) return setSt({ ...st, sel: (st.sel + 1) % f.options.length });
        const n = Number(input);
        if (Number.isInteger(n) && n >= 1 && n <= f.options.length) return commit(f.options[n - 1].value);
        if (key.return) return commit(f.options[st.sel].value);
        return;
      }
      case 'slider': {
        const cur = Number(st.values[f.key]);
        if (key.leftArrow) return setSt({ ...st, values: { ...st.values, [f.key]: Math.max(0, cur - f.step) } });
        if (key.rightArrow) return setSt({ ...st, values: { ...st.values, [f.key]: Math.min(100, cur + f.step) } });
        if (key.return) return commit(cur);
        return;
      }
      case 'confirm': {
        if (input === 'y' || input === 'Y') return commit(true);
        if (input === 'n' || input === 'N') return commit(false);
        if (key.leftArrow || key.rightArrow) return setSt({ ...st, values: { ...st.values, [f.key]: !st.values[f.key] } });
        if (key.return) return commit(Boolean(st.values[f.key]));
        return;
      }
      case 'editor': {
        if (key.return) return commit(String(st.values[f.key]));
        if (input === 'e' && app.suspendTerminal) {
          void editInEditor(String(st.values[f.key]), app.suspendTerminal).then((t) => {
            if (t !== null) setSt((s) => ({ ...s, values: { ...s.values, [f.key]: t.trim() } }));
          });
        }
        return;
      }
    }
  });

  const hint =
    f.kind === 'select' ? '↑↓ 选择 · enter 确认'
    : f.kind === 'slider' ? '←→ 调整 · enter 确认'
    : f.kind === 'confirm' ? 'y / n'
    : f.kind === 'editor' ? 'enter 保存 · e 用 $EDITOR 编辑'
    : 'enter 下一项';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={spec.color} paddingX={1} marginTop={1}>
      <Text color={spec.color} bold>
        ✻ {spec.title}
      </Text>
      {spec.desc ? <Text color={C.dim}>{spec.desc}</Text> : null}
      <Text> </Text>
      {spec.fields.map((x, i) => {
        const val = st.values[x.key];
        if (i < st.i) {
          const shown = x.kind === 'select' ? x.options.find((o) => o.value === val)?.label : x.kind === 'confirm' ? (val ? '是' : '否') : x.kind === 'slider' ? `${val}%` : x.kind === 'text' && x.secret ? '••••' : x.kind === 'editor' ? '（已编辑）' : String(val ?? '');
          return (
            <Text key={x.key}>
              <Text color={C.green}>✓ </Text>
              <Text color={C.dim}>{x.label}  </Text>
              <Text color={C.fg2}>{shown || '—'}</Text>
            </Text>
          );
        }
        if (i > st.i) return <Text key={x.key} color={C.faint}>  {x.label}</Text>;
        return (
          <Box key={x.key} flexDirection="column">
            <Text>
              <Text color={spec.color}>› </Text>
              <Text bold>{x.label}  </Text>
              {x.kind === 'text' && <Cursorline st={st.line} placeholder={x.placeholder} secret={x.secret} />}
              {x.kind === 'slider' && (
                <Text>
                  <Text color={C.violet}>{bar(Number(val) / 100, 20)}</Text> <Text bold>{String(val)}%</Text>
                </Text>
              )}
              {x.kind === 'confirm' && (
                <Text>
                  <Text color={val ? C.accent : C.dim}>{val ? '[x] 是' : '[ ] 否'}</Text>
                </Text>
              )}
            </Text>
            {x.kind === 'select' &&
              x.options.map((o, k) => (
                <Text key={o.value}>
                  {'    '}
                  <Text color={k === st.sel ? C.accent : C.faint}>{k === st.sel ? '●' : '○'} </Text>
                  <Text color={k === st.sel ? C.fg : C.fg2} bold={k === st.sel}>
                    {k + 1}. {o.label}
                  </Text>
                  {o.hint ? <Text color={C.dim}>  {o.hint}</Text> : null}
                </Text>
              ))}
            {x.kind === 'editor' && (
              <Box flexDirection="column" paddingLeft={4}>
                {String(val).split('\n').slice(0, 14).map((l, k) => (
                  <Text key={k} color={C.fg2}>
                    {l || ' '}
                  </Text>
                ))}
                {String(val).split('\n').length > 14 && <Text color={C.faint}>…</Text>}
              </Box>
            )}
          </Box>
        );
      })}
      <Text> </Text>
      {st.error ? <Text color={C.red}>⎿ {st.error}</Text> : null}
      <Text color={C.faint}>{st.busy ? '处理中…' : `${hint} · ${st.i > 0 ? 'shift+tab 上一项 · ' : ''}esc 取消`}</Text>
    </Box>
  );
}

// ───────────────────────── workspace picker ─────────────────────────

function Picker({ state, onPick, onDelete, onClose }: { state: AppState; onPick: (w: Workspace) => void; onDelete: (w: Workspace) => void; onClose: () => void }) {
  const [q, setQ] = useState(emptyLine);
  const cur = currentWs(state);
  const ORDER = { active: 0, paused: 1, done: 2, archived: 3 } as const;
  const all = [...state.plans, ...state.goals]
    .filter((w) => !q.value || w.title.toLowerCase().includes(q.value.toLowerCase()))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt);
  const [idx, setIdx] = useState(() => Math.max(0, all.findIndex((w) => w.id === cur?.id)));
  const i = Math.min(idx, Math.max(0, all.length - 1));
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setIdx(Math.max(0, i - 1));
    if (key.downArrow) return setIdx(Math.min(all.length - 1, i + 1));
    if (key.return) return all[i] && onPick(all[i]);
    if (key.ctrl && input === 'd') return all[i] && onDelete(all[i]);
    const n = editLine(q, input, key);
    if (n) {
      setQ(n);
      setIdx(0);
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} marginTop={1}>
      <Text>
        <Text color={C.fg} bold>切换 Plan / Goal  </Text>
        <Cursorline st={q} placeholder="输入以筛选" />
      </Text>
      <Text> </Text>
      {all.length === 0 && <Text color={C.faint}>{q.value ? '没有匹配项' : '还没有 Plan 或 Goal——用 /plan 或 /goal 新建'}</Text>}
      {all.slice(0, 15).map((w, k) => {
        const meta =
          w.kind === 'plan'
            ? `${w.tasks.filter((t) => t.status === 'done').length}/${w.tasks.filter((t) => t.status !== 'skipped').length}`
            : `${w.checkpoints[w.checkpoints.length - 1]?.progress ?? '–'}%${ops.checkpointDue(w) ? ' ⚑' : ''}`;
        return (
          <Text key={w.id}>
            <Text color={k === i ? C.accent : C.faint}>{k === i ? '❯ ' : '  '}</Text>
            <Text color={w.kind === 'plan' ? C.teal : C.violet}>{w.kind === 'plan' ? '⏸ ' : '⏵⏵'} </Text>
            <Text color={w.status !== 'active' ? C.faint : k === i ? C.fg : C.fg2} bold={k === i}>
              {w.title}
            </Text>
            <Text color={C.faint}>
              {'  '}
              {w.status !== 'active' ? `${w.status} · ` : ''}
              {meta}
              {w.id === cur?.id ? ' · 当前' : ''}
            </Text>
          </Text>
        );
      })}
      <Text> </Text>
      <Text color={C.faint}>↑↓ 选择 · enter 打开 · ctrl+d 删除 · esc 关闭</Text>
    </Box>
  );
}

// ───────────────────────── app ─────────────────────────

interface Block {
  key: string;
  lines: Line[];
}

let blockSeq = 0;
const block = (lines: Line[]): Block => ({ key: `b${blockSeq++}`, lines });

function introBlocks(state: AppState, loadError: string | null): Block[] {
  const ws = currentWs(state);
  const out: Block[] = [block([[], ...welcomeLines(state.plans.length + state.goals.length > 0)])];
  if (loadError) out.push(block([[{ t: `✗ ${loadError}`, c: C.red }]]));
  if (ws) out.push(block([[], ...wsHeaderLines(ws)]), ...historyBlocks(ws, state.sessions, 40).map((b) => ({ key: `h${blockSeq++}${b.key}`, lines: b.lines })));
  return out;
}

/**
 * Keep the prompt and status line on the terminal's last rows. Ink appends below the
 * transcript, so a live area that shrinks (a menu or form closing) would pull them up.
 * Track the highest the output has reached (transcript lines + live area) and pad the
 * top of the live area up to it; new transcript lines use up that padding in the same frame.
 */
function useBottomPin(blocks: Block[], rows: number) {
  const ref = useRef<DOMElement>(null);
  const printed = useMemo(() => blocks.reduce((a, b) => a + b.lines.length, 0), [blocks]);
  const [top, setTop] = useState(0);
  useEffect(() => setTop(0), [rows]); // re-measure after a resize
  useEffect(() => {
    if (!ref.current) return;
    const reach = printed + measureElement(ref.current).height;
    if (reach > top) setTop(reach);
  });
  return { ref, minHeight: Math.max(0, Math.min(top - printed, rows - 1)) };
}

export function App({ store, sync, loadError = null }: { store: Store; sync: SyncClient; loadError?: string | null }) {
  const state = useStore(store);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [blocks, setBlocks] = useState<Block[]>(() => introBlocks(store.get(), loadError));
  const print = (lines: Line[]) => setBlocks((b) => [...b, block(lines)]);
  const [line, setLine] = useState<LineState>(emptyLine);
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [sugIdx, setSugIdx] = useState(0);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ctrlC = useRef(0);
  const ws = currentWs(state);

  // Stream new events of the open workspace; reprint the header when switching.
  const seen = useRef({ wsId: ws?.id, count: ws?.log.length ?? 0 });
  useEffect(() => {
    const s = seen.current;
    if (ws?.id !== s.wsId) {
      seen.current = { wsId: ws?.id, count: ws?.log.length ?? 0 };
      if (ws) {
        const hist = historyBlocks(ws, state.sessions, 15);
        setBlocks((b) => [...b, block([[], [{ t: `── 切换到「${ws.title}」 ──`, c: C.faint }], [], ...wsHeaderLines(ws)]), ...hist.map((h) => block(h.lines))]);
      }
      return;
    }
    if (!ws) return;
    if (ws.log.length > s.count) {
      const fresh = ws.log.slice(s.count);
      setBlocks((b) => [...b, ...fresh.map((e) => block(eventLines(e, ws, state.sessions)))]);
    }
    s.count = ws.log.length;
  }, [ws?.id, ws?.log.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (i: Intent) => {
    if (i.type === 'help') return print(helpLines(COMMANDS));
    if (i.type === 'resume') {
      const c = store.get().compacts.find((x) => x.id === i.compactId);
      if (!c) return print([[{ t: '  ⎿  快照不存在', c: C.red }]]);
      store.mutate(null, (d) => {
        ops.selectWs(d, c.wsId);
        d.ui.dismissedCompactId = c.id;
      });
      return print([[], [{ t: '⏺ ', c: C.blue }, { t: 'Resume', b: true }, { t: `  ${fmtAgo(c.at)}`, c: C.faint }], ...c.text.split('\n').map((l) => [{ t: '     ' + l, c: C.fg2 }])]);
    }
    if (i.type === 'pick') {
      setIntent(null);
      return setBar({ kind: 'pick', what: i.what, idx: Math.max(0, pickSpec(i.what, store.get()).current) });
    }
    if (i.type === 'confirm') {
      setIntent(null);
      return setBar({ kind: 'confirm', intent: i });
    }
    if (i.type !== 'switch' && !formFor(i, store, sync)) return print([[{ t: '  ⎿  无法打开这个表单', c: C.red }]]);
    setIntent(i);
  };

  const ctx: CmdCtx = useMemo(
    () => ({
      store,
      open,
      exportData: () => print([[{ t: '  ⎿  在终端里用 ', c: C.dim }, { t: 'automedo export > backup.json', c: C.accent }]]),
      importData: () => print([[{ t: '  ⎿  在终端里用 ', c: C.dim }, { t: 'automedo import backup.json', c: C.accent }]]),
      showDiff: (planId, v) => {
        const p = store.get().plans.find((x) => x.id === planId);
        if (p) print(planDiffLines(p, v));
      },
    }),
    [store], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const run = (text: string, echo = true) => {
    const before = currentWs(store.get());
    const n0 = before?.log.length ?? 0;
    if (echo) print([[], [{ t: '> ', c: C.dim }, { t: text, c: C.fg }]]);
    const r = execute(text, ctx);
    const after = currentWs(store.get());
    const gotEvents = after?.id === before?.id && (after?.log.length ?? 0) > n0;
    if (r?.error) print([[{ t: '  ⎿  ', c: C.faint }, { t: r.text, c: C.red }]]);
    else if (r?.text && !gotEvents) print([[{ t: '  ⎿  ', c: C.faint }, { t: r.text, c: C.dim }]]);
  };

  const sugs = line.value.startsWith('/') && !intent ? matchCommands(line.value, state.ui.mode) : [];
  const showSugs = sugs.length > 0 && !line.value.includes(' ');
  const sel = Math.min(sugIdx, Math.max(0, sugs.length - 1));

  const toggleMode = () =>
    store.mutate(null, (d) => {
      d.ui.mode = d.ui.mode === 'plan' ? 'goal' : 'plan';
      if (d.ui.mode === 'plan') d.ui.activePlanId ??= d.plans[0]?.id ?? null;
      else d.ui.activeGoalId ??= d.goals[0]?.id ?? null;
    });

  useInput(
    (input: string, key: Key) => {
      if (key.tab && key.shift) return toggleMode();
      if (key.ctrl && input === 'c') {
        if (line.value) {
          setLine(emptyLine);
          return;
        }
        if (Date.now() - ctrlC.current < 2000) return exit();
        ctrlC.current = Date.now();
        setNotice('再按一次 ctrl+c 退出');
        setTimeout(() => setNotice(null), 2000);
        return;
      }
      if (key.ctrl && input === 'o') return setIntent({ type: 'switch' });
      if (key.ctrl && input === 'f') return run(activeSession(store.get()) ? '/end' : '/session', false);
      if (key.ctrl && input === 'n') return run('/next');
      if (key.ctrl && input === 'z') {
        const l = store.undo();
        return print([[{ t: '  ⎿  ', c: C.faint }, { t: l ? `已撤销：${l}` : '没有可撤销的操作', c: l ? C.dim : C.red }]]);
      }
      if (key.ctrl && input === 'l') {
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
        return;
      }
      if (input === '?' && !line.value) return print(helpLines(COMMANDS));
      if (showSugs) {
        const pickWhat = PICK_CMDS[sugs[sel]?.name ?? ''];
        if (pickWhat && (key.leftArrow || key.rightArrow) && line.cursor === Array.from(line.value).length) {
          const spec = pickSpec(pickWhat, store.get());
          const n = spec.options.length;
          const cur = Math.max(0, spec.current);
          setLine(emptyLine);
          return setBar({ kind: 'pick', what: pickWhat, idx: (cur + (key.leftArrow ? n - 1 : 1)) % n });
        }
        if (key.upArrow) return setSugIdx((sel - 1 + sugs.length) % sugs.length);
        if (key.downArrow) return setSugIdx((sel + 1) % sugs.length);
        if (key.tab) {
          const c = sugs[sel];
          return setLine(lineFrom(`/${c.name}${c.args ? ' ' : ''}`));
        }
        if (key.return) {
          const c = sugs[sel];
          if (needsArg(c)) return setLine(lineFrom(`/${c.name} `));
          setLine(emptyLine);
          setHist((h) => [...h, `/${c.name}`].slice(-100));
          setHistIdx(-1);
          return run(`/${c.name}`);
        }
      }
      if (key.escape) {
        setLine(emptyLine);
        return;
      }
      if (key.upArrow && hist.length && (!line.value || histIdx >= 0)) {
        const i = histIdx < 0 ? hist.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(i);
        return setLine(lineFrom(hist[i]));
      }
      if (key.downArrow && histIdx >= 0) {
        const i = histIdx + 1;
        setHistIdx(i >= hist.length ? -1 : i);
        return setLine(i >= hist.length ? emptyLine : lineFrom(hist[i]));
      }
      if (key.return) {
        const text = line.value.trim();
        if (!text) return;
        setLine(emptyLine);
        setHist((h) => [...h.filter((x) => x !== text), text].slice(-100));
        setHistIdx(-1);
        return run(text);
      }
      const n = editLine(line, input, key);
      if (n) {
        setLine(n);
        setSugIdx(0);
        setHistIdx(-1);
      }
    },
    { isActive: !intent && !bar },
  );

  // Report what a store change did, unless it already shows up as a workspace event.
  const report = (fn: () => unknown) => {
    const before = currentWs(store.get());
    const n0 = before?.log.length ?? 0;
    try {
      const r = fn();
      const after = currentWs(store.get());
      if (typeof r === 'string' && !(after?.id === before?.id && (after?.log.length ?? 0) > n0)) print([[{ t: '  ⎿  ', c: C.faint }, { t: r, c: C.dim }]]);
    } catch (e) {
      print([[{ t: '  ⎿  ', c: C.faint }, { t: (e as Error).message, c: C.red }]]);
    }
  };

  useInput(
    (input: string, key: Key) => {
      if (!bar) return;
      if (key.escape || (key.ctrl && input === 'c')) return setBar(null);
      if (bar.kind === 'confirm') {
        const yes = input.toLowerCase() === 'y' || (key.return && !bar.intent.danger);
        if (yes) {
          setBar(null);
          return report(() => bar.intent.onConfirm()); // it does its own store.mutate
        }
        if (input.toLowerCase() === 'n' || key.return) setBar(null);
        return;
      }
      const spec = pickSpec(bar.what, store.get());
      const n = spec.options.length;
      const choose = (k: number) => {
        setBar(null);
        report(() => store.mutate(spec.label, (d) => spec.apply(d, spec.options[k].value)));
      };
      if (key.leftArrow || input === 'h' || (key.tab && key.shift)) return setBar({ ...bar, idx: (bar.idx + n - 1) % n });
      if (key.rightArrow || input === 'l' || key.tab) return setBar({ ...bar, idx: (bar.idx + 1) % n });
      if (/^[1-9]$/.test(input) && Number(input) <= n) return choose(Number(input) - 1);
      if (key.return) return choose(bar.idx);
    },
    { isActive: !!bar },
  );

  const spec = intent && intent.type !== 'switch' ? formFor(intent, store, sync) : null;
  const closeForm = (r: SubmitResult | null) => {
    setIntent(null);
    if (!r) return print([[{ t: '  ⎿  已取消', c: C.faint }]]);
    if (r.text) {
      const w = currentWs(store.get());
      // Events already describe most results; only echo the rest.
      if (!w || !/^(已创建|已设定|Session|已修正|已记录|已 Compact|已更新)/.test(r.text)) print([[{ t: '  ⎿  ', c: C.faint }, { t: r.text, c: C.dim }]]);
    }
    if (r.next) setTimeout(() => open(r.next!), 0);
  };

  const placeholder = !ws ? (state.ui.mode === 'plan' ? '输入计划标题并回车，或 /help' : '输入目标并回车，或 /help') : state.ui.mode === 'plan' ? '添加任务…  / 命令  # 记录' : '添加行动…  / 命令  # 记录';

  const pin = useBottomPin(blocks, (stdout as NodeJS.WriteStream).rows ?? 30);
  const formOpen = !!intent && (intent.type === 'switch' || !!spec);

  // Order matters: everything that comes and goes sits ABOVE the prompt, so the prompt
  // box and the status line (model · effort · budget · fatigue · sync) stay at the bottom.
  return (
    <>
      <Static items={blocks}>{(b) => <Lines key={b.key} lines={b.lines} />}</Static>
      <Box flexDirection="column" justifyContent="flex-end" minHeight={pin.minHeight}>
        <Box ref={pin.ref} flexDirection="column">
          <Spinner state={state} />
          {ws && (
            <Box marginTop={activeSession(state) ? 0 : 1}>
              <Lines lines={dockLines(ws)} />
            </Box>
          )}
          {intent?.type === 'switch' ? (
            <Picker
              state={state}
              onClose={() => setIntent(null)}
              onPick={(w) => {
                setIntent(null);
                store.mutate(null, (d) => ops.selectWs(d, w.id));
              }}
              onDelete={(w) =>
                open({
                  type: 'confirm',
                  title: `删除「${w.title}」？`,
                  message: '任务、日志、版本和快照会一起删除。之后可以 ctrl+z 撤销。',
                  confirmLabel: '删除',
                  danger: true,
                  onConfirm: () => store.mutate('删除', (d) => ops.deleteWs(d, w.id)),
                })
              }
            />
          ) : spec ? (
            <Form key={JSON.stringify({ ...intent, onConfirm: undefined })} spec={spec} onDone={closeForm} />
          ) : (
            <>
              {showSugs && (
                <Box flexDirection="column" paddingX={2} marginTop={1}>
                  {sugs.slice(0, 10).map((c, i) => (
                    <Text key={c.name}>
                      <Text color={i === sel ? C.accent : C.fg2} bold={i === sel}>
                        {pad(`/${c.name}`, 14)}
                      </Text>
                      <Text color={C.faint}>{pad(c.args ?? '', 26)}</Text>
                      <Text color={i === sel ? C.fg2 : C.dim}>{c.desc}</Text>
                      {i === sel && PICK_CMDS[c.name] ? <Text color={C.accent}>  ←→ 直接选择</Text> : null}
                    </Text>
                  ))}
                </Box>
              )}
            </>
          )}
          <Box borderStyle="round" borderColor={bar ? (bar.kind === 'confirm' && bar.intent.danger ? C.red : C.accent) : formOpen ? C.faint : C.dim} paddingX={1} marginTop={showSugs ? 0 : 1}>
            {bar ? (
              <BarLine bar={bar} state={state} />
            ) : (
              <>
                <Text color={C.dim}>&gt; </Text>
                {formOpen ? <Text color={C.faint}>{intent?.type === 'switch' ? '↑ 选择 Plan / Goal · esc 关闭' : '↑ 正在填写上方的表单 · esc 取消'}</Text> : <Cursorline st={line} placeholder={placeholder} />}
              </>
            )}
          </Box>
          <StatusLine state={state} sync={sync} notice={notice} preview={bar?.kind === 'pick' ? { what: bar.what, value: pickSpec(bar.what, state).options[bar.idx].value } : undefined}
            keys={bar ? (bar.kind === 'pick' ? '←→ 选择 · enter 确认 · esc 取消' : `y ${bar.intent.confirmLabel ?? '确认'} · n 取消`) : undefined}
          />
        </Box>
      </Box>
    </>
  );
}

