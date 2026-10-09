import { useApp } from '../ctx';
import { activeSession, budgetLevel, FATIGUE_LABELS, latestFatigue, TIERS, tokensToday } from '../hie';
import { bar, fmtTokens } from '../util';

export function Topbar({ onToggleSide, onToggleMode, run }: { onToggleSide: () => void; onToggleMode: () => void; run: (s: string) => void }) {
  const { state, focusPrompt } = useApp();
  const used = tokensToday(state);
  const budget = state.settings.dailyBudget;
  const lvl = budgetLevel(used, budget);
  const fat = latestFatigue(state);
  const sess = activeSession(state);
  const mode = state.ui.mode;
  return (
    <header className="topbar">
      <button className="btn side-toggle" aria-label="打开列表" onClick={onToggleSide}>☰</button>
      <div className="brand">
        <span className="star">✻</span>
        <span>AuTomeDo</span>
        <small>v0</small>
      </div>
      <div className="mode-tabs" role="group" aria-label="工作模式（Shift+Tab 切换）">
        <button className="plan" aria-pressed={mode === 'plan'} onClick={() => mode !== 'plan' && onToggleMode()} title="Plan Mode：先想再做">
          ⏸ Plan
        </button>
        <button className="goal" aria-pressed={mode === 'goal'} onClick={() => mode !== 'goal' && onToggleMode()} title="Goal Mode：先干起来再想">
          ⏵⏵ Goal
        </button>
      </div>
      <div className="spacer" />
      <div className="hie-chip" aria-label="Human Inference Engine">
        <span className="dim">HIE</span>
        <button title={`模型档位：${TIERS[state.hie.tier].hint}（点击轮换，/model）`} onClick={() => run('/model')}>
          {TIERS[state.hie.tier].label}
        </button>
        <button title="推理强度（点击轮换，/effort）" onClick={() => run('/effort')}>
          {state.hie.effort}
        </button>
        <span className={`meter ${lvl}`} title={`今日已用 ${used.toLocaleString()} / ${budget.toLocaleString()}（/budget 修改）`}>
          {bar(used / budget, 12)}
        </span>
        <span className={lvl === 'ok' ? 'dim' : lvl === 'warn' ? 'yellow' : 'red'}>
          {fmtTokens(used)}/{fmtTokens(budget)}
        </span>
        <button title="疲劳自评 1–5（/fatigue）" onClick={() => focusPrompt('/fatigue ')}>
          {fat ? `疲劳 ${fat}/5 · ${FATIGUE_LABELS[fat]}` : '疲劳 –'}
        </button>
        <button className={sess ? '' : 'accent'} style={sess ? undefined : { borderColor: 'var(--accent)' }} onClick={() => run(sess ? '/end' : '/session')}>
          {sess ? '■ 结束 Session' : '▶ Session'}
        </button>
      </div>
    </header>
  );
}
