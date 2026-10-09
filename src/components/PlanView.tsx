import type { Plan } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';
import { bar } from '../util';
import { AddRow, InlineEdit } from './Inline';
import { LogBlock } from './LogBlock';
import { TaskRow } from './TaskRow';

export function PlanView({ plan, selTaskId, setSel }: { plan: Plan; selTaskId: string | null; setSel: (id: string) => void }) {
  const { act, open } = useApp();
  const ordered = ops.orderedTasks(plan);
  const counted = ordered.filter((t) => t.status !== 'skipped');
  const done = counted.filter((t) => t.status === 'done').length;
  const ratio = counted.length ? done / counted.length : 0;
  const active = ordered.find((t) => t.status === 'active');
  const nextT = ordered.find((t) => t.status === 'pending');
  const phase = ops.currentPhase(plan);
  const blocked = ordered.filter((t) => t.status === 'blocked');

  return (
    <div className="main-inner">
      <section className="hero" aria-label="计划概览">
        <h1>
          <span className="teal">⏸</span>
          <InlineEdit value={plan.title} ariaLabel="计划标题" onSave={(v) => act('重命名', (d) => ops.updatePlan(d, plan.id, { title: v }))} />
          <span className={`tag ${plan.status === 'active' ? 'active' : plan.status === 'done' ? 'done' : ''}`}>{plan.status}</span>
        </h1>
        <div className="sub">
          目标：
          <InlineEdit value={plan.objective} placeholder="写下这份计划要达成什么" ariaLabel="计划目标" onSave={(v) => act('编辑目标', (d) => ops.updatePlan(d, plan.id, { objective: v }))} />
        </div>
        <div className="qa">
          <div>
            <div className="q">我要做什么</div>
            <div className="a">{phase ? <>「{phase.title}」{phase.goal ? <span className="dim"> {phase.goal}</span> : null}</> : <span className="faint">还没有阶段</span>}</div>
          </div>
          <div>
            <div className="q">我做到哪里</div>
            <div className="a">
              <span className="meter teal">{bar(ratio, 10)}</span> {Math.round(ratio * 100)}% <span className="dim">({done}/{counted.length})</span>
              {active && <div className="accent">◼ {active.title}</div>}
              {blocked.length > 0 && <div className="red">✗ {blocked.length} 项阻塞</div>}
            </div>
          </div>
          <div>
            <div className="q">下一步怎么办</div>
            <div className="a">
              {active ? (
                <>完成当前任务后 <span className="kbd">/next</span>{nextT && <div className="dim">→ {nextT.title}</div>}</>
              ) : nextT ? (
                <>
                  {nextT.title}{' '}
                  <button className="btn primary" onClick={() => act('开始任务', (d) => ops.setTaskStatus(d, nextT.id, 'active'))}>▶ 开始</button>
                </>
              ) : ordered.length ? (
                <span className="green">全部完成 ✓ 可以 /compact 收尾</span>
              ) : (
                <span className="faint">在下方添加第一个任务</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {plan.phases.length > 1 && (
        <section className="block" aria-label="进度概览">
          <div className="block-h">
            <span className="bullet teal">⏺</span>
            <span className="title">Progress</span>
          </div>
          <div className="overview">
            {plan.phases.map((ph, i) => {
              const ts = plan.tasks.filter((t) => t.phaseId === ph.id && t.status !== 'skipped');
              const dn = ts.filter((t) => t.status === 'done').length;
              const r = ts.length ? dn / ts.length : ph.status === 'done' ? 1 : 0;
              return [
                <span key={ph.id + 'n'} className={ph.status === 'active' ? 'teal' : ph.status === 'done' ? 'faint' : ''}>
                  {i + 1}. {ph.title}
                </span>,
                <span key={ph.id + 'b'} className="meter">{bar(r, 20)}</span>,
                <span key={ph.id + 'c'} className="dim">{dn}/{ts.length}</span>,
              ];
            })}
          </div>
        </section>
      )}

      <section className="block" aria-label="计划与任务">
        <div className="block-h">
          <span className="bullet">⏺</span>
          <span className="title">Update Todos</span>
          <span className="dim">· {plan.phases.length} 个阶段</span>
          <div className="actions">
            <button className="btn" onClick={() => act('新增阶段', (d) => ops.addPhase(d, ''))}>+ 阶段</button>
          </div>
        </div>
        {plan.phases.length === 0 && <div className="side-empty">还没有阶段。点击「+ 阶段」或输入 /phase &lt;标题&gt;</div>}
        {plan.phases.map((ph, i) => {
          const tasks = ordered.filter((t) => t.phaseId === ph.id);
          return (
            <div key={ph.id} className={`phase st-${ph.status}`}>
              <div className="phase-h tree">
                <span className="faint">{i === 0 ? '⎿' : ' '}</span>
                <span className="name">
                  <InlineEdit value={ph.title} ariaLabel="阶段标题" onSave={(v) => act('编辑阶段', (d) => ops.updatePhase(d, ph.id, { title: v }))} />
                </span>
                <span className={`tag ${ph.status}`}>{ph.status === 'active' ? '当前阶段' : ph.status === 'done' ? '已完成' : '待开始'}</span>
                <div className="actions" style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button className="btn ghost" title="修正阶段目标并记录原因" onClick={() => open({ type: 'revise', phaseId: ph.id })}>↻ 修正</button>
                  {ph.status !== 'done' ? (
                    <button className="btn ghost" onClick={() => act('完成阶段', (d) => ops.completePhase(d, ph.id))}>✓ 完成阶段</button>
                  ) : null}
                  {ph.status !== 'active' && (
                    <button className="btn ghost" onClick={() => act('切换阶段', (d) => ops.activatePhase(d, ph.id))}>设为当前</button>
                  )}
                  <button className="icon-btn" title="上移" onClick={() => act('移动阶段', (d) => ops.movePhase(d, ph.id, -1))}>↑</button>
                  <button className="icon-btn" title="下移" onClick={() => act('移动阶段', (d) => ops.movePhase(d, ph.id, 1))}>↓</button>
                  <button
                    className="icon-btn danger"
                    title="删除阶段"
                    onClick={() =>
                      tasks.length
                        ? open({
                            type: 'confirm',
                            title: `删除阶段「${ph.title}」？`,
                            message: `其中的 ${tasks.length} 个任务也会被删除。可以 Ctrl+Z 撤销。`,
                            confirmLabel: '删除',
                            danger: true,
                            onConfirm: () => act('删除阶段', (d) => ops.deletePhase(d, ph.id)),
                          })
                        : act('删除阶段', (d) => ops.deletePhase(d, ph.id))
                    }
                  >
                    ⌫
                  </button>
                </div>
              </div>
              <div className="phase-goal">
                <span className="lbl">阶段目标：</span>
                <InlineEdit value={ph.goal} placeholder="这个阶段结束时应该达到什么状态？" ariaLabel="阶段目标" onSave={(v) => act('编辑阶段目标', (d) => ops.updatePhase(d, ph.id, { goal: v }))} />
              </div>
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} num={ordered.indexOf(t) + 1} selected={selTaskId === t.id} onSelect={() => setSel(t.id)} />
              ))}
              {ph.status !== 'done' && <AddRow placeholder="+ 添加任务，回车确认" onAdd={(v) => act('添加任务', (d) => void ops.addTask(d, v, ph.id))} />}
            </div>
          );
        })}
      </section>

      <LogBlock ws={plan} title="Execution Log" />
    </div>
  );
}
