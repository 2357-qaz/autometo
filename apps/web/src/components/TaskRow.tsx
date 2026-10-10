import { useRef, useState } from 'react';
import type { Task, TaskStatus } from '@automedo/core';
import { useApp } from '../ctx';
import { ops } from '@automedo/core';
import { InlineEdit } from './Inline';

export const GLYPH: Record<TaskStatus, string> = {
  pending: '☐',
  active: '◼',
  done: '☒',
  blocked: '✗',
  skipped: '⊘',
};

const SWIPE = 72; // px past which a swipe commits

export function TaskRow({ task, num, selected, onSelect, dim }: { task: Task; num: number; selected: boolean; onSelect: () => void; dim?: boolean }) {
  const { act, open } = useApp();
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);
  const done = task.status === 'done';
  const actions = {
    start: () => act('开始任务', (d) => ops.setTaskStatus(d, task.id, 'active')),
    done: () => act('完成任务', (d) => ops.setTaskStatus(d, task.id, 'done')),
    defer: () => act('延期', (d) => ops.deferTask(d, task.id)),
    block: () => act('标记阻塞', (d) => ops.setTaskStatus(d, task.id, 'blocked')),
    edit: () => open({ type: 'editTask', taskId: task.id }),
    remove: () => act('删除任务', (d) => ops.deleteTask(d, task.id)),
  };

  // Touch swipe: left = done, right = defer. Mouse never swipes.
  const onPointerDown = (e: React.PointerEvent) => {
    // Touch selects on click instead: revealing the action bar on pointerdown would shift the
    // bottom-anchored list under the finger, and the follow-up click would hit an action button.
    if (e.pointerType !== 'touch') return onSelect();
    if (done) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    const mx = e.clientX - g.x;
    const my = e.clientY - g.y;
    if (g.horizontal === null && Math.hypot(mx, my) > 8) {
      g.horizontal = Math.abs(mx) > Math.abs(my) * 1.3;
      if (g.horizontal) {
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone (e.g. lifted mid-gesture); keep tracking without capture */
        }
      }
    }
    if (g.horizontal) setDx(Math.max(-140, Math.min(140, mx)));
  };
  const endDrag = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    drag.current = null;
    if (dx <= -SWIPE) actions.done();
    else if (dx >= SWIPE) actions.defer();
    setDx(0);
  };
  const swipe = dx <= -SWIPE ? 'commit-done' : dx >= SWIPE ? 'commit-defer' : dx < 0 ? 'to-done' : dx > 0 ? 'to-defer' : '';

  return (
    <div className={`task-wrap ${swipe}`} data-swipe-hint={dx < 0 ? '✓ 完成' : dx > 0 ? '↷ 延期' : undefined}>
      <div
        className={`task st-${task.status} ${selected ? 'sel' : ''} ${dim ? 'later' : ''}`}
        data-task-id={task.id}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onPointerDown={onPointerDown}
        onClick={() => !selected && onSelect()}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <button
          className="box"
          title="切换状态：待办 → 进行中 → 完成（space）"
          aria-label={`切换状态（当前：${task.status}）`}
          onClick={() => act('切换任务状态', (d) => ops.cycleTask(d, task.id))}
        >
          {GLYPH[task.status]}
        </button>
        <div className="body">
          <InlineEdit className="label" value={task.title} ariaLabel="任务标题" onSave={(v) => act('编辑任务', (d) => ops.updateTask(d, task.id, { title: v }))} />
          {task.note && <span className="note"> — {task.note}</span>}
        </div>
        <div className="tools">
          <span className="faint num">#{num}</span>
          {task.status !== 'active' && !done && (
            <button className="icon-btn" title="开始 (s)" onClick={actions.start}>▶</button>
          )}
          {!done && (
            <button className="icon-btn" title="完成 (d)" onClick={actions.done}>✓</button>
          )}
          {!done && (
            <button className="icon-btn" title="延期到下一阶段" onClick={actions.defer}>↷</button>
          )}
          <button className="icon-btn" title="详情 / 备注 / 阶段 (e)" onClick={actions.edit}>✎</button>
          <button className="icon-btn danger" title="删除 (x)，可撤销" onClick={actions.remove}>⌫</button>
        </div>
      </div>
      {selected && (
        // Touch devices: tapping a task reveals labelled actions (no hover needed).
        <div className="task-actions" role="toolbar" aria-label={`#${num} 的操作`}>
          {task.status !== 'active' && !done && <button className="btn primary" onClick={actions.start}>▶ 开始</button>}
          {!done && <button className="btn" onClick={actions.done}>✓ 完成</button>}
          {!done && <button className="btn" onClick={actions.defer}>↷ 延期</button>}
          {!done && task.status !== 'blocked' && <button className="btn" onClick={actions.block}>✗ 阻塞</button>}
          {done && <button className="btn" onClick={() => act('重新打开', (d) => ops.setTaskStatus(d, task.id, 'pending'))}>↺ 重新打开</button>}
          <button className="btn" onClick={actions.edit}>✎ 编辑</button>
          <button className="btn danger" onClick={actions.remove}>⌫ 删除</button>
        </div>
      )}
    </div>
  );
}

/** Done tasks collapsed into one line, expandable. */
export function DoneLine({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  if (!count) return null;
  return (
    <button className="done-line" onClick={onToggle} aria-expanded={open}>
      <span className="green">☒</span> <span className="faint">已完成 {count} 项 {open ? '▾' : '▸'}</span>
    </button>
  );
}
