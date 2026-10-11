// Reproduction before regression tests: observations against unmodified production code.
import { isDeepStrictEqual } from 'node:util';
import { scenarios } from './scenarios';
import { T0 } from './harness';
import { ioScenarios } from './io-scenarios';

const originalNow = Date.now; const originalRandom = Math.random;
let tick = 0; let random = 0;
Date.now = () => T0 + tick++ * 100;
Math.random = () => (++random % 1_000_000) / 1_000_000;
try {
  for (const run of [...scenarios, ...ioScenarios]) {
    const evidence = await run();
    console.log(JSON.stringify({ ...evidence, reproduced: !isDeepStrictEqual(evidence.actual, evidence.expected) }));
  }
} finally { Date.now = originalNow; Math.random = originalRandom; }
