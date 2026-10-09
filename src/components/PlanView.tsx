import { useState } from 'react';
import type { Plan } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';
import { activeSession } from '../hie';
import { bar } from '../util';
import { Fold } from './Fold';
import { AddRow, InlineEdit } from './Inline';
import { LogList } from './LogBlock';
import { DoneLine, TaskRow } from './TaskRow';

const MAX_LATER = 5;

export function PlanView({ plan, selTaskId, setSel }: { plan: Plan; selTaskId: string | null; setSel: (id: string) => void }) {
  const { act, open, run, state } = useApp();
  const sess = activeSession(state);
  const [showDone, setShowDone] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ordered = ops.orderedTasks(plan);
  const num = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const counted = ordered.filter((t) => t.status !== 'skipped');
  const doneN = counted.filter((t) => t.status === 'done').length;
  const active = ordered.find((t) => t.status === 'active');
  const phase = ops.currentPhase(plan);
  const phaseIdx = phase ? plan.phases.indexOf(phase) : -1;

  const open_ = ordered.filter((t) => t.status !== 'done' && t.status !== 'skipped');
  const now = open_.filter((t) => t.phaseId === phase?.id);
  const later = open_.filter((t) => t.phaseId !== phase?.id);
  const laterShown = showAll ? later : later.slice(0, MAX_LATER);
  const done = ordered.filter((t) => t.status === 'done' || t.status === 'skipped');
  const nextT = (active ? open_.filter((t) => t.id !== active.id) : open_).find((t) => t.status === 'pending');

  return (
    <div className="col">
      <div className="ws-head">
        <div className="ws-title">
          <InlineEdit value={plan.title} ariaLabel="计划标题" onSave={(v) => act('重命名', (d) => ops.updatePlan(d, plan.id, { title: v }))} />
          {plan.status !== 'active' && <span className="tag">{plan.status}</span>}
        </div>
        <div className="dim">
          {phase && (
            <>
              <span className="teal">Phase {phaseIdx + 1}/{plan.phases.length} · {phase.title}</span>
              {phase.goal && <> — {phase.goal}</>}
              {'　'}
            </>
          )}
          <span className="meter">{bar(counted.length ? doneN / counted.length : 0, 10)}</span> {doneN}/{counted.length}
        </div>
      </div>

      {/* ── Focus: the one thing in progress ── */}
      <section className={`focus ${active && selTaskId === active.id ? 'sel' : ''}`} aria-label="当前任务" data-task-id={active?.id} onMouseDown={() => active && setSel(active.id)}>
        {active ? (
          <>
            <div className="focus-main">
              <span className="accent">⏺</span>
              <span className="focus-title">{active.title}</span>
            </div>
            <div className="focus-sub">
              <span className="faint">⎿</span>
              <span className="dim">{nextT ? <>然后：{nextT.title}</> : '这是最后一项'}</span>
            </div>
            <div className="focus-actions">
              <button className="btn primary" onClick={() => run('/next')}>✓ 完成{nextT ? '并继续' : ''}</button>
              <button className="btn" onClick={() => run(sess ? '/end' : '/session')}>{sess ? '■ 结束专注' : '✻ 专注'}</button>
              <button className="btn ghost" onClick={() => act('标记阻塞', (d) => ops.setTaskStatus(d, active.id, 'blocked'))}>✗ 卡住了</button>
            </div>
          </>
        ) : nextT ? (
          <>
            <div className="focus-main">
              <span className="faint">◇</span>
              <span className="dim">没有进行中的任务。下一个：</span>
              <span className="focus-title">{nextT.title}</span>
            </div>
            <div className="focus-actions">
              <button className="btn primary" onClick={() => act('开始任务', (d) => ops.setTaskStatus(d, nextT.id, 'active'))}>▶ 开始</button>
            </div>
          </>
        ) : ordered.length ? (
          <div className="focus-main">
            <span className="green">✓</span>
            <span>全部完成。</span>
            <button className="btn" onClick={() => run('/compact')}>/compact 收尾</button>
          </div>
        ) : (
          <div className="focus-main">
            <span className="faint">◇</span>
            <span className="dim">还没有任务。在下方输入一件要做的事，回车即可添加。</span>
          </div>
        )}
      </section>

      {/* ── Todos ── */}
      {(open_.length > 0 || done.length > 0) && (
        <section className="todos" aria-label="待办">
          {now.filter((t) => t.id !== active?.id).map((t) => (
            <TaskRow key={t.id} task={t} num={num(t.id)} selected={selTaskId === t.id} onSelect={() => setSel(t.id)} />
          ))}
          {laterShown.length > 0 && (
            <>
              <div className="todo-sep faint">— 之后的阶段 —</div>
              {laterShown.map((t) => (
                <TaskRow key={t.id} task={t} num={num(t.id)} dim selected={selTaskId === t.id} onSelect={() => setSel(t.id)} />
              ))}
            </>
          )}
          {later.length > MAX_LATER && (
            <button className="done-line" onClick={() => setShowAll(!showAll)}>
              <span className="faint">{showAll ? '收起 ▴' : `… 还有 ${later.length - MAX_LATER} 项 ▸`}</span>
            </button>
          )}
          <DoneLine count={done.length} open={showDone} onToggle={() => setShowDone(!showDone)} />
          {showDone && done.map((t) => <TaskRow key={t.id} task={t} num={num(t.id)} selected={selTaskId === t.id} onSelect={() => setSel(t.id)} />)}
        </section>
      )}

      <div className="folds">
        <Fold title="阶段" meta={`${plan.phases.length}`}>
          <div className="dim" style={{ marginBottom: 6 }}>
            目标：
            <InlineEdit value={plan.objective} placeholder="写下这份计划要达成什么" ariaLabel="计划目标" onSave={(v) => act('编辑目标', (d) => ops.updatePlan(d, plan.id, { objective: v }))} />
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
                  <span className="phase-tools">
                    <button className="icon-btn" title="修正阶段目标（记录原因）" onClick={() => open({ type: 'revise', phaseId: ph.id })}>↻ 修正</button>
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
                              message: `其中的 ${ts.length} 个任务也会被删除。可以 Ctrl+Z 撤销。`,
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
          <AddRow placeholder="+ 新增阶段，回车确认" onAdd={(v) => act('新增阶段', (d) => ops.addPhase(d, v))} />
        </Fold>
        <Fold title="日志" meta={`${plan.log.length}`}>
          <LogList ws={plan} />
        </Fold>
      </div>
    </div>
  );
}
