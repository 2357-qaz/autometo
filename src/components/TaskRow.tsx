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

export function TaskRow({ task, num, selected, onSelect }: { task: Task; num: number; selected: boolean; onSelect: () => void }) {
  const { act, open } = useApp();
  return (
    <div
      className={`task st-${task.status} ${selected ? 'sel' : ''}`}
      data-task-id={task.id}
      onMouseDown={onSelect}
      aria-current={selected || undefined}
    >
      <span className="num">{num}</span>
      <button
        className="box"
        title="切换状态：待办 → 进行中 → 完成"
        aria-label={`切换状态（当前：${task.status}）`}
        onClick={() => act('切换任务状态', (d) => ops.cycleTask(d, task.id))}
      >
        {GLYPH[task.status]}
      </button>
      <div>
        <InlineEdit className="label" value={task.title} ariaLabel="任务标题" onSave={(v) => act('编辑任务', (d) => ops.updateTask(d, task.id, { title: v }))} />
        {task.status === 'active' && <span className="dim"> ← 进行中</span>}
        {task.note && <div className="note">⎿ {task.note}</div>}
      </div>
      <div className="tools">
        {task.status !== 'active' && task.status !== 'done' && (
          <button className="icon-btn" title="开始 (s)" onClick={() => act('开始任务', (d) => ops.setTaskStatus(d, task.id, 'active'))}>▶</button>
        )}
        {task.status !== 'done' && (
          <button className="icon-btn" title="完成 (d)" onClick={() => act('完成任务', (d) => ops.setTaskStatus(d, task.id, 'done'))}>✓</button>
        )}
        {task.status !== 'blocked' && task.status !== 'done' && (
          <button className="icon-btn" title="阻塞 (b)" onClick={() => act('标记阻塞', (d) => ops.setTaskStatus(d, task.id, 'blocked'))}>✗</button>
        )}
        <button className="icon-btn" title="上移 (K)" onClick={() => act('移动任务', (d) => ops.moveTask(d, task.id, -1))}>↑</button>
        <button className="icon-btn" title="下移 (J)" onClick={() => act('移动任务', (d) => ops.moveTask(d, task.id, 1))}>↓</button>
        <button className="icon-btn" title="详情 (e)" onClick={() => open({ type: 'editTask', taskId: task.id })}>✎</button>
        <button className="icon-btn danger" title="删除 (x)，可撤销" onClick={() => act('删除任务', (d) => ops.deleteTask(d, task.id))}>⌫</button>
      </div>
    </div>
  );
}
