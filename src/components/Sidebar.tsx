import type { Goal, Plan } from '../types';
import { useApp } from '../ctx';
import * as ops from '../ops';

const ORDER = { active: 0, paused: 1, done: 2, archived: 3 } as const;
const sortWs = <T extends Plan | Goal>(a: T[]) => [...a].sort((x, y) => ORDER[x.status] - ORDER[y.status] || y.updatedAt - x.updatedAt);

export function Sidebar({ open, onPick }: { open: boolean; onPick: () => void }) {
  const { state, store, open: openDialog, run } = useApp();
  const pick = (id: string) => {
    store.mutate(null, (d) => ops.selectWs(d, id));
    onPick();
  };
  const cur = state.ui.mode === 'plan' ? state.ui.activePlanId : state.ui.activeGoalId;
  return (
    <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Plan 与 Goal 列表">
      <div className="side-h">
        <span className="teal">⏸ Plans</span>
        <button title="新建 Plan" aria-label="新建 Plan" onClick={() => openDialog({ type: 'newPlan' })}>+</button>
      </div>
      {state.plans.length === 0 && <div className="side-empty">暂无计划</div>}
      {sortWs(state.plans).map((p) => {
        const ts = p.tasks.filter((t) => t.status !== 'skipped');
        const dn = ts.filter((t) => t.status === 'done').length;
        const blocked = p.tasks.some((t) => t.status === 'blocked');
        return (
          <button key={p.id} className={`ws-item ${p.status !== 'active' ? 'muted' : ''}`} aria-current={cur === p.id && state.ui.mode === 'plan'} onClick={() => pick(p.id)}>
            <span className={p.status === 'done' ? 'green' : p.status === 'active' ? 'teal' : 'faint'}>{p.status === 'done' ? '✓' : p.status === 'active' ? '◆' : '◇'}</span>
            <span className="t">{p.title}</span>
            <span className="meta">
              {blocked && <span className="red">✗ </span>}
              {dn}/{ts.length}
            </span>
          </button>
        );
      })}
      <div className="side-h" style={{ marginTop: 14 }}>
        <span className="violet">⏵⏵ Goals</span>
        <button title="新建 Goal" aria-label="新建 Goal" onClick={() => openDialog({ type: 'newGoal' })}>+</button>
      </div>
      {state.goals.length === 0 && <div className="side-empty">暂无目标</div>}
      {sortWs(state.goals).map((g) => {
        const last = g.checkpoints[g.checkpoints.length - 1];
        const due = ops.checkpointDue(g);
        return (
          <button key={g.id} className={`ws-item ${g.status !== 'active' ? 'muted' : ''}`} aria-current={cur === g.id && state.ui.mode === 'goal'} onClick={() => pick(g.id)}>
            <span className={g.status === 'done' ? 'green' : g.status === 'active' ? 'violet' : 'faint'}>{g.status === 'done' ? '✓' : '◎'}</span>
            <span className="t">{g.title}</span>
            <span className="meta">{due ? <span className="yellow">⚑</span> : last ? `${last.progress}%` : '–'}</span>
          </button>
        );
      })}
      <div className="side-h" style={{ marginTop: 18 }}>
        <span>Data</span>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 8px', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => run('/export')}>导出</button>
        <button className="btn" onClick={() => run('/import')}>导入</button>
        <button className="btn" onClick={() => openDialog({ type: 'help' })}>帮助 ?</button>
      </div>
      <div className="side-empty" style={{ paddingLeft: 8, marginTop: 8 }}>数据仅保存在本浏览器。</div>
    </nav>
  );
}
