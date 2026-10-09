import type { Goal } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';
import { bar, fmtAgo, fmtDate } from '../util';
import { AddRow, InlineEdit } from './Inline';
import { LogBlock } from './LogBlock';
import { TaskRow } from './TaskRow';

const VERDICT: Record<string, string> = { 'on-track': '顺利', drifting: '偏航', blocked: '受阻', pivot: '转向' };

export function GoalView({ goal, selTaskId, setSel }: { goal: Goal; selTaskId: string | null; setSel: (id: string) => void }) {
  const { act, open } = useApp();
  const last = goal.checkpoints[goal.checkpoints.length - 1];
  const due = ops.checkpointDue(goal);
  const nextAt = ops.nextCheckpointAt(goal);
  const activeMove = goal.moves.find((m) => m.status === 'active');

  return (
    <div className="main-inner">
      <section className="hero" aria-label="目标概览" style={{ borderColor: 'var(--violet)' }}>
        <h1>
          <span className="violet">⏵⏵</span>
          <InlineEdit value={goal.title} ariaLabel="目标标题" onSave={(v) => act('重命名', (d) => ops.updateGoal(d, goal.id, { title: v }))} />
          <span className={`tag ${goal.status === 'active' ? 'violet' : goal.status === 'done' ? 'done' : ''}`}>{goal.status}</span>
          {due && <span className="tag due">⚑ Checkpoint 到期</span>}
        </h1>
        <div className="sub">
          为什么：<InlineEdit value={goal.why} placeholder="这个目标为什么重要？" ariaLabel="为什么" onSave={(v) => act('编辑目标', (d) => ops.updateGoal(d, goal.id, { why: v }))} />
        </div>
        <div className="sub">
          完成标准：<InlineEdit value={goal.doneWhen} placeholder="怎样算达成？可以先模糊" ariaLabel="完成标准" onSave={(v) => act('编辑目标', (d) => ops.updateGoal(d, goal.id, { doneWhen: v }))} />
          <span className="faint">　·　每 </span>
          <InlineEdit value={String(goal.cadenceDays)} ariaLabel="Checkpoint 周期（天）" onSave={(v) => act('设置周期', (d) => ops.updateGoal(d, goal.id, { cadenceDays: Number(v) }))} />
          <span className="faint"> 天 Checkpoint 一次</span>
        </div>
        <div className="qa">
          <div>
            <div className="q">我要做什么</div>
            <div className="a">{goal.doneWhen || goal.title}</div>
          </div>
          <div>
            <div className="q">我做到哪里</div>
            <div className="a">
              {last ? (
                <>
                  <span className="meter violet">{bar(last.progress / 100, 10)}</span> {last.progress}%
                  <div className="dim">{VERDICT[last.verdict]} · {fmtAgo(last.at)}</div>
                </>
              ) : (
                <span className="faint">还没有 Checkpoint——先干起来</span>
              )}
              {activeMove && <div className="accent">◼ {activeMove.title}</div>}
            </div>
          </div>
          <div>
            <div className="q">下一步怎么办</div>
            <div className="a">
              <InlineEdit value={goal.nextAction} placeholder="写一个 30 分钟内就能开始的动作" ariaLabel="下一步" onSave={(v) => act('设置下一步', (d) => ops.updateGoal(d, goal.id, { nextAction: v }))} />
            </div>
          </div>
        </div>
      </section>

      <div className={`banner ${due ? 'advice' : ''}`} role="status">
        <span className={due ? 'yellow' : 'violet'}>{due ? '⚑' : '◇'}</span>
        <div className="grow">
          {due ? (
            <>Checkpoint 到期了（应于 {fmtDate(nextAt)}）。停下来看看：做了什么、学到什么、下一步往哪走。</>
          ) : (
            <>下次 Checkpoint：{fmtDate(nextAt)} <span className="dim">（也可以随时提前做）</span></>
          )}
        </div>
        <button className={`btn ${due ? 'primary' : ''}`} onClick={() => open({ type: 'checkpoint', goalId: goal.id })}>
          ⚑ Checkpoint
        </button>
      </div>

      <section className="block" aria-label="行动">
        <div className="block-h">
          <span className="bullet violet">⏺</span>
          <span className="title">Moves</span>
          <span className="dim">· 先动起来的行动，不必完整</span>
        </div>
        <div className="tree">
          {goal.moves.length === 0 && <div className="side-empty">还没有行动。直接在下方或命令行输入文字即可添加。</div>}
        </div>
        {goal.moves.map((m, i) => (
          <TaskRow key={m.id} task={m} num={i + 1} selected={selTaskId === m.id} onSelect={() => setSel(m.id)} />
        ))}
        <AddRow placeholder="+ 添加行动，回车确认" onAdd={(v) => act('添加行动', (d) => void ops.addTask(d, v))} />
      </section>

      <section className="block" aria-label="Checkpoint 历史">
        <div className="block-h">
          <span className="bullet violet">⏺</span>
          <span className="title">Checkpoints</span>
          <span className="dim">· {goal.checkpoints.length} 次</span>
        </div>
        {goal.checkpoints.length === 0 && <div className="side-empty">还没有 Checkpoint。行动一段时间后回来检查结果。</div>}
        {[...goal.checkpoints].reverse().map((c, i) => (
          <div key={c.id} className={`cp ${c.verdict}`}>
            <div>
              <span className="bold">#{goal.checkpoints.length - i}</span> <span className="dim">{fmtDate(c.at)}</span>{"　"}
              <span className="meter violet">{bar(c.progress / 100, 16)}</span> {c.progress}%　<span className="tag">{VERDICT[c.verdict]}</span>
            </div>
            <dl>
              {c.did && (<><dt>做了</dt><dd>{c.did}</dd></>)}
              {c.learned && (<><dt>学到</dt><dd>{c.learned}</dd></>)}
              {c.next && (<><dt>下一步</dt><dd>{c.next}</dd></>)}
            </dl>
          </div>
        ))}
      </section>

      <LogBlock ws={goal} title="Goal Log" />
    </div>
  );
}
