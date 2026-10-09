import type { Mode } from '../types';
import { useApp } from '../ctx';

const LOGO = String.raw`
   ___       _____                    ___
  / _ |__ __/_  _/__  __ _  ___ ___  / _ \___
 / __ / // / / // _ \/  ' \/ -_) _ \/ // / _ \
/_/ |_\_,_/ /_/ \___/_/_/_/\__/\___/____/\___/`;

export function Welcome({ mode, onDemo }: { mode: Mode; onDemo: () => void }) {
  const { open, state, focusPrompt } = useApp();
  const empty = !state.plans.length && !state.goals.length;
  return (
    <div className="main-inner">
      <div className="welcome" style={mode === 'goal' ? { borderColor: 'var(--violet)' } : undefined}>
        <pre aria-hidden="true">{LOGO}</pre>
        <h2>
          <span className="accent">✻</span> 欢迎使用 AuTomeDo
        </h2>
        <div className="dim">像编写 Agent 计划一样组织自己的工作。随时打开，都能知道：我要做什么 · 我做到哪里 · 下一步怎么办。</div>
        <ul>
          <li>
            <span className="teal">⏸ Plan Mode</span> — 先想再做：写计划、划分阶段、执行任务、记录与修正。
          </li>
          <li>
            <span className="violet">⏵⏵ Goal Mode</span> — 先干起来再想：设目标、开始行动、定期 Checkpoint 找方向。
          </li>
          <li>
            <span className="accent">✻ HIE</span> — 选择今天的档位（Lite/Core/Deep）与强度，开专注 Session，管理每日 Token 预算。
          </li>
          <li>
            <span className="blue">◇ Compact / Resume</span> — 结束时留下快照，下次打开一键恢复上下文。
          </li>
        </ul>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {mode === 'plan' ? (
            <button className="btn primary" onClick={() => open({ type: 'newPlan' })}>+ 新建 Plan</button>
          ) : (
            <button className="btn primary" onClick={() => open({ type: 'newGoal' })}>+ 新建 Goal</button>
          )}
          <button className="btn" onClick={() => focusPrompt('/')}>输入命令 <span className="kbd">/</span></button>
          {empty && <button className="btn" onClick={onDemo}>载入示例数据</button>}
          <button className="btn ghost" onClick={() => open({ type: 'help' })}>快捷键 <span className="kbd">?</span></button>
        </div>
        <div className="disclaimer">提示：Shift+Tab 在 Plan / Goal 模式间切换。“模型”“Token”是交互隐喻，不是真实 AI 推理或生理测量。</div>
      </div>
    </div>
  );
}
