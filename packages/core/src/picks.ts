// Single-value choices (model tier, effort, fatigue): one definition shared by every
// client — the TUI shows it in place in the bottom bar, the web as a small picker.
import { EFFORT_ORDER, EFFORTS, FATIGUE_LABELS, fatigueMult, latestFatigue, TIER_ORDER, TIERS } from './hie';
import * as ops from './ops';
import type { AppState, Effort, Tier } from './types';

export type PickKind = 'tier' | 'effort' | 'fatigue';

export interface PickOption {
  value: string;
  label: string;
  hint: string;
}

export interface PickSpec {
  title: string;
  options: PickOption[];
  /** Index of the current value (fatigue not reported today → -1). */
  current: number;
  /** Apply the chosen value; returns the confirmation text. */
  apply: (d: AppState, value: string) => string;
  label: string;
}

export function pickSpec(what: PickKind, state: AppState): PickSpec {
  switch (what) {
    case 'tier':
      return {
        title: '模型档位',
        label: '切换档位',
        options: TIER_ORDER.map((t) => ({ value: t, label: TIERS[t].label, hint: `${TIERS[t].rate}/min · ${TIERS[t].hint}` })),
        current: TIER_ORDER.indexOf(state.hie.tier),
        apply: (d, v) => ops.setTier(d, v as Tier),
      };
    case 'effort':
      return {
        title: '推理强度',
        label: '切换强度',
        options: EFFORT_ORDER.map((e) => ({ value: e, label: e, hint: `×${EFFORTS[e].mult} · ${EFFORTS[e].hint}` })),
        current: EFFORT_ORDER.indexOf(state.hie.effort),
        apply: (d, v) => ops.setEffort(d, v as Effort),
      };
    case 'fatigue': {
      const f = latestFatigue(state);
      return {
        title: '疲劳自评',
        label: '疲劳自评',
        options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n), hint: `${FATIGUE_LABELS[n]} · token ×${fatigueMult(n)}` })),
        current: f ? f - 1 : -1,
        apply: (d, v) => ops.markFatigue(d, Number(v)),
      };
    }
  }
}
