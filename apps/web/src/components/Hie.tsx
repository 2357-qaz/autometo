import type { Effort, Tier } from '@automedo/core';
import { TIERS } from '@automedo/core';

const EFFORT_LEVEL: Record<Effort, number> = { low: 1, medium: 2, high: 3 };

/** Model tier as coloured text — no boxes, like a terminal. Fable also shows its parallel lanes. */
export function TierLabel({ tier, lanes = 1 }: { tier: Tier; lanes?: number }) {
  return (
    <span className={`tier tier-${tier}`}>
      {TIERS[tier].label}
      {tier === 'fable' && lanes > 1 && <span className="lanes"> ×{lanes} 路</span>}
    </span>
  );
}

/** Effort as a 3-step bar whose colour heats up with intensity. */
export function EffortLabel({ effort }: { effort: Effort }) {
  return (
    <span className={`effort effort-${effort}`}>
      <span className="eg">{'▰'.repeat(EFFORT_LEVEL[effort])}</span>
      <span className="eg-off">{'▱'.repeat(3 - EFFORT_LEVEL[effort])}</span> {effort}
    </span>
  );
}
