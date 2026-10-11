import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scenarios, type Evidence } from './scenarios';
import { ioScenarios } from './io-scenarios';
import { T0 } from './harness';

// Run setup OUTSIDE it.fails: infrastructure/setup failure must never masquerade
// as an expected product defect. Strict mode executes the exact same invariant.
//
// FIXED lists the scenarios whose defect has been repaired: they run as ordinary
// regression tests. The rest stay `it.fails` (expected to fail) until fixed — a fix
// makes them "unexpectedly pass", which fails the run until they are moved here.
const FIXED = new Set<string>(['fileWriters', 'browserWriters', 'lostAcknowledgement', 'undoRemote', 'rollbackDuringConnect', 'serverRollback', 'staleConfirmation', 'inflightPending', 'versionCollision', 'flushRetry', 'cliSaveFailure', 'duplicateImport', 'reviseBaseline', 'orderCollision', 'poisonedShell']);
const strict = process.env.AUTOMEDO_AUDIT_STRICT === '1';
for (const run of [...scenarios, ...ioScenarios]) {
  const regression = strict || FIXED.has(run.name) ? it : it.fails;
  describe(run.name, () => {
    let evidence: Evidence;
    beforeAll(async () => {
      let tick = 0; let random = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => T0 + tick++ * 100);
      vi.spyOn(Math, 'random').mockImplementation(() => (++random % 1_000_000) / 1_000_000);
      try { evidence = await run(); } finally { vi.restoreAllMocks(); }
    });
    afterAll(() => vi.restoreAllMocks());
    regression(FIXED.has(run.name) ? 'preserves the required reliability invariant' : 'preserves the required reliability invariant (KNOWN DEFECT)', () => {
      expect(evidence.actual, `${evidence.id}: ${JSON.stringify(evidence)}`).toEqual(evidence.expected);
    });
  });
}
