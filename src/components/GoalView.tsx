import { useState } from 'react';
import type { Goal } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';
import { activeSession } from '../hie';
import { bar, fmtAgo, fmtDate } from '../util';
import { Fold } from './Fold';
import { InlineEdit } from './Inline';
import { LogList } from './LogBlock';
import { DoneLine, TaskRow } from './TaskRow';

const VERDICT: Record<string, string> = { 'on-track': '顺利', drifting: '偏航', blocked: '受阻', pivot: '转向' };

export function GoalView({ goal, selTaskId, setSel }: { goal: Goal; selTaskId: string | null; setSel: (id: string) => void }) {
  const { act, open, run, state } = useApp();
  const sess = activeSession(state);
  const [showDone, setShowDone] = useState(false);
  const last = goal.checkpoints[goal.checkpoints.length - 1];
  const due = ops.checkpointDue(goal);
  const nextAt = ops.nextCheckpointAt(goal);
  const activeMove = goal.moves.find((m) => m.status === 'active');
  const openMoves = goal.moves.filter((m) => m.status !== 'done' && m.status !== 'skipped' && m.id !== activeMove?.id);
  const done = goal.moves.filter((m) => m.status === 'done' || m.status === 'skipped');
  const num = (id: string) => goal.moves.findIndex((m) => m.id === id) + 1;

  return (
    <div className="col">
      <div className="ws-head">
        <div className="ws-title">
          <InlineEdit value={goal.title} ariaLabel="目标标题" onSave={(v) => act('重命名', (d) => ops.updateGoal(d, goal.id, { title: v }))} />
          {goal.status !== 'active' && <span className="tag">{goal.status}</span>}
        </div>
        <div className="dim">
          {last ? (
            <>
              <span className="meter violet">{bar(last.progress / 100, 10)}</span> {last.progress}% · {VERDICT[last.verdict]} · {fmtAgo(last.at)}
            </>
          ) : (
            '还没有 Checkpoint——先干起来'
          )}
          {'　'}
          {due ? (
            <button className="link yellow" onClick={() => open({ type: 'checkpoint', goalId: goal.id })}>⚑ Checkpoint 到期</button>
          ) : (
            <span className="faint">下次 Checkpoint {fmtDate(nextAt).slice(5)}</span>
          )}
        </div>
      </div>

      <section className={`focus goal ${activeMove && selTaskId === activeMove.id ? 'sel' : ''}`} aria-label="下一步" data-task-id={activeMove?.id} onMouseDown={() => activeMove && setSel(activeMove.id)}>
        {activeMove ? (
          <>
            <div className="focus-main">
              <span className="accent">⏺</span>
              <span className="focus-title">{activeMove.title}</span>
            </div>
            {goal.nextAction && goal.nextAction !== activeMove.title && (
              <div className="focus-sub"><span className="faint">⎿</span><span className="dim">下一步方向：{goal.nextAction}</span></div>
            )}
            <div className="focus-actions">
              <button className="btn primary" onClick={() => act('完成行动', (d) => ops.setTaskStatus(d, activeMove.id, 'done'))}>✓ 完成</button>
              <button className="btn" onClick={() => run(sess ? '/end' : '/session')}>{sess ? '■ 结束专注' : '✻ 专注'}</button>
              <button className="btn ghost" onClick={() => open({ type: 'checkpoint', goalId: goal.id })}>⚑ Checkpoint</button>
            </div>
          </>
        ) : (
          <>
            <div className="focus-main">
              <span className="accent">⏺</span>
              <span className="dim">下一步：</span>
              <span className="focus-title">
                <InlineEdit value={goal.nextAction} placeholder="写一个 30 分钟内就能开始的动作" ariaLabel="下一步" onSave={(v) => act('设置下一步', (d) => ops.updateGoal(d, goal.id, { nextAction: v }))} />
              </span>
            </div>
            <div className="focus-actions">
              {goal.nextAction && (
                <button
                  className="btn primary"
                  onClick={() =>
                    act('开始行动', (d) => {
                      const t = ops.addTask(d, goal.nextAction);
                      return ops.setTaskStatus(d, t.id, 'active');
                    })
                  }
                >
                  ▶ 开始
                </button>
              )}
              <button className="btn" onClick={() => run(sess ? '/end' : '/session')}>{sess ? '■ 结束专注' : '✻ 专注'}</button>
              <button className={`btn ${due ? 'primary' : 'ghost'}`} onClick={() => open({ type: 'checkpoint', goalId: goal.id })}>⚑ Checkpoint</button>
            </div>
          </>
        )}
      </section>

      {(openMoves.length > 0 || done.length > 0) && (
        <section className="todos" aria-label="行动">
          {openMoves.map((m) => (
            <TaskRow key={m.id} task={m} num={num(m.id)} selected={selTaskId === m.id} onSelect={() => setSel(m.id)} />
          ))}
          <DoneLine count={done.length} open={showDone} onToggle={() => setShowDone(!showDone)} />
          {showDone && done.map((m) => <TaskRow key={m.id} task={m} num={num(m.id)} selected={selTaskId === m.id} onSelect={() => setSel(m.id)} />)}
        </section>
      )}

      <div className="folds">
        <Fold title="Checkpoints" meta={`${goal.checkpoints.length}`}>
          {goal.checkpoints.length === 0 && <div className="faint">还没有 Checkpoint。行动一段时间后回来检查结果。</div>}
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
        </Fold>
        <Fold title="目标详情">
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
        </Fold>
        <Fold title="日志" meta={`${goal.log.length}`}>
          <LogList ws={goal} />
        </Fold>
      </div>
    </div>
  );
}
