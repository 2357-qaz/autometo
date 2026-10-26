import { describe, expect, it } from 'vitest';
import { emptyState, generateReview, type Review } from '@automedo/core';
import { reviewLines } from '../src/format';

const minute = 60_000;

function investmentLine(tiers: Review['tiers'], overrun: number | null = 1.5) {
  const review = generateReview(emptyState(), 0, new Date('2026-10-23T12:00:00').getTime());
  review.tiers = tiers;
  review.totals.focusMs = Object.values(tiers).reduce((sum, ms) => sum + ms, 0);
  review.overrun = overrun;
  return reviewLines(review)
    .map((line) => line.map((segment) => segment.t).join(''))
    .find((line) => line.includes('投入方式'));
}

describe('weekly review investment display', () => {
  it('shows Fable-only focus time and the Session duration ratio', () => {
    const line = investmentLine({ haiku: 0, sonnet: 0, opus: 0, fable: 45 * minute });
    expect(line).toContain('Fable 45m');
    expect(line).toContain('Session 实际用时 / 计划 150%');
    for (const tier of ['Haiku', 'Sonnet', 'Opus']) expect(line).not.toContain(tier);
  });

  it('keeps all four tiers in order with their durations in a mixed week', () => {
    const line = investmentLine({ haiku: 10 * minute, sonnet: 20 * minute, opus: 30 * minute, fable: 40 * minute });
    expect(line).toContain('Haiku 10m · Sonnet 20m · Opus 30m · Fable 40m');
    expect(line).toContain('Session 实际用时 / 计划 150%');
  });

  it('keeps legacy-only weeks visible and omits an unavailable Session ratio', () => {
    const line = investmentLine({ haiku: 0, sonnet: 20 * minute, opus: 0, fable: 0 }, null);
    expect(line).toContain('Sonnet 20m');
    expect(line).not.toContain('Fable');
    expect(line).not.toContain('Session 实际用时 / 计划');
  });

  it('omits the investment section when every tier has zero focus time', () => {
    expect(investmentLine({ haiku: 0, sonnet: 0, opus: 0, fable: 0 }, null)).toBeUndefined();
  });
});
