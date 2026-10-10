import { useState } from 'react';
import type { Workspace } from '@automedo/core';
import { useApp } from '../ctx';
import { activeSession } from '@automedo/core';
import { ops } from '@automedo/core';
import { TaskRow } from './TaskRow';
import { Mascot } from './Mascot';

const MAX = 5;

/** Current task + what's next, pinned above the prompt (like Claude Code's todo list under the spinner). */
export function Dock({ ws, sel, setSel }: { ws: Workspace; sel: string | null; setSel: (id: string) => void }) {
  const { act, run, state } = useApp();
  const [more, setMore] = useState(false);
  const sess = activeSession(state);
  const ordered = ops.orderedTasks(ws);
  const num = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const active = ordered.find((t) => t.status === 'active');
  const phase = ws.kind === 'plan' ? ops.currentPhase(ws) : undefined;
  const open_ = ordered.filter((t) => t.status !== 'done' && t.status !== 'skipped' && t.id !== active?.id);
  // Current phase first, later phases after.
  const now = phase ? open_.filter((t) => t.phaseId === phase.id) : open_;
  const later = phase ? open_.filter((t) => t.phaseId !== phase.id) : [];
  const list = [...now, ...later];
  const shown = more ? list : list.slice(0, MAX);
  const doneN = ordered.filter((t) => t.status === 'done').length;
  const nextT = list.find((t) => t.status === 'pending');

  const head = active ? (
    <div className={`dock-active ${sel === active.id ? 'sel' : ''}`} data-task-id={active.id} onMouseDown={() => setSel(active.id)}>
      <span className="accent">◼</span>
      <span className="title">{active.title}</span>
      <span className="dock-btns">
        <button className="btn primary" onClick={() => run('/next')}>✓ 完成{nextT ? '并继续' : ''}</button>
        {!sess && <button className="btn" onClick={() => run('/session')}>✻ 专注</button>}
        <button className="btn ghost" title="延期到下一阶段" onClick={() => run('/defer')}>↷</button>
        <button className="btn ghost" title="卡住了" onClick={() => act('标记阻塞', (d) => ops.setTaskStatus(d, active.id, 'blocked'))}>✗</button>
      </span>
    </div>
  ) : ws.kind === 'goal' && !list.length ? (
    <div className="dock-active">
      <span className="accent">⏺</span>
      <span className="dim">下一步：</span>
      <span className="title">{ws.nextAction || <span className="faint">写一个 30 分钟内能开始的动作（/nextaction）</span>}</span>
      {ws.nextAction && (
        <span className="dock-btns">
          <button className="btn primary" onClick={() => act('开始行动', (d) => ops.setTaskStatus(d, ops.addTask(d, ws.nextAction).id, 'active'))}>▶ 开始</button>
        </span>
      )}
    </div>
  ) : nextT ? (
    <div className="dock-active idle">
      <span className="faint">◇</span>
      <span className="dim">没有进行中的任务 · 下一个：</span>
      <span className="title">{nextT.title}</span>
      <span className="dock-btns">
        <button className="btn primary" onClick={() => act('开始任务', (d) => ops.setTaskStatus(d, nextT.id, 'active'))}>▶ 开始</button>
      </span>
    </div>
  ) : ordered.length ? (
    <div className="dock-active idle">
      <Mascot px={2} title="Tomo：全部完成！" />
      <span className="green">✓</span>
      <span>全部完成</span>
      <span className="dock-btns">
        <button className="btn" onClick={() => run('/compact')}>/compact 收尾</button>
      </span>
    </div>
  ) : (
    <div className="dock-active idle">
      <span className="faint">◇</span>
      <span className="dim">还没有任务——在下方输入一件要做的事</span>
    </div>
  );

  return (
    <div className="dock" aria-label="当前任务与待办">
      <span className="elbow">⎿</span>
      <div className="dock-list">
        {head}
        {shown.map((t, i) => (
          <div key={t.id}>
            {phase && later.length > 0 && t.id === later[0].id && <div className="todo-sep faint">之后的阶段</div>}
            <TaskRow task={t} num={num(t.id)} dim={later.includes(t)} selected={sel === t.id} onSelect={() => setSel(t.id)} />
            {i === shown.length - 1 && null}
          </div>
        ))}
        {(list.length > MAX || doneN > 0) && (
          <div className="dock-foot faint">
            {list.length > MAX && (
              <button className="link faint" onClick={() => setMore(!more)}>{more ? '收起' : `… 还有 ${list.length - MAX} 项`}</button>
            )}
            {doneN > 0 && <span><span className="green">☒</span> {doneN} 已完成</span>}
          </div>
        )}
      </div>
    </div>
  );
}
