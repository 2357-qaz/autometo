import type { Mode } from '../types';
import { useApp } from '../ctx';
import { Mascot } from './Mascot';

export function Welcome({ mode, onDemo }: { mode: Mode; onDemo: () => void }) {
  const { open, state } = useApp();
  const empty = !state.plans.length && !state.goals.length;
  const hasAny = !empty;
  return (
    <div className="col">
      <div className="welcome">
        <Mascot px={7} />
        <div className="welcome-text">
          <div>
            <span className="accent">✻</span> <span className="bold">Welcome to AuTomeDo</span>
          </div>
          <div className="fg-2" style={{ marginTop: 6 }}>嗨，我是 Tomo，你的计划本。</div>
          <div className="dim">像编写 Agent 计划一样组织自己的工作：先写下要做的事，然后一件一件推进。</div>
        </div>
      </div>
      <div className="tips">
        <div className="dim">Tips for getting started:</div>
        <ol>
          <li>直接在下方输入{mode === 'plan' ? '计划' : '目标'}标题并回车，就能开始</li>
          <li>
            <span className="teal">Plan</span> 适合路径清楚的事（先想再做），<span className="violet">Goal</span> 适合还在摸索的事（先干起来再想）
          </li>
          <li>输入 / 可以看到所有命令</li>
        </ol>
        <div className="row-btns">
          <button className="btn primary" onClick={() => open({ type: mode === 'plan' ? 'newPlan' : 'newGoal' })}>
            + 新建 {mode === 'plan' ? 'Plan' : 'Goal'}
          </button>
          {hasAny && <button className="btn" onClick={() => open({ type: 'switch' })}>打开已有的</button>}
          {empty && <button className="btn" onClick={onDemo}>载入示例数据</button>}
        </div>
      </div>
    </div>
  );
}
