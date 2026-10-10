import { useApp } from '../ctx';
import { currentWs } from '@automedo/core';

export function Header() {
  const { state, open } = useApp();
  const ws = currentWs(state);
  const mode = state.ui.mode;
  const count = state.plans.length + state.goals.length;
  return (
    <header className="header">
      <span className="accent">✻</span>
      <span className="bold">AuTomeDo</span>
      <button className="ws-switch" onClick={() => open({ type: 'switch' })} title="切换 Plan / Goal（o 或 /switch）">
        <span className={mode === 'plan' ? 'teal' : 'violet'}>{mode === 'plan' ? '⏸' : '⏵⏵'}</span>
        <span className="t">{ws ? ws.title : mode === 'plan' ? '未选择 Plan' : '未选择 Goal'}</span>
        <span className="faint">▾{count > 1 ? ` ${count}` : ''}</span>
      </button>
    </header>
  );
}
