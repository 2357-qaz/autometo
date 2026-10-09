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

export function LogList({ ws, limit = 60 }: { ws: Workspace; limit?: number }) {
  const { act } = useApp();
  const rows = [...ws.log].reverse().slice(0, limit);
  return (
    <>
      <AddRow placeholder="# 写一条记录，回车确认" onAdd={(v) => act('记录', (d) => ops.addNote(d, v))} />
      <div className="log">
        {rows.map((l) => (
          <div key={l.id} className="log-row">
            <span className="faint">{fmtTime(l.at)}</span>
            <span className={`k ${l.kind}`}>{KIND[l.kind]}</span>
            <span className="pre">{l.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
