import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scenarios, type Evidence } from './scenarios';
import { ioScenarios } from './io-scenarios';
import { T0 } from './harness';

// Run setup OUTSIDE it.fails: infrastructure/setup failure must never masquerade
// as an expected product defect. Strict mode executes the exact same invariant.
const regression = process.env.AUTOMEDO_AUDIT_STRICT === '1' ? it : it.fails;
for (const run of [...scenarios, ...ioScenarios]) {
  describe(run.name, () => {
    let evidence: Evidence;
    beforeAll(async () => {
      let tick = 0; let random = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => T0 + tick++ * 100);
      vi.spyOn(Math, 'random').mockImplementation(() => (++random % 1_000_000) / 1_000_000);
      try { evidence = await run(); } finally { vi.restoreAllMocks(); }
    });
    afterAll(() => vi.restoreAllMocks());
    regression('preserves the required reliability invariant (KNOWN DEFECT)', () => {
      expect(evidence.actual, `${evidence.id}: ${JSON.stringify(evidence)}`).toEqual(evidence.expected);
    });
  });
}
