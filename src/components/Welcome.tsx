import type { Mode } from '../types';
import { useApp } from '../ctx';

export function Welcome({ mode, onDemo }: { mode: Mode; onDemo: () => void }) {
  const { open, state } = useApp();
  const empty = !state.plans.length && !state.goals.length;
  return (
    <div className="col">
      <div className="welcome">
        <div>
          <span className="accent">✻</span> <span className="bold">Welcome to AuTomeDo</span>
        </div>
        <div className="dim" style={{ marginTop: 6 }}>像编写 Agent 计划一样组织自己的工作。</div>
      </div>
      <div className="tips">
        <div className="dim">Tips for getting started:</div>
        <ol>
          <li>
            {mode === 'plan' ? '路径清楚？' : '路径还不清楚？'}直接在下方输入{mode === 'plan' ? '计划' : '目标'}标题并回车
            {state.plans.length + state.goals.length > 0 && <>，或按 <span className="kbd">o</span> 打开已有的</>}
          </li>
          <li>
            <span className="kbd">shift+tab</span> 在 <span className="teal">plan mode</span>（先想再做）和 <span className="violet">goal mode</span>（先干起来再想）间切换
          </li>
          <li>
            输入 <span className="kbd">/</span> 查看命令，<span className="kbd">?</span> 查看快捷键
          </li>
        </ol>
        <div className="row-btns">
          <button className="btn primary" onClick={() => open({ type: mode === 'plan' ? 'newPlan' : 'newGoal' })}>
            + 新建 {mode === 'plan' ? 'Plan' : 'Goal'}
          </button>
          {empty && <button className="btn" onClick={onDemo}>载入示例数据</button>}
        </div>
      </div>
    </div>
  );
}
