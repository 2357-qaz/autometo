import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ctx, type AppCtx, type Output } from './ctx';
import type { Intent as Dialog } from '@automedo/core';
import { execute, type CmdCtx } from '@automedo/core';
import { activeSession, budgetLevel, hieAdvice, latestFatigue, tokensToday } from '@automedo/core';
import { ops } from '@automedo/core';
import { currentWs, normalize, type Store, type SyncClient } from '@automedo/core';
import { useStore } from './store';
import type { AppState, Workspace } from '@automedo/core';
import { fmtAgo, fmtDate } from '@automedo/core';
import { seedDemo } from '@automedo/core';
import { DialogHost } from './components/Dialogs';
import { WsHead } from './components/WsHead';
import { Transcript } from './components/Transcript';
import { Dock } from './components/Dock';
import { Header } from './components/Header';
import { Bottom, type PromptHandle } from './components/Bottom';
import { Welcome } from './components/Welcome';
import type { LaunchResult } from './pwa';

const OPENED_AT = Date.now();

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

export function App({ store, sync, loadError, launch = null }: { store: Store; sync: SyncClient; loadError: string | null; launch?: LaunchResult | null }) {
  const state = useStore(store);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [output, setOutput] = useState<Output | null>(() => (launch ? { cmd: launch.cmd, text: launch.text, error: launch.error, undoable: !launch.error, at: Date.now() } : null));
  const [sel, setSel] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState(loadError);
  const [diffView, setDiffView] = useState<{ planId: string; v?: number; at: number } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const promptRef = useRef<PromptHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ws = currentWs(state);

  const say = useCallback((o: Omit<Output, 'at'>) => setOutput({ ...o, at: Date.now() }), []);
  const close = useCallback(() => setDialog(null), []);
  const act = useCallback<AppCtx['act']>(
    (label, fn, cmd) => {
      try {
        const r = store.mutate(label, fn);
        say({ cmd: cmd ?? label, text: typeof r === 'string' ? r : label, undoable: true });
        return true;
      } catch (e) {
        if (!(e instanceof ops.UserError)) console.error(e);
        say({ cmd: cmd ?? label, text: (e as Error).message, error: true });
        return false;
      }
    },
    [store, say],
  );

  const exportData = useCallback(() => {
    const blob = new Blob([JSON.stringify(store.get(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `automedo-backup-${fmtDate(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [store]);

  const importData = useCallback(() => fileRef.current?.click(), []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    let next: AppState;
    try {
      next = normalize(JSON.parse(await f.text()));
    } catch (err) {
      say({ cmd: '/import', text: `导入失败：${(err as Error).message}`, error: true });
      return;
    }
    setDialog({
      type: 'confirm',
      title: `导入「${f.name}」？`,
      message: `将用备份中的 ${next.plans.length} 个 Plan、${next.goals.length} 个 Goal 覆盖当前数据。之后可以撤销；建议先 /export 当前数据。`,
      confirmLabel: '覆盖导入',
      danger: true,
      onConfirm: () => {
        store.replace(next, '导入备份');
        say({ cmd: '/import', text: `已导入 ${next.plans.length} 个 Plan、${next.goals.length} 个 Goal`, undoable: true });
      },
    });
  };

  const focusPrompt = useCallback((prefill?: string) => promptRef.current?.focus(prefill), []);

  const showDiff = useCallback((planId: string, v?: number) => setDiffView({ planId, v, at: Date.now() }), []);
  const cmdCtx: CmdCtx = useMemo(() => ({ store, open: setDialog, exportData, importData, showDiff }), [store, exportData, importData, showDiff]);

  const run = useCallback(
    (input: string) => {
      const r = execute(input, cmdCtx);
      if (r) say({ cmd: input.trim(), ...r });
      else setOutput(null);
    },
    [cmdCtx, say],
  );

  const ctx: AppCtx = useMemo(
    () => ({ store, sync, state, open: setDialog, close, act, say, focusPrompt, run }),
    [store, sync, state, close, act, say, focusPrompt, run],
  );
  // Keep selection valid when workspace changes.
  const ordered = ws ? ops.orderedTasks(ws) : [];
  useEffect(() => {
    if (sel && !ordered.some((t) => t.id === sel)) setSel(null);
  }, [ws?.id, ordered.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the transcript pinned to the newest event, like a terminal.
  const lastWs = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const switched = lastWs.current !== ws?.id;
    lastWs.current = ws?.id;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (switched || nearBottom) el.scrollTop = el.scrollHeight;
  }, [ws?.id, ws?.log.length]);
  useEffect(() => {
    if (diffView) requestAnimationFrame(() => document.getElementById('plan-diff')?.scrollIntoView({ block: 'nearest' }));
  }, [diffView]);

  // Scroll selected task into view.
  useEffect(() => {
    if (sel) document.querySelector(`[data-task-id="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const toggleMode = useCallback(() => {
    store.mutate(null, (d) => {
      d.ui.mode = d.ui.mode === 'plan' ? 'goal' : 'plan';
      if (d.ui.mode === 'plan') d.ui.activePlanId ??= d.plans[0]?.id ?? null;
      else d.ui.activeGoalId ??= d.goals[0]?.id ?? null;
    });
  }, [store]);

  const allWs: Workspace[] = [...state.plans, ...state.goals];
  const cycleWs = (dir: 1 | -1) => {
    if (!allWs.length) return;
    const i = ws ? allWs.findIndex((w) => w.id === ws.id) : -1;
    const next = allWs[(i + dir + allWs.length) % allWs.length];
    store.mutate(null, (d) => ops.selectWs(d, next.id));
  };

  // Resume prompt: newest compact for this workspace saved before this page load.
  const resumable = ws
    ? [...state.compacts].reverse().find((c) => c.wsId === ws.id && c.at < OPENED_AT && c.id !== state.ui.dismissedCompactId)
    : undefined;
  const newestForWs = ws ? [...state.compacts].reverse().find((c) => c.wsId === ws.id) : undefined;
  const showResume = resumable && newestForWs?.id === resumable.id;

  // Global keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey && !dialog) {
        e.preventDefault();
        toggleMode();
        return;
      }
      if (dialog) {
        if (e.key === 'Escape') setDialog(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (isTyping(document.activeElement)) return;
        e.preventDefault();
        const l = store.undo();
        say(l ? { cmd: 'undo', text: `已撤销：${l}` } : { cmd: 'undo', text: '没有可撤销的操作', error: true });
        return;
      }
      if (isTyping(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Navigate over what is actually on screen (collapsed items are skipped).
      const visibleIds = Array.from(document.querySelectorAll<HTMLElement>('.app [data-task-id]')).map((el) => el.dataset.taskId!);
      const visible = visibleIds.map((id) => ordered.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);
      const idx = sel ? visible.findIndex((t) => t.id === sel) : -1;
      const cur = idx >= 0 ? visible[idx] : undefined;
      const k = e.key;
      const handled = () => e.preventDefault();
      if (k === '/') return handled(), focusPrompt('/');
      if (k === ':' || k === 'i') return handled(), focusPrompt('');
      if (k === '?') return handled(), setDialog({ type: 'help' });
      if (k === 'j' || k === 'ArrowDown') {
        if (!visible.length) return;
        handled();
        return setSel(visible[Math.min(visible.length - 1, idx + 1)].id);
      }
      if (k === 'k' || k === 'ArrowUp') {
        if (!visible.length) return;
        handled();
        return setSel(visible[Math.max(0, idx < 0 ? 0 : idx - 1)].id);
      }
      if (k === 'o') return handled(), setDialog({ type: 'switch' });
      if (k === 'r' && showResume && resumable) return handled(), setDialog({ type: 'resume', compactId: resumable.id });
      if (k === '[') return handled(), cycleWs(-1);
      if (k === ']') return handled(), cycleWs(1);
      if (k === 'n') return handled(), setDialog({ type: state.ui.mode === 'plan' ? 'newPlan' : 'newGoal' });
      if (k === 'f') return handled(), run(activeSession(state) ? '/end' : '/session');
      if (k === 'c') return handled(), run('/compact');
      if (k === 'Escape') return setSel(null);
      if (!cur) return;
      if (k === ' ') {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && (ae.tagName === 'BUTTON' || ae.getAttribute('role') === 'button')) return; // let the button handle it
        return handled(), act('切换任务状态', (d) => ops.cycleTask(d, cur.id));
      }
      if (k === 's') return handled(), act('开始任务', (d) => ops.setTaskStatus(d, cur.id, 'active'));
      if (k === 'd') return handled(), act('完成任务', (d) => ops.setTaskStatus(d, cur.id, 'done'));
      if (k === 'b') return handled(), act('标记阻塞', (d) => ops.setTaskStatus(d, cur.id, 'blocked'));
      if (k === 'e') return handled(), setDialog({ type: 'editTask', taskId: cur.id });
      if (k === 'J') return handled(), act('移动任务', (d) => ops.moveTask(d, cur.id, 1));
      if (k === 'K') return handled(), act('移动任务', (d) => ops.moveTask(d, cur.id, -1));
      if (k === 'x' || k === 'Delete' || k === 'Backspace') {
        handled();
        const nb = visible[idx + 1] ?? visible[idx - 1];
        act('删除任务', (d) => ops.deleteTask(d, cur.id));
        setSel(nb?.id ?? null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const used = tokensToday(state);
  const advice = hieAdvice(used, state.settings.dailyBudget, latestFatigue(state));
  const saveErr = store.saveError();

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <main className="main" ref={mainRef}>
          <Header />
          {loadErr && (
            <div className="notice err" role="alert">
              <span>✗ {loadErr}</span>
              <button className="link" onClick={() => setLoadErr(null)}>知道了</button>
            </div>
          )}
          {saveErr && (
            <div className="notice err" role="alert">
              <span>✗ {saveErr}。建议立即导出备份。</span>
              <button className="link" onClick={exportData}>导出备份</button>
            </div>
          )}
          {showResume && resumable && (
            <div className="notice resume" role="region" aria-label="恢复上下文">
              <span>
                <span className="blue">↻</span> 上次在这里留下了快照 <span className="faint">· {fmtAgo(resumable.at)}</span>
              </span>
              <button className="link blue" onClick={() => setDialog({ type: 'resume', compactId: resumable.id })}>
                Resume
              </button>
              <button className="link faint" onClick={() => store.mutate(null, (d) => void (d.ui.dismissedCompactId = resumable.id))}>忽略</button>
            </div>
          )}
          {!ws ? (
            <Welcome mode={state.ui.mode} onDemo={() => act('载入示例', (d) => void seedDemo(d))} />
          ) : (
            <>
              <WsHead ws={ws} sel={sel} setSel={setSel} onDiff={() => ws.kind === 'plan' && showDiff(ws.id)} />
              <Transcript ws={ws} diff={diffView} onCloseDiff={() => setDiffView(null)} onDiff={(v) => ws.kind === 'plan' && showDiff(ws.id, v)} />
            </>
          )}
        </main>
        <Bottom
          ref={promptRef}
          output={output}
          onRun={run}
          onUndo={() => {
            const l = store.undo();
            say(l ? { cmd: 'undo', text: `已撤销：${l}` } : { cmd: 'undo', text: '没有可撤销的操作', error: true });
          }}
          onToggleMode={toggleMode}
          budgetLevel={budgetLevel(used, state.settings.dailyBudget)}
          used={used}
          advice={ws ? advice : null}
          dock={ws ? <Dock ws={ws} sel={sel} setSel={setSel} /> : null}
        />
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
        {dialog && <DialogHost key={JSON.stringify({ ...dialog, onConfirm: undefined })} dialog={dialog} />}
      </div>
    </Ctx.Provider>
  );
}
