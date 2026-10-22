import { useState, type ReactNode } from 'react';
import type { Goal, Plan, Workspace } from '@automedo/core';
import { useApp } from '../ctx';
import { ops } from '@automedo/core';
import { diffPlan, diffSummary } from '@automedo/core';
import { bar, fmtAgo, fmtDate } from '@automedo/core';
import { AddRow, InlineEdit } from './Inline';
import { DoneLine, TaskRow } from './TaskRow';
import { useConfirmDeleteWs } from './Dialogs';

const VERDICT: Record<string, string> = { 'on-track': '顺利', drifting: '偏航', blocked: '受阻', pivot: '转向' };

function Tabs({ tabs }: { tabs: { key: string; label: ReactNode; body: () => ReactNode }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const cur = tabs.find((t) => t.key === open);
  return (
    <>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} aria-expanded={open === t.key} onClick={() => setOpen(open === t.key ? null : t.key)}>
            <span className="faint">{open === t.key ? '▾' : '▸'}</span> {t.label}
          </button>
        ))}
      </div>
      {cur && <div className="tab-body">{cur.body()}</div>}
    </>
  );
}

export function WsHead({ ws, sel, setSel, onDiff }: { ws: Workspace; sel: string | null; setSel: (id: string) => void; onDiff: () => void }) {
  return ws.kind === 'plan' ? <PlanHead plan={ws} sel={sel} setSel={setSel} onDiff={onDiff} /> : <GoalHead goal={ws} sel={sel} setSel={setSel} />;
}

function PlanHead({ plan, sel, setSel, onDiff }: { plan: Plan; sel: string | null; setSel: (id: string) => void; onDiff: () => void }) {
  const { act, open } = useApp();
  const [showDone, setShowDone] = useState(false);
  const ordered = ops.orderedTasks(plan);
  const counted = ordered.filter((t) => t.status !== 'skipped');
  const doneN = counted.filter((t) => t.status === 'done').length;
  const phase = ops.currentPhase(plan);
  const phaseIdx = phase ? plan.phases.indexOf(phase) : -1;
  const pd = diffPlan(plan);
  const sum = pd && diffSummary(pd);
  const num = (id: string) => ordered.findIndex((t) => t.id === id) + 1;

  return (
    <div className="ws-head">
      <div className="ws-title">
        <InlineEdit value={plan.title} ariaLabel="计划标题" onSave={(v) => act('重命名', (d) => ops.updatePlan(d, plan.id, { title: v }))} />
        {plan.status !== 'active' && <span className="tag">{plan.status}</span>}
        <WsActions ws={plan} />
      </div>
      <div className="ws-meta">
        {phase && (
          <span className="teal">
            Phase {phaseIdx + 1}/{plan.phases.length} · {phase.title}
            {phase.due && <span className={Date.now() > ops.dueAt(phase.due) && phase.status !== 'done' ? 'yellow' : 'dim'}> · 目标 {phase.due.slice(5)}</span>}
          </span>
        )}
        <span>
          <span className="meter">{bar(counted.length ? doneN / counted.length : 0, 8)}</span> {doneN}/{counted.length}
        </span>
        {pd ? (
          <button className="link" onClick={onDiff} title="Plan Diff（/diff）">
            相对 v{pd.base.v}：{sum ?? '无偏差'}
          </button>
        ) : (
          <span className="faint">开始第一个任务时建立基准 v1</span>
        )}
      </div>
      <Tabs
        tabs={[
          {
            key: 'tasks',
            label: <>任务 <span className="faint">{ordered.length}</span></>,
            body: () => (
              <>
                {plan.phases.map((ph) => {
                  const ts = ordered.filter((t) => t.phaseId === ph.id);
                  const open_ = ts.filter((t) => t.status !== 'done' && t.status !== 'skipped');
                  const done = ts.filter((t) => t.status === 'done' || t.status === 'skipped');
                  return (
                    <div key={ph.id} className="tgroup">
                      <div className={ph.status === 'active' ? 'teal' : 'faint'}>## {ph.title}</div>
                      {open_.map((t) => <TaskRow key={t.id} task={t} num={num(t.id)} selected={sel === t.id} onSelect={() => setSel(t.id)} />)}
                      {showDone && done.map((t) => <TaskRow key={t.id} task={t} num={num(t.id)} selected={sel === t.id} onSelect={() => setSel(t.id)} />)}
                      {ph.status !== 'done' && <AddRow placeholder={`+ 添加到「${ph.title}」`} onAdd={(v) => act('添加任务', (d) => void ops.addTask(d, v, ph.id))} />}
                    </div>
                  );
                })}
                <DoneLine count={counted.length ? ordered.filter((t) => t.status === 'done' || t.status === 'skipped').length : 0} open={showDone} onToggle={() => setShowDone(!showDone)} />
              </>
            ),
          },
          {
            key: 'phases',
            label: <>阶段 <span className="faint">{plan.phases.length}</span></>,
            body: () => (
              <>
                <div className="dim" style={{ marginBottom: 6 }}>
                  目标：<InlineEdit value={plan.objective} placeholder="写下这份计划要达成什么" ariaLabel="计划目标" onSave={(v) => act('编辑目标', (d) => ops.updatePlan(d, plan.id, { objective: v }))} />
                </div>
                {plan.phases.map((ph, i) => {
                  const ts = plan.tasks.filter((t) => t.phaseId === ph.id && t.status !== 'skipped');
                  const dn = ts.filter((t) => t.status === 'done').length;
                  return (
                    <div key={ph.id} className={`phase st-${ph.status}`}>
                      <div className="phase-h">
                        <span className={ph.status === 'active' ? 'teal' : ph.status === 'done' ? 'green' : 'faint'}>{ph.status === 'done' ? '✓' : ph.status === 'active' ? '▸' : '·'}</span>
                        <span className="name">
                          {i + 1}. <InlineEdit value={ph.title} ariaLabel="阶段标题" onSave={(v) => act('编辑阶段', (d) => ops.updatePhase(d, ph.id, { title: v }))} />
                        </span>
                        <span className="faint">{dn}/{ts.length}</span>
                        <span className="faint">
                          目标日期 <InlineEdit value={ph.due ?? ''} placeholder="—" ariaLabel="阶段目标日期（YYYY-MM-DD / +3d）" onSave={(v) => act('设置目标日期', (d) => ops.updatePhase(d, ph.id, { due: v || null }))} />
                        </span>
                        <span className="phase-tools">
                          <button className="icon-btn" title="修正阶段目标（记录原因，生成新版本）" onClick={() => open({ type: 'revise', phaseId: ph.id })}>↻ 修正</button>
                          {ph.status !== 'done' && <button className="icon-btn" onClick={() => act('完成阶段', (d) => ops.completePhase(d, ph.id))}>✓ 完成</button>}
                          {ph.status !== 'active' && <button className="icon-btn" onClick={() => act('切换阶段', (d) => ops.activatePhase(d, ph.id))}>设为当前</button>}
                          <button className="icon-btn" title="上移" onClick={() => act('移动阶段', (d) => ops.movePhase(d, ph.id, -1))}>↑</button>
                          <button className="icon-btn" title="下移" onClick={() => act('移动阶段', (d) => ops.movePhase(d, ph.id, 1))}>↓</button>
                          <button
                            className="icon-btn danger"
                            title="删除阶段"
                            onClick={() =>
                              ts.length
                                ? open({
                                    type: 'confirm',
                                    title: `删除阶段「${ph.title}」？`,
                                    message: `其中的 ${ts.length} 个任务也会被删除。可以撤销。`,
                                    confirmLabel: '删除',
                                    danger: true,
                                    onConfirm: () => act('删除阶段', (d) => ops.deletePhase(d, ph.id)),
                                  })
                                : act('删除阶段', (d) => ops.deletePhase(d, ph.id))
                            }
                          >
                            ⌫
                          </button>
                        </span>
                      </div>
                      <div className="phase-goal">
                        <InlineEdit value={ph.goal} placeholder="阶段目标：结束时应达到什么状态？" ariaLabel="阶段目标" onSave={(v) => act('编辑阶段目标', (d) => ops.updatePhase(d, ph.id, { goal: v }))} />
                      </div>
                    </div>
                  );
                })}
                <AddRow placeholder="+ 新增阶段" onAdd={(v) => act('新增阶段', (d) => ops.addPhase(d, v))} />
              </>
            ),
          },
          {
            key: 'versions',
            label: <>版本 <span className="faint">{plan.versions.length}</span></>,
            body: () => (
              <>
                {plan.versions.length === 0 && <div className="faint">还没有版本。第一次开始任务时自动建立 v1，或输入 /commit。</div>}
                {[...plan.versions].reverse().map((v) => (
                  <div key={v.v} className="ver">
                    <span className="teal">v{v.v}</span>
                    <span className="faint">{fmtDate(v.at)}</span>
                    <span className="fg-2">{v.message}</span>
                    <span className="faint">{v.tasks.length} 项任务</span>
                  </div>
                ))}
                {plan.versions.length > 0 && (
                  <div className="row-btns" style={{ marginTop: 6 }}>
                    <button className="btn" onClick={onDiff}>查看 Plan Diff</button>
                    <button className="btn ghost" onClick={() => act('Commit', (d) => ops.commitPlan(d, ''))}>/commit 提交新版本</button>
                  </div>
                )}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

function GoalHead({ goal, sel, setSel }: { goal: Goal; sel: string | null; setSel: (id: string) => void }) {
  const { act, open } = useApp();
  const [showDone, setShowDone] = useState(false);
  const last = goal.checkpoints[goal.checkpoints.length - 1];
  const due = ops.checkpointDue(goal);
  const done = goal.moves.filter((m) => m.status === 'done' || m.status === 'skipped');
  const ordered = ops.orderedTasks(goal);
  const openMoves = ordered.filter((m) => !done.includes(m));
  return (
    <div className="ws-head">
      <div className="ws-title">
        <InlineEdit value={goal.title} ariaLabel="目标标题" onSave={(v) => act('重命名', (d) => ops.updateGoal(d, goal.id, { title: v }))} />
        {goal.status !== 'active' && <span className="tag">{goal.status}</span>}
        <WsActions ws={goal} />
      </div>
      <div className="ws-meta">
        {last ? (
          <span>
            <span className="meter violet">{bar(last.progress / 100, 8)}</span> {last.progress}% · {VERDICT[last.verdict]} · {fmtAgo(last.at)}
          </span>
        ) : (
          <span className="faint">还没有 Checkpoint——先干起来</span>
        )}
        {due ? (
          <button className="link yellow" onClick={() => open({ type: 'checkpoint', goalId: goal.id })}>⚑ Checkpoint 到期</button>
        ) : (
          <button className="link" onClick={() => open({ type: 'checkpoint', goalId: goal.id })}>下次 Checkpoint {fmtDate(ops.nextCheckpointAt(goal)).slice(5)}</button>
        )}
      </div>
      <Tabs
        tabs={[
          {
            key: 'moves',
            label: <>行动 <span className="faint">{goal.moves.length}</span></>,
            body: () => (
              <>
                {openMoves.map((m) => <TaskRow key={m.id} task={m} num={ordered.indexOf(m) + 1} selected={sel === m.id} onSelect={() => setSel(m.id)} />)}
                <DoneLine count={done.length} open={showDone} onToggle={() => setShowDone(!showDone)} />
                {showDone && done.map((m) => <TaskRow key={m.id} task={m} num={ordered.indexOf(m) + 1} selected={sel === m.id} onSelect={() => setSel(m.id)} />)}
                <AddRow placeholder="+ 添加行动" onAdd={(v) => act('添加行动', (d) => void ops.addTask(d, v))} />
              </>
            ),
          },
          {
            key: 'detail',
            label: '目标详情',
            body: () => (
              <dl className="kv">
                <dt>为什么</dt>
                <dd><InlineEdit value={goal.why} placeholder="这个目标为什么重要？" ariaLabel="为什么" onSave={(v) => act('编辑目标', (d) => ops.updateGoal(d, goal.id, { why: v }))} /></dd>
                <dt>完成标准</dt>
                <dd><InlineEdit value={goal.doneWhen} placeholder="怎样算达成？可以先模糊" ariaLabel="完成标准" onSave={(v) => act('编辑目标', (d) => ops.updateGoal(d, goal.id, { doneWhen: v }))} /></dd>
                <dt>周期</dt>
                <dd>每 <InlineEdit value={String(goal.cadenceDays)} ariaLabel="Checkpoint 周期（天）" onSave={(v) => act('设置周期', (d) => ops.updateGoal(d, goal.id, { cadenceDays: Number(v) }))} /> 天 Checkpoint 一次</dd>
                <dt>下一步</dt>
                <dd><InlineEdit value={goal.nextAction} placeholder="下一步方向" ariaLabel="下一步方向" onSave={(v) => act('设置下一步', (d) => ops.updateGoal(d, goal.id, { nextAction: v }))} /></dd>
              </dl>
            ),
          },
          {
            key: 'cps',
            label: <>Checkpoints <span className="faint">{goal.checkpoints.length}</span></>,
            body: () => (
              <>
                {goal.checkpoints.length === 0 && <div className="faint">还没有 Checkpoint。</div>}
                {[...goal.checkpoints].reverse().map((c, i) => (
                  <div key={c.id} className={`cp ${c.verdict}`}>
                    <div>
                      <span className="bold">#{goal.checkpoints.length - i}</span> <span className="dim">{fmtDate(c.at)}</span>{'　'}
                      <span className="meter violet">{bar(c.progress / 100, 10)}</span> {c.progress}% · {VERDICT[c.verdict]}
                    </div>
                    <dl>
                      {c.did && (<><dt>做了</dt><dd>{c.did}</dd></>)}
                      {c.learned && (<><dt>学到</dt><dd>{c.learned}</dd></>)}
                      {c.next && (<><dt>下一步</dt><dd>{c.next}</dd></>)}
                    </dl>
                  </div>
                ))}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

/** Archive / delete for the open Plan or Goal; shown on hover of the title row. */
function WsActions({ ws }: { ws: Workspace }) {
  const { act } = useApp();
  const confirmDelete = useConfirmDeleteWs();
  const archived = ws.status === 'archived';
  return (
    <span className="ws-actions">
      <button className="btn ghost" onClick={() => act(archived ? '恢复' : '归档', (d) => ops.setWsStatus(d, ws.id, archived ? 'active' : 'archived'))}>
        {archived ? '恢复' : '归档'}
      </button>
      <button className="btn ghost danger" onClick={() => confirmDelete(ws)}>删除</button>
    </span>
  );
}
