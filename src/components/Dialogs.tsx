import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Dialog } from '../dialogs';
import { useApp } from '../ctx';
import { COMMANDS } from '../commands';
import { generateCompact } from '../compact';
import { activeSession, EFFORT_ORDER, EFFORTS, estimateTokens, FATIGUE_LABELS, runSegmentsTokens, TIER_ORDER, TIERS, tokensToday } from '../hie';
import * as ops from '../ops';
import { activePlan, currentWs, findWs } from '../store';
import type { Effort, Tier, Verdict, Workspace } from '../types';
import { fmtAgo, fmtDuration, fmtTokens } from '../util';
import { EffortLabel, TierLabel } from './Hie';

function Shell(props: { title: ReactNode; desc?: ReactNode; wide?: boolean; onSubmit?: () => void; children: ReactNode; actions?: ReactNode; submitLabel?: string; danger?: boolean; error?: string | null }) {
  const { close } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const el = root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('input, textarea, button.primary') ?? root;
    el?.focus();
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className={`dialog ${props.wide ? 'wide' : ''}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        ref={ref}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && props.onSubmit) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      >
        <h3>{props.title}</h3>
        {props.desc && <p className="desc">{props.desc}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmit?.();
          }}
        >
          {props.children}
          {props.error && <div className="form-err">⎿ {props.error}</div>}
          <div className="dialog-actions">
            {props.actions}
            <button type="button" className="btn" onClick={close}>取消</button>
            {props.onSubmit && (
              <button type="submit" className={`btn primary ${props.danger ? 'danger' : ''}`}>
                {props.submitLabel ?? '确认'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/** Wrap a mutation so dialog shows the user error instead of closing. */
function useSubmit() {
  const { store, say, close } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const submit = (label: string, fn: Parameters<typeof store.mutate>[1], keepOpen = false) => {
    try {
      const r = store.mutate(label, fn);
      say({ cmd: label, text: typeof r === 'string' ? r : label, undoable: true });
      if (!keepOpen) close();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    }
  };
  return { err, setErr, submit };
}

export function DialogHost({ dialog }: { dialog: Dialog }) {
  switch (dialog.type) {
    case 'newPlan':
      return <NewPlan title={dialog.title} />;
    case 'newGoal':
      return <NewGoal title={dialog.title} />;
    case 'session':
      return <StartSession minutes={dialog.minutes} />;
    case 'endSession':
      return <EndSession />;
    case 'revise':
      return <Revise phaseId={dialog.phaseId} />;
    case 'checkpoint':
      return <CheckpointForm goalId={dialog.goalId} />;
    case 'compact':
      return <CompactForm wsId={dialog.wsId} />;
    case 'resume':
      return <Resume compactId={dialog.compactId} />;
    case 'editTask':
      return <EditTask taskId={dialog.taskId} />;
    case 'help':
      return <Help />;
    case 'switch':
      return <Switcher />;
    case 'confirm':
      return <Confirm {...dialog} />;
  }
}

function NewPlan({ title = '' }: { title?: string }) {
  const [t, setT] = useState(title);
  const [obj, setObj] = useState('');
  const [phases, setPhases] = useState('');
  const { err, submit } = useSubmit();
  return (
    <Shell
      title={<><span className="teal">⏸</span> 新建 Plan</>}
      desc="路径相对明确时：先写计划、划分阶段，再执行。"
      error={err}
      submitLabel="创建计划"
      onSubmit={() =>
        submit('新建计划', (d) => {
          const p = ops.createPlan(d, t, obj);
          const names = phases.split('\n').map((s) => s.trim()).filter(Boolean);
          if (names.length) {
            p.phases = [];
            names.forEach((n) => ops.addPhase(d, n));
          }
          return `已创建计划「${p.title}」`;
        })
      }
    >
      <label className="field"><span>标题 *</span><input data-autofocus value={t} onChange={(e) => setT(e.target.value)} placeholder="例如：完成个人网站改版" /></label>
      <label className="field"><span>目标 / 完成定义</span><textarea value={obj} onChange={(e) => setObj(e.target.value)} placeholder="做完之后，世界会有什么不同？" /></label>
      <label className="field"><span>阶段（每行一个，可留空稍后添加）</span><textarea value={phases} onChange={(e) => setPhases(e.target.value)} placeholder={'调研\n设计\n实现\n发布'} /></label>
    </Shell>
  );
}

function NewGoal({ title = '' }: { title?: string }) {
  const [t, setT] = useState(title);
  const [why, setWhy] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [next, setNext] = useState('');
  const [cad, setCad] = useState('7');
  const { err, submit } = useSubmit();
  return (
    <Shell
      title={<><span className="violet">⏵⏵</span> 新建 Goal</>}
      desc="路径不明确时：先设目标，开始行动，用定期 Checkpoint 逐步找到方向。"
      error={err}
      submitLabel="设定目标"
      onSubmit={() => submit('新建目标', (d) => `已设定目标「${ops.createGoal(d, t, { why, doneWhen, nextAction: next, cadenceDays: Number(cad) }).title}」`)}
    >
      <label className="field"><span>目标 *</span><input data-autofocus value={t} onChange={(e) => setT(e.target.value)} placeholder="例如：找到适合自己的运动习惯" /></label>
      <label className="field"><span>为什么重要</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      <label className="field"><span>怎样算达成（可以先模糊）</span><input value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} /></label>
      <div className="row">
        <label className="field"><span>第一步动作</span><input value={next} onChange={(e) => setNext(e.target.value)} placeholder="30 分钟内能开始的事" /></label>
        <label className="field" style={{ maxWidth: 180 }}><span>Checkpoint 周期（天）</span><input type="number" min={1} max={90} value={cad} onChange={(e) => setCad(e.target.value)} /></label>
      </div>
    </Shell>
  );
}

function TierPicker({ tier, setTier, effort, setEffort }: { tier: Tier; setTier: (t: Tier) => void; effort: Effort; setEffort: (e: Effort) => void }) {
  return (
    <>
      <div className="field">
        <span>模型档位 /model</span>
        <div className="seg" role="group" aria-label="模型档位">
          {TIER_ORDER.map((t) => (
            <button type="button" key={t} aria-pressed={tier === t} onClick={() => setTier(t)}>
              <TierLabel tier={t} /> <span className="dim">· {TIERS[t].rate}/min</span>
              <small>{TIERS[t].hint}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>推理强度 /effort</span>
        <div className="seg" role="group" aria-label="推理强度">
          {EFFORT_ORDER.map((e) => (
            <button type="button" key={e} aria-pressed={effort === e} onClick={() => setEffort(e)}>
              <EffortLabel effort={e} /> <span className="dim">×{EFFORTS[e].mult}</span>
              <small>{EFFORTS[e].hint}</small>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function StartSession({ minutes }: { minutes?: number }) {
  const { state } = useApp();
  const ws = ops.requireWsSafe(state);
  const active = ws ? ops.orderedTasks(ws).find((t) => t.status === 'active') : undefined;
  const [tier, setTier] = useState<Tier>(state.hie.tier);
  const [effort, setEffort] = useState<Effort>(state.hie.effort);
  const [mins, setMins] = useState(String(minutes ?? 25));
  const [intent, setIntent] = useState(active?.title ?? (ws?.kind === 'goal' ? ws.nextAction : ''));
  const { err, submit } = useSubmit();
  const est = estimateTokens(tier, effort, Number(mins) || 0);
  const used = tokensToday(state);
  const left = state.settings.dailyBudget - used;
  return (
    <Shell
      title={<><span className="accent">✻</span> 开始专注 Session</>}
      desc={<>今天以什么档位工作？{ws ? <>关联：<span className="fg">「{ws.title}」</span></> : '（未关联 Plan/Goal）'}</>}
      error={err}
      submitLabel="▶ 开始"
      onSubmit={() => submit('开始 Session', (d) => ops.startSession(d, { intent, plannedMin: Number(mins), tier, effort }))}
    >
      <label className="field"><span>这次 Session 要做什么</span><input data-autofocus value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="一句话意图" /></label>
      <TierPicker tier={tier} setTier={setTier} effort={effort} setEffort={setEffort} />
      <div className="row">
        <label className="field" style={{ maxWidth: 160 }}><span>计划时长（分钟）</span><input type="number" min={5} max={480} value={mins} onChange={(e) => setMins(e.target.value)} /></label>
        <div className="field">
          <span>预计消耗</span>
          <div>
            ≈ <span className="accent">{fmtTokens(est)}</span> tokens
            <span className={est > left ? 'red' : 'dim'} style={{ marginLeft: 12 }}>今日剩余 {fmtTokens(Math.max(0, left))}{est > left ? ' · 将超出预算' : ''}</span>
          </div>
        </div>
      </div>
      <div className="disclaimer">“模型”“Token”只是交互隐喻，用来安排投入强度；不是对脑力或疲劳的生理测量。</div>
    </Shell>
  );
}

function FatiguePicker({ v, set }: { v: number | null; set: (n: number) => void }) {
  return (
    <div className="seg inline" role="group" aria-label="疲劳自评">
      {[1, 2, 3, 4, 5].map((n) => (
        <button type="button" key={n} aria-pressed={v === n} onClick={() => set(n)}>
          {n}<small>{FATIGUE_LABELS[n]}</small>
        </button>
      ))}
    </div>
  );
}

function EndSession() {
  const { state } = useApp();
  const s = activeSession(state);
  const [fat, setFat] = useState<number | null>(null);
  const [outcome, setOutcome] = useState('');
  const [doCompact, setDoCompact] = useState(true);
  const { err, submit } = useSubmit();
  const { open } = useApp();
  if (!s) return <Shell title="没有进行中的 Session">当前没有进行中的 Session。</Shell>;
  const runStart = state.sessions.filter((x) => x.runId === s.runId)[0]?.startedAt ?? s.startedAt;
  const tokens = runSegmentsTokens(state, s.runId);
  return (
    <Shell
      title={<><span className="green">⏺</span> 结束 Session</>}
      desc={<>已专注 {fmtDuration(Date.now() - runStart)} · ↑ {fmtTokens(tokens)} tokens</>}
      error={err}
      submitLabel="结束"
      onSubmit={() => {
        const wsId = s.wsId;
        if (submit('结束 Session', (d) => ops.endSession(d, { fatigue: fat, outcome }))) {
          if (doCompact && wsId && findWs(state, wsId)) open({ type: 'compact', wsId });
        }
      }}
    >
      <label className="field"><span>这次推进了什么</span><input data-autofocus value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="一句话结果（可选）" /></label>
      <div className="field"><span>疲劳自评（可选）</span><FatiguePicker v={fat} set={setFat} /></div>
      <button type="button" className="toggle" role="checkbox" aria-checked={doCompact} disabled={!s.wsId} onClick={() => setDoCompact(!doCompact)}>
        <span className="tb">[{doCompact ? 'x' : ' '}]</span> 结束后生成 Compact 快照，方便下次 Resume
      </button>
    </Shell>
  );
}

function Revise({ phaseId }: { phaseId: string }) {
  const { state } = useApp();
  const plan = activePlan(state);
  const ph = plan?.phases.find((x) => x.id === phaseId);
  const [goal, setGoal] = useState(ph?.goal ?? '');
  const [reason, setReason] = useState('');
  const { err, submit } = useSubmit();
  if (!ph) return <Shell title="找不到阶段">该阶段可能已被删除。</Shell>;
  return (
    <Shell
      title={<><span className="yellow">↻</span> 修正阶段「{ph.title}」</>}
      desc="计划不是承诺，是假设。修正时写下原因，复盘时最有价值。"
      error={err}
      submitLabel="记录修正"
      onSubmit={() => submit('修正阶段', (d) => ops.revisePhase(d, phaseId, goal, reason))}
    >
      <div className="field"><span>原阶段目标</span><div className="dim">{ph.goal || '（未设定）'}</div></div>
      <label className="field"><span>修正后的阶段目标 *</span><textarea data-autofocus value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
      <label className="field"><span>修正原因 *</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="发现了什么？哪个假设不成立？" /></label>
    </Shell>
  );
}

function CheckpointForm({ goalId }: { goalId: string }) {
  const { state } = useApp();
  const g = state.goals.find((x) => x.id === goalId);
  const last = g?.checkpoints[g.checkpoints.length - 1];
  const [progress, setProgress] = useState(last?.progress ?? 0);
  const [verdict, setVerdict] = useState<Verdict>('on-track');
  const [did, setDid] = useState(() => (g ? g.moves.filter((m) => m.status === 'done' && (m.doneAt ?? 0) > (last?.at ?? 0)).map((m) => `- ${m.title}`).join('\n') : ''));
  const [learned, setLearned] = useState('');
  const [next, setNext] = useState(g?.nextAction ?? '');
  const { err, submit } = useSubmit();
  if (!g) return <Shell title="找不到目标">该目标可能已被删除。</Shell>;
  const V: [Verdict, string, string][] = [
    ['on-track', '顺利', '方向对，继续'],
    ['drifting', '偏航', '在做，但不太对'],
    ['blocked', '受阻', '卡住了'],
    ['pivot', '转向', '要换方向'],
  ];
  return (
    <Shell
      title={<><span className="violet">⚑</span> Checkpoint #{g.checkpoints.length + 1} · {g.title}</>}
      desc={last ? `上次：${fmtAgo(last.at)} · ${last.progress}%` : '第一次 Checkpoint：看看行动带来了什么。'}
      error={err}
      submitLabel="记录 Checkpoint"
      onSubmit={() => submit('Checkpoint', (d) => ops.addCheckpoint(d, goalId, { progress, verdict, did, learned, next }))}
    >
      <div className="field">
        <span>主观进度</span>
        <AsciiSlider value={progress} onChange={setProgress} label="主观进度" />
      </div>
      <div className="field">
        <span>判断</span>
        <div className="seg">
          {V.map(([k, l, h]) => (
            <button type="button" key={k} aria-pressed={verdict === k} onClick={() => setVerdict(k)}>{l}<small>{h}</small></button>
          ))}
        </div>
      </div>
      <label className="field"><span>做了什么</span><textarea data-autofocus value={did} onChange={(e) => setDid(e.target.value)} /></label>
      <label className="field"><span>学到 / 发现了什么</span><textarea value={learned} onChange={(e) => setLearned(e.target.value)} /></label>
      <label className="field"><span>下一步方向</span><input value={next} onChange={(e) => setNext(e.target.value)} /></label>
    </Shell>
  );
}

function CompactForm({ wsId }: { wsId: string }) {
  const { state } = useApp();
  const ws = findWs(state, wsId);
  const [text, setText] = useState(() => (ws ? generateCompact(state, ws) : ''));
  const { err, submit } = useSubmit();
  if (!ws) return <Shell title="找不到 Plan/Goal">它可能已被删除。</Shell>;
  return (
    <Shell
      wide
      title={<><span className="blue">◇</span> /compact · {ws.title}</>}
      desc="根据当前状态自动生成的工作快照（不使用 AI）。可以自由编辑，尤其是「恢复时先做」。"
      error={err}
      submitLabel="保存快照"
      actions={<button type="button" className="btn" onClick={() => setText(generateCompact(state, ws))}>重新生成</button>}
      onSubmit={() => submit('Compact', (d) => ops.saveCompact(d, wsId, text))}
    >
      <label className="field"><span>快照（Markdown）</span><textarea data-autofocus className="big" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></label>
    </Shell>
  );
}

function Resume({ compactId }: { compactId: string }) {
  const { state, store, close, say } = useApp();
  const c = state.compacts.find((x) => x.id === compactId);
  const ws = c && findWs(state, c.wsId);
  const list = state.compacts.filter((x) => x.wsId === c?.wsId);
  const idx = c ? list.indexOf(c) : -1;
  const { open } = useApp();
  if (!c) return <Shell title="快照不存在">它可能已被删除。</Shell>;
  return (
    <Shell
      wide
      title={<><span className="blue">↻</span> Resume · {ws?.title ?? '（已删除）'}</>}
      desc={<>快照保存于 {fmtAgo(c.at)} · 第 {idx + 1}/{list.length} 份</>}
      submitLabel="继续工作"
      actions={
        <>
          <button type="button" className="btn" disabled={idx <= 0} onClick={() => open({ type: 'resume', compactId: list[idx - 1].id })}>← 更早</button>
          <button type="button" className="btn" disabled={idx >= list.length - 1} onClick={() => open({ type: 'resume', compactId: list[idx + 1].id })}>更新 →</button>
        </>
      }
      onSubmit={() => {
        store.mutate(null, (d) => {
          if (ws) ops.selectWs(d, ws.id);
          d.ui.dismissedCompactId = c.id;
        });
        say({ cmd: '/resume', text: `已恢复「${ws?.title ?? ''}」的上下文` });
        close();
      }}
    >
      <pre className="pre" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6, padding: 12, maxHeight: '55vh', overflow: 'auto', margin: 0 }}>{c.text}</pre>
    </Shell>
  );
}

function EditTask({ taskId }: { taskId: string }) {
  const { state } = useApp();
  const ws = ops.requireWsSafe(state);
  const task = ws && (ws.kind === 'plan' ? ws.tasks : ws.moves).find((t) => t.id === taskId);
  const [title, setTitle] = useState(task?.title ?? '');
  const [note, setNote] = useState(task?.note ?? '');
  const [phaseId, setPhaseId] = useState(task?.phaseId ?? '');
  const { err, submit } = useSubmit();
  if (!ws || !task) return <Shell title="找不到任务">它可能已被删除。</Shell>;
  return (
    <Shell
      title="✎ 编辑任务"
      error={err}
      submitLabel="保存"
      onSubmit={() => submit('编辑任务', (d) => ops.updateTask(d, taskId, { title, note, phaseId: ws.kind === 'plan' ? phaseId || null : undefined }))}
    >
      <label className="field"><span>标题</span><input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>备注（阻塞原因、链接、上下文…）</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {ws.kind === 'plan' && (
        <label className="field">
          <span>所属阶段</span>
          <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
            {ws.phases.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </label>
      )}
    </Shell>
  );
}

function Confirm(props: Extract<Dialog, { type: 'confirm' }>) {
  const { close, say } = useApp();
  return (
    <Shell
      title={props.title}
      desc={props.message}
      danger={props.danger}
      submitLabel={props.confirmLabel ?? '确认'}
      onSubmit={() => {
        try {
          const r = props.onConfirm() as unknown;
          if (typeof r === 'string') say({ cmd: props.confirmLabel ?? '确认', text: r, undoable: true });
        } catch (e) {
          say({ cmd: props.confirmLabel ?? '确认', text: (e as Error).message, error: true });
        }
        close();
      }}
    >
      {null}
    </Shell>
  );
}

const KEYS: [string, string][] = [
  ['/', '聚焦命令行（输入 / 弹出命令补全）'],
  ['Shift+Tab', '切换 Plan Mode / Goal Mode'],
  ['j / k  ↓ / ↑', '选择上 / 下一个任务'],
  ['Space', '切换任务状态（待办 → 进行中 → 完成）'],
  ['s / d / b', '开始 / 完成 / 阻塞 选中任务'],
  ['e', '编辑选中任务'],
  ['x', '删除选中任务（可撤销）'],
  ['J / K', '下移 / 上移选中任务'],
  ['o', '打开 Plan / Goal 列表'],
  ['[ / ]', '上一个 / 下一个 Plan 或 Goal'],
  ['n', '新建 Plan / Goal（随当前模式）'],
  ['f', '开始 / 结束专注 Session'],
  ['c', 'Compact 快照'],
  ['Ctrl+Z', '撤销'],
  ['?', '打开帮助'],
  ['Esc', '关闭弹窗 / 离开输入框'],
];

function Help() {
  return (
    <Shell wide title={<><span className="accent">✻</span> AuTomeDo · Help</>} desc="像写 Agent 计划一样组织自己的工作。鼠标和键盘都可以完成所有操作。">
      <div className="help-sec">命令</div>
      <div className="help-grid">
        {COMMANDS.map((c) => [
          <span key={c.name + 'c'} className="c">/{c.name} {c.args && <span className="dim">{c.args}</span>}</span>,
          <span key={c.name + 'd'}>{c.desc}{c.mode && <span className="faint"> · {c.mode}</span>}</span>,
        ])}
        <span className="c">直接输入文字</span><span>添加任务（Plan）或行动（Goal）；没有工作区时作为新标题</span>
        <span className="c"># 内容</span><span>写一条日志</span>
      </div>
      <div className="help-sec">快捷键（焦点不在输入框时）</div>
      <div className="help-grid">
        {KEYS.map(([k, d]) => [<span key={k} className="c">{k}</span>, <span key={k + 'd'}>{d}</span>])}
      </div>
      <div className="help-sec">Human Inference Engine</div>
      <div className="dim">
        档位：Haiku 400 / Sonnet 800 / Opus 1500 tokens·min⁻¹；强度：low ×0.6 / medium ×1 / high ×1.5。Session 运行时按分钟累计，计入每日预算。
      </div>
      <div className="disclaimer">“模型”“Token”只是交互隐喻，不代表真实 AI 推理，也不是对脑力或疲劳的生理测量。</div>
    </Shell>
  );
}

function wsMeta(w: Workspace): string {
  if (w.kind === 'plan') {
    const ts = w.tasks.filter((t) => t.status !== 'skipped');
    const a = w.tasks.find((t) => t.status === 'active');
    return `${ts.filter((t) => t.status === 'done').length}/${ts.length}${a ? ` · ◼ ${a.title}` : ''}`;
  }
  const last = w.checkpoints[w.checkpoints.length - 1];
  return `${ops.checkpointDue(w) ? '⚑ 到期 · ' : ''}${last ? `${last.progress}%` : '–'}${w.nextAction ? ` · ${w.nextAction}` : ''}`;
}

/** Workspace picker, like Claude Code's /resume list. */
function Switcher() {
  const { state, store, close, open, run } = useApp();
  const [q, setQ] = useState('');
  const cur = currentWs(state);
  const ORDER = { active: 0, paused: 1, done: 2, archived: 3 } as const;
  const all: Workspace[] = [...state.plans, ...state.goals]
    .filter((w) => !q || w.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt);
  const [idx, setIdx] = useState(() => Math.max(0, all.findIndex((w) => w.id === cur?.id)));
  const pick = (w: Workspace | undefined) => {
    if (!w) return;
    store.mutate(null, (d) => ops.selectWs(d, w.id));
    close();
  };
  return (
    <Shell
      title="切换 Plan / Goal"
      actions={
        <>
          <button type="button" className="btn" onClick={() => open({ type: 'newPlan' })}>+ Plan</button>
          <button type="button" className="btn" onClick={() => open({ type: 'newGoal' })}>+ Goal</button>
          <button type="button" className="btn ghost" onClick={() => { close(); run('/export'); }}>导出</button>
          <button type="button" className="btn ghost" onClick={() => { close(); run('/import'); }}>导入</button>
        </>
      }
    >
      <div className="field">
        <input
          data-autofocus
          value={q}
          placeholder="搜索…（↑↓ 选择，回车打开）"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(all.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter') { e.preventDefault(); pick(all[idx]); }
          }}
        />
      </div>
      <div className="picker" role="listbox">
        {all.length === 0 && <div className="faint">{q ? '没有匹配项' : '还没有 Plan 或 Goal'}</div>}
        {all.map((w, i) => (
          <div key={w.id} role="option" aria-selected={i === idx} className={`pick ${w.status !== 'active' ? 'muted' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(w)}>
            <span className={w.kind === 'plan' ? 'teal' : 'violet'}>{w.kind === 'plan' ? '⏸' : '⏵⏵'}</span>
            <span className="t">{w.title}{w.id === cur?.id && <span className="faint"> (当前)</span>}</span>
            <span className="faint m">{w.status !== 'active' ? `${w.status} · ` : ''}{wsMeta(w)}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Terminal-style slider: an ASCII bar you can click or drive with ←/→. */
function AsciiSlider({ value, onChange, label, step = 5, cells = 20 }: { value: number; onChange: (v: number) => void; label: string; step?: number; cells?: number }) {
  const set = (v: number) => onChange(Math.max(0, Math.min(100, Math.round(v / step) * step)));
  const full = Math.round((value / 100) * cells);
  return (
    <div
      className="ascii-slider"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); set(value + step); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); set(value - step); }
        if (e.key === 'Home') { e.preventDefault(); set(0); }
        if (e.key === 'End') { e.preventDefault(); set(100); }
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        const bar = (e.currentTarget.querySelector('.as-bar') as HTMLElement).getBoundingClientRect();
        if (bar.width > 0) set(((e.clientX - bar.left) / bar.width) * 100);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const bar = (e.currentTarget.querySelector('.as-bar') as HTMLElement).getBoundingClientRect();
        if (bar.width > 0) set(((e.clientX - bar.left) / bar.width) * 100);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      <span className="as-bar">
        <span className="as-on">{'█'.repeat(full)}</span>
        <span className="as-off">{'░'.repeat(cells - full)}</span>
      </span>
      <span className="as-val">{value}%</span>
    </div>
  );
}
