import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Output } from '../ctx';
import { useApp } from '../ctx';
import { matchCommands, needsArg } from '@automedo/core';
import { activeSession, latestFatigue, runSegmentsTokens, runStartedAt, TIERS, type BudgetLevel } from '@automedo/core';
import { currentWs } from '@automedo/core';
import { EffortLabel, TierLabel } from './Hie';
import { useSyncStatus } from '../sync';
import { fmtAgo } from '@automedo/core';
import { bar, fmtDuration, fmtTokens } from '@automedo/core';

export interface PromptHandle {
  focus: (prefill?: string) => void;
}

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Focusing', 'Crafting', 'Pondering', 'Tinkering', 'Grinding', 'Building', 'Untangling', 'Noodling'];

function SpinnerLine() {
  const { state, run } = useApp();
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
        ({fmtDuration(elapsed)} / {s.plannedMin}m · ↑ {fmtTokens(runSegmentsTokens(state, s.runId))} tokens · <TierLabel tier={s.tier} /> <EffortLabel effort={s.effort} />
        <span className="hide-sm">{s.intent ? ` · ${s.intent}` : ''}</span>)
      </span>
      {over && <span className="yellow">已超过计划时长</span>}
      <button className="link" title="结束 Session（f）" onClick={() => run('/end')}>结束</button>
    </div>
  );
}

export const Bottom = forwardRef<PromptHandle, {
  output: Output | null;
  onRun: (s: string) => void;
  onUndo: () => void;
  onToggleMode: () => void;
  budgetLevel: BudgetLevel;
  used: number;
  advice: string | null;
  dock: React.ReactNode;
}>(function Bottom({ output, onRun, onUndo, onToggleMode, budgetLevel, used, advice, dock }, ref) {
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
    if (needsArg(c)) setV(`/${c.name} `);
    else submit(`/${c.name}`);
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

  const fat = latestFatigue(state);
  const budgetLeft = Math.max(0, Math.round((1 - used / state.settings.dailyBudget) * 100));

  return (
    <footer className="bottom">
      {output && (
        <div className={`output ${output.error ? 'err' : ''}`} role="status" aria-live="polite">
          <span className={output.error ? 'red' : 'green'}>⏺</span>
          <span className="cmd">{output.cmd}</span>
          <span className="faint">⎿</span>
          <span className="res">
            {output.text}
            {output.undoable && store.canUndo() && (
              <button className="link" title="Ctrl+Z" onClick={onUndo}>
                撤销
              </button>
            )}
          </span>
        </div>
      )}
      <SpinnerLine />
      {dock}
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
        <button className={`sl ${mode === 'plan' ? 'mode-plan' : 'mode-goal'}`} onClick={onToggleMode} title="切换 Plan / Goal 模式（Shift+Tab）">
          {mode === 'plan' ? '⏸ plan mode on' : '⏵⏵ goal mode on'}
        </button>
        {advice ? <span className="yellow">{advice}</span> : <button className="sl faint" onClick={() => open({ type: 'help' })}>? for shortcuts</button>}
        <span className="spacer" />
        <button className="sl" title={`模型档位：${TIERS[state.hie.tier].hint}（点击切换）`} onClick={() => onRun('/model')}>
          <TierLabel tier={state.hie.tier} />
        </button>
        <span className="sep">·</span>
        <button className="sl" title="推理强度（点击切换）" onClick={() => onRun('/effort')}>
          <EffortLabel effort={state.hie.effort} />
        </button>
        <span className="sep">·</span>
        <span
          className={`sl ${budgetLevel === 'ok' ? 'dim' : budgetLevel === 'warn' ? 'yellow' : 'red'}`}
          title={`今日 Cognitive Token：${used.toLocaleString()} / ${state.settings.dailyBudget.toLocaleString()}（/budget 修改）`}
        >
          <span className="meter">{bar(used / state.settings.dailyBudget, 6)}</span> {fmtTokens(used)}/{fmtTokens(state.settings.dailyBudget)}
          {budgetLevel === 'low' && ` · ${budgetLeft}% left`}
        </span>
        <span className="sep">·</span>
        <button className={`sl ${fat && fat >= 4 ? 'yellow' : 'dim'}`} title="疲劳自评 1–5（点击填写）" onClick={() => (ta.current && (setV('/fatigue '), ta.current.focus()))}>
          {fat ? `疲劳 ${fat}/5` : '疲劳 –'}
        </button>
        <span className="sep">·</span>
        <SyncIndicator />
        {store.saveError() && <span className="red">✗ 未保存</span>}
      </div>
    </footer>
  );
});

function SyncIndicator() {
  const { sync, open } = useApp();
  const st = useSyncStatus(sync);
  const label =
    st.phase === 'off' ? <span className="faint">本地</span>
    : st.phase === 'syncing' ? <span className="blue">⟳ 同步中</span>
    : st.phase === 'offline' ? <span className="yellow">⚠ 离线</span>
    : st.phase === 'error' ? <span className="red">✗ 同步失败</span>
    : <span className="dim">✓ 已同步</span>;
  const title =
    st.phase === 'off' ? '数据只在这台设备上（点击连接服务器）'
    : st.error ?? (st.lastSyncAt ? `上次同步：${fmtAgo(st.lastSyncAt)}` : '同步');
  return (
    <button className="sl" title={title} onClick={() => open({ type: 'sync' })}>
      {label}
    </button>
  );
}
