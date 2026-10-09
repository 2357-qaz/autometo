import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Output } from '../ctx';
import { useApp } from '../ctx';
import { matchCommands } from '../commands';
import { activeSession, runSegmentsTokens, runStartedAt, TIERS, type BudgetLevel } from '../hie';
import { currentWs } from '../store';
import { fmtDuration, fmtTokens } from '../util';

export interface PromptHandle {
  focus: (prefill?: string) => void;
}

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Focusing', 'Crafting', 'Pondering', 'Tinkering', 'Grinding', 'Building', 'Untangling', 'Noodling'];

function SpinnerLine() {
  const { state } = useApp();
  const s = activeSession(state);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!s) return;
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [s?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const start = runStartedAt(state, s.runId);
  const elapsed = Date.now() - start;
  const planned = s.plannedMin * 60_000;
  const over = elapsed > planned;
  const verb = VERBS[parseInt(s.runId.slice(-4), 36) % VERBS.length];
  return (
    <div className="spinner-line" role="status" aria-live="off">
      <span className="glyph">{GLYPHS[tick % GLYPHS.length]}</span>
      <span>{verb}…</span>
      <span className="dim">
        ({fmtDuration(elapsed)} / {s.plannedMin}m · ↑ {fmtTokens(runSegmentsTokens(state, s.runId))} tokens · {TIERS[s.tier].label}/{s.effort}
        {s.intent ? ` · ${s.intent}` : ''} · <span className="kbd">f</span> 结束)
      </span>
      {over && <span className="yellow">已超过计划时长，考虑休息或 /end</span>}
    </div>
  );
}

export const Bottom = forwardRef<PromptHandle, {
  output: Output | null;
  onRun: (s: string) => void;
  onUndo: () => void;
  budgetLevel: BudgetLevel;
  used: number;
}>(function Bottom({ output, onRun, onUndo, budgetLevel, used }, ref) {
  const { state, store, open } = useApp();
  const [v, setV] = useState('');
  const [sugIdx, setSugIdx] = useState(0);
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [focused, setFocused] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus(prefill) {
      if (prefill != null) setV(prefill);
      // Focus synchronously so fast typing right after the shortcut lands in the input.
      const el = ta.current;
      if (!el) return;
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    },
  }));

  const mode = state.ui.mode;
  const sugs = focused ? matchCommands(v, mode) : [];
  const showSugs = sugs.length > 0 && !(v.includes(' ') && sugs.length === 1 && !sugs[0].args);
  useEffect(() => setSugIdx(0), [v]);

  // auto-size
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [v]);

  const submit = (text: string) => {
    if (!text.trim()) return;
    setHist((h) => [...h.filter((x) => x !== text), text].slice(-50));
    setHistIdx(-1);
    setV('');
    onRun(text);
  };

  const complete = (i: number) => {
    const c = sugs[i];
    if (!c) return;
    const next = `/${c.name}${c.args ? ' ' : ''}`;
    if (!c.args) submit(`/${c.name}`);
    else setV(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && e.shiftKey) return; // handled globally (mode toggle)
    if (showSugs && !v.includes(' ')) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setSugIdx((i) => (i + 1) % sugs.length);
      if (e.key === 'ArrowUp') return e.preventDefault(), setSugIdx((i) => (i - 1 + sugs.length) % sugs.length);
      if (e.key === 'Tab') {
        e.preventDefault();
        const c = sugs[sugIdx];
        if (c) setV(`/${c.name}${c.args ? ' ' : ''}`);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const exact = sugs.find((c) => `/${c.name}` === v.trim());
        if (exact) return submit(v);
        return complete(sugIdx);
      }
    }
    if (e.key === 'ArrowUp' && (!v || histIdx >= 0) && hist.length) {
      e.preventDefault();
      const i = histIdx < 0 ? hist.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      setV(hist[i]);
      return;
    }
    if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const i = histIdx + 1;
      if (i >= hist.length) {
        setHistIdx(-1);
        setV('');
      } else {
        setHistIdx(i);
        setV(hist[i]);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(v);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (v) setV('');
      else ta.current?.blur();
    }
  };

  const ws = currentWs(state);
  const placeholder = !ws
    ? mode === 'plan'
      ? '输入计划标题并回车，或 /help'
      : '输入目标并回车，或 /help'
    : mode === 'plan'
      ? '添加任务…　/ 命令　# 记录'
      : '添加行动…　/ 命令　# 记录';

  const budgetLeft = Math.max(0, Math.round((1 - used / state.settings.dailyBudget) * 100));

  return (
    <footer className="bottom">
      <SpinnerLine />
      {output && (
        <div className={`output ${output.error ? 'err' : ''}`} role="status" aria-live="polite">
          <span className={output.error ? 'red' : 'green'}>⏺</span>
          <span className="cmd">{output.cmd}</span>
          <span className="faint">⎿</span>
          <span className="res">
            {output.text}
            {output.undoable && store.canUndo() && (
              <button className="btn ghost" onClick={onUndo}>
                撤销 <span className="kbd">Ctrl+Z</span>
              </button>
            )}
          </span>
        </div>
      )}
      <div className="prompt-wrap">
        {showSugs && (
          <div className="suggest" role="listbox" aria-label="命令补全">
            {sugs.map((c, i) => (
              <div
                key={c.name}
                className="suggest-item"
                role="option"
                aria-selected={i === sugIdx}
                onMouseEnter={() => setSugIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(i);
                }}
              >
                <span className="n">
                  /{c.name} {c.args && <span className="faint">{c.args}</span>}
                </span>
                <span className="d">{c.desc}</span>
              </div>
            ))}
          </div>
        )}
        <div className="prompt" onClick={() => ta.current?.focus()}>
          <span className="caret">&gt;</span>
          <textarea
            ref={ta}
            rows={1}
            value={v}
            placeholder={placeholder}
            aria-label="命令输入"
            spellCheck={false}
            onChange={(e) => {
              setV(e.target.value);
              setHistIdx(-1);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>
      </div>
      <div className="statusline">
        <button className={mode === 'plan' ? 'mode-plan' : 'mode-goal'} onClick={() => store.mutate(null, (d) => void (d.ui.mode = d.ui.mode === 'plan' ? 'goal' : 'plan'))}>
          {mode === 'plan' ? '⏸ plan mode on' : '⏵⏵ goal mode on'} <span className="faint">(shift+tab to cycle)</span>
        </button>
        <button onClick={() => open({ type: 'help' })}>? for shortcuts</button>
        <span className="spacer" />
        {budgetLevel !== 'ok' && (
          <span className={budgetLevel === 'warn' ? 'yellow' : 'red'}>
            {budgetLevel === 'over' ? '今日预算已用完' : `Budget left until auto-compact: ${budgetLeft}%`}
          </span>
        )}
        <span className="faint">{store.saveError() ? '✗ 未保存' : '● 已本地保存'}</span>
      </div>
    </footer>
  );
});
