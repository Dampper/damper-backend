import { describe, expect, it } from 'vitest';
import { borrowableUsd, collateralSideExposure, tier, worst, type ReserveSnapshot } from '../src/score.js';

const reserve = (over: Partial<ReserveSnapshot>): ReserveSnapshot => ({
  asset: 'A',
  symbol: 'A',
  priceUsd: 1,
  collateralFactor: 0.9,
  liabilityFactor: 1.1,
  maxUtil: 0.9,
  supplied: 1000,
  borrowed: 100,
  enabled: true,
  ...over,
});

describe('exposure', () => {
  it('borrowable liquidity respects max utilization', () => {
    expect(borrowableUsd(reserve({ supplied: 1000, borrowed: 100, maxUtil: 0.9, priceUsd: 2 }))).toBe(1600);
  });

  it('is zero for disabled, unpriced, non-borrowable or fully used reserves', () => {
    expect(borrowableUsd(reserve({ enabled: false }))).toBe(0);
    expect(borrowableUsd(reserve({ priceUsd: undefined }))).toBe(0);
    expect(borrowableUsd(reserve({ liabilityFactor: 0 }))).toBe(0);
    expect(borrowableUsd(reserve({ borrowed: 950 }))).toBe(0);
  });

  it('collateral side counts every reserve except the manipulated one', () => {
    // YieldBlox, February 2026: inflated USTRY collateral, borrowed XLM and USDC
    const pool = [
      reserve({ asset: 'USTRY', supplied: 0, borrowed: 0 }),
      reserve({ asset: 'XLM', priceUsd: 0.16, supplied: 70_000_000, borrowed: 1_000_000, maxUtil: 0.95 }),
      reserve({ asset: 'USDC', priceUsd: 1, supplied: 1_200_000, borrowed: 100_000, maxUtil: 0.95 }),
    ];
    const exposure = collateralSideExposure(pool, 'USTRY');
    expect(exposure).toBeCloseTo((0.95 * 70e6 - 1e6) * 0.16 + (0.95 * 1.2e6 - 1e5), 0);
  });
});

describe('tiers', () => {
  it('a dead market with real exposure is critical regardless of book depth', () => {
    expect(tier(10_000_000, { costUsd: 5_000_000, volume24hUsd: 1, external: false })).toBe('critical');
  });

  it('scales with exposure relative to manipulation cost', () => {
    const m = (costUsd: number) => ({ costUsd, volume24hUsd: 1_000_000, external: false });
    expect(tier(1_000_000, m(50_000))).toBe('critical');
    expect(tier(100_000, m(50_000))).toBe('high');
    expect(tier(10_000, m(50_000))).toBe('medium');
    expect(tier(1_000, m(50_000))).toBe('low');
  });

  it('external feeds and zero exposure are not scored', () => {
    expect(tier(1e9, { costUsd: undefined, volume24hUsd: undefined, external: true })).toBe('external');
    expect(tier(0, { costUsd: 1, volume24hUsd: 1, external: false })).toBe('n/a');
  });

  it('worst picks the most severe tier', () => {
    expect(worst(['low', 'external', 'high', 'n/a'])).toBe('high');
    expect(worst([])).toBe('n/a');
  });
});
