import type { Effort, Tier } from '../types';
import { TIERS } from '../hie';

const EFFORT_LEVEL: Record<Effort, number> = { low: 1, medium: 2, high: 3 };

/** Model tier as coloured text — no boxes, like a terminal. */
export function TierLabel({ tier }: { tier: Tier }) {
  return <span className={`tier tier-${tier}`}>{TIERS[tier].label}</span>;
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
