import type { Task, TaskStatus } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';
import { InlineEdit } from './Inline';

export const GLYPH: Record<TaskStatus, string> = {
  pending: '☐',
  active: '◼',
  done: '☒',
  blocked: '✗',
  skipped: '⊘',
};

export function TaskRow({ task, num, selected, onSelect, dim }: { task: Task; num: number; selected: boolean; onSelect: () => void; dim?: boolean }) {
  const { act, open } = useApp();
  return (
    <div className={`task st-${task.status} ${selected ? 'sel' : ''} ${dim ? 'later' : ''}`} data-task-id={task.id} onMouseDown={onSelect}>
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
        {task.status !== 'active' && task.status !== 'done' && (
          <button className="icon-btn" title="开始 (s)" onClick={() => act('开始任务', (d) => ops.setTaskStatus(d, task.id, 'active'))}>▶</button>
        )}
        {task.status !== 'done' && (
          <button className="icon-btn" title="完成 (d)" onClick={() => act('完成任务', (d) => ops.setTaskStatus(d, task.id, 'done'))}>✓</button>
        )}
        <button className="icon-btn" title="详情 / 备注 / 阶段 (e)" onClick={() => open({ type: 'editTask', taskId: task.id })}>✎</button>
        <button className="icon-btn danger" title="删除 (x)，可撤销" onClick={() => act('删除任务', (d) => ops.deleteTask(d, task.id))}>⌫</button>
      </div>
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
