import { useState } from 'react';
import type { LogKind, Workspace } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';
import { fmtTime } from '../util';
import { AddRow } from './Inline';

const KIND: Record<LogKind, string> = {
  create: 'create',
  task: 'task',
  phase: 'phase',
  revise: 'revise',
  note: 'note',
  session: 'session',
  compact: 'compact',
  checkpoint: 'check',
};

export function LogBlock({ ws, title }: { ws: Workspace; title: string }) {
  const { act } = useApp();
  const [filter, setFilter] = useState<'all' | 'key'>('all');
  const rows = [...ws.log].reverse().filter((l) => filter === 'all' || ['revise', 'checkpoint', 'note', 'session', 'phase'].includes(l.kind));
  return (
    <section className="block" aria-label="日志">
      <div className="block-h">
        <span className="bullet green">⏺</span>
        <span className="title">{title}</span>
        <span className="dim">· {ws.log.length} 条</span>
        <div className="actions">
          <button className="btn ghost" aria-pressed={filter === 'all'} onClick={() => setFilter(filter === 'all' ? 'key' : 'all')}>
            {filter === 'all' ? '全部' : '仅关键'} ⇄
          </button>
        </div>
      </div>
      <AddRow placeholder="# 写一条记录（也可在命令行用 # 开头）" onAdd={(v) => act('记录', (d) => ops.addNote(d, v))} />
      <div className="log" style={{ marginTop: 6 }}>
        {rows.length === 0 && <div className="faint">暂无记录</div>}
        {rows.map((l) => (
          <div key={l.id} className="log-row">
            <span className="faint">{fmtTime(l.at)}</span>
            <span className={`k ${l.kind}`}>[{KIND[l.kind]}]</span>
            <span className="pre">{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
