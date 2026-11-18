import { describe, expect, it } from 'vitest';
import { depth, type OrderBook } from '../src/market.js';
import {
  UNLIMITED,
  buildEvidence,
  describeAmount,
  gateStatus,
  isFresh,
  shouldPublish,
  toFixed,
  uneconomic,
  type GateConfig,
  type PublishedEvidence,
} from '../src/keeper/evidence.js';
import { decide, UNBOUNDED, type AssetState } from '../src/keeper/decide.js';

const D = 7;
const usd = (n: number) => BigInt(n) * 10_000_000n;

// The USTRY/USDC book read from Horizon on 2026-11-17: a market maker around $1.08 and one
// stale offer from the night of the exploit still resting at $106.74.
const ustry: OrderBook = {
  asks: [
    { price: 1.0809492, amount: 4601.92 },
    { price: 1.0812084, amount: 47765.66 },
    { price: 1.0822353, amount: 195609.01 },
    { price: 106.7372828, amount: 1.1684309 },
  ],
  bids: [
    { price: 1.080409, amount: 20.74 },
    { price: 1.0804088, amount: 4489.81 },
    { price: 1.0801277, amount: 52408.55 },
    { price: 1.0791014, amount: 215616.37 },
  ],
};

const gate: GateConfig = { tightUpBpsPerHour: 50, tightDownBpsPerHour: 50, minCostRatioBps: 20_000, maxEvidenceAge: 3600 };

describe('toFixed', () => {
  it('rounds dollars to the oracle decimals and never goes negative', () => {
    expect(toFixed(1_200, D)).toBe(12_000_000_000n);
    expect(toFixed(0.00000004, D)).toBe(0n);
    expect(toFixed(-5, D)).toBe(0n);
    expect(toFixed(NaN, D)).toBe(0n);
    expect(toFixed(Infinity, D)).toBe(0n);
  });
});

describe('buildEvidence', () => {
  it('uses the order-book depth for cost and the given exposure', () => {
    const e = buildEvidence({ depth: depth(ustry), external: false, upExposureUsd: 10_800_000, downExposureUsd: 600_000, decimals: D })!;
    expect(e.upCost).toBeGreaterThan(usd(260_000));
    expect(e.upCost).toBeLessThan(usd(270_000));
    expect(e.upExposure).toBe(usd(10_800_000));
    expect(e.downExposure).toBe(usd(600_000));
    expect(e.downCost).toBeGreaterThan(0n);
  });

  it('says nothing when there is no market to read (the oracle then uses its tight rate)', () => {
    expect(buildEvidence({ depth: undefined, external: false, upExposureUsd: 1, downExposureUsd: 1, decimals: D })).toBeUndefined();
    expect(buildEvidence({ depth: depth({ asks: [], bids: [] }), external: false, upExposureUsd: 1, downExposureUsd: 1, decimals: D })).toBeUndefined();
  });

  it('never publishes a zero cost, which the contract rejects: an empty side of the book is a free move', () => {
    const noAsks = depth({ asks: [], bids: ustry.bids });
    const e = buildEvidence({ depth: noAsks, external: false, upExposureUsd: 5, downExposureUsd: 5, decimals: D })!;
    expect(e.upCost).toBe(1n);
  });

  it('marks a price that trading cannot move as unlimited cost', () => {
    const e = buildEvidence({ depth: undefined, external: true, upExposureUsd: 9, downExposureUsd: 9, decimals: D })!;
    expect(e.upCost).toBe(UNLIMITED);
    expect(e.downCost).toBe(UNLIMITED);
  });
});

// The same cases as the contract's Rust tests (gate_math): the keeper must describe what the
// oracle will actually do.
describe('uneconomic (mirrors the contract)', () => {
  it('needs the cost to clear the ratio', () => {
    expect(uneconomic(200n, 100n, 20_000)).toBe(true);
    expect(uneconomic(199n, 100n, 20_000)).toBe(false);
    expect(uneconomic(50n, 100n, 5_000)).toBe(true);
  });
  it('treats nothing to take, and untradeable prices, as uneconomic', () => {
    expect(uneconomic(1n, 0n, 20_000)).toBe(true);
    expect(uneconomic(1n, -5n, 20_000)).toBe(true);
    expect(uneconomic(UNLIMITED, (1n << 127n) - 1n, 20_000)).toBe(true);
  });
  it('does not overflow on huge amounts (bigint)', () => {
    expect(uneconomic(1_000n, (1n << 127n) - 1n, 20_000)).toBe(false);
  });
});

describe('gateStatus (mirrors effective_policy)', () => {
  const NOW = 1_000_000;
  const ev = (over: Partial<PublishedEvidence> = {}): PublishedEvidence => ({
    upCost: 1_000n, upExposure: 100n, downCost: 100n, downExposure: 1_000n, timestamp: NOW - 10, ...over,
  });

  it('judges each direction on its own', () => {
    expect(gateStatus(gate, ev(), NOW)).toEqual({ fresh: true, upKeepsPolicyRate: true, downKeepsPolicyRate: false });
  });
  it('treats missing, stale and future evidence as no evidence', () => {
    for (const e of [undefined, ev({ timestamp: NOW - 3_601 }), ev({ timestamp: NOW + 1 })]) {
      expect(gateStatus(gate, e, NOW)).toEqual({ fresh: false, upKeepsPolicyRate: false, downKeepsPolicyRate: false });
    }
    expect(isFresh(NOW - 3_600, NOW, 3_600)).toBe(true);
    expect(isFresh(NOW - 3_601, NOW, 3_600)).toBe(false);
  });
});

describe('shouldPublish', () => {
  const NOW = 1_000_000;
  const at = (ts: number): PublishedEvidence => ({ upCost: 1n, upExposure: 1n, downCost: 1n, downExposure: 1n, timestamp: ts });
  it('publishes when there is none, when it is stale, and once a third of its life is used', () => {
    expect(shouldPublish(gate, undefined, NOW)).toBe(true);
    expect(shouldPublish(gate, at(NOW - 5_000), NOW)).toBe(true);
    expect(shouldPublish(gate, at(NOW - 1_200), NOW)).toBe(true);
    expect(shouldPublish(gate, at(NOW - 1_199), NOW)).toBe(false);
  });
});

describe('describeAmount', () => {
  it('prints amounts and the unmovable sentinel', () => {
    expect(describeAmount(usd(1_200), D)).toBe('$1.2k');
    expect(describeAmount(usd(10_800_000), D)).toBe('$10.80M');
    expect(describeAmount(usd(40), D)).toBe('$40');
    expect(describeAmount(UNLIMITED, D)).toBe('unmovable');
  });
});

describe('gate alerts in keeper decisions', () => {
  const NOW = 1_800_000_000;
  const P = 10_600_000n;
  const state = (over: Partial<AssetState> = {}): AssetState => ({
    asset: 'Stellar:CUSTRY',
    policy: { upBpsPerHour: 500, downBpsPerHour: UNBOUNDED, windowSecs: 86_400 },
    anchor: { price: P, timestamp: NOW - 3_600 },
    raw: P,
    quote: P,
    decimals: D,
    gate,
    ...over,
  });
  const codes = (s: AssetState) => decide(s, NOW, undefined).alerts.map((a) => a.code);

  it('is silent for an asset with no gate', () => {
    expect(codes(state({ gate: undefined }))).toEqual([]);
  });

  it('warns that the oracle is on its tight rate when there is no evidence', () => {
    expect(codes(state())).toEqual(['evidence-stale']);
  });

  it('warns when an attack looks economic, naming the tight rate', () => {
    const thin: PublishedEvidence = { upCost: usd(1_200), upExposure: usd(10_800_000), downCost: usd(1_200), downExposure: usd(10_800_000), timestamp: NOW - 60 };
    const d = decide(state({ evidence: thin }), NOW, undefined);
    expect(d.alerts.map((a) => a.code)).toEqual(['gate-tight']);
    expect(d.alerts[0]!.message).toMatch(/\$1\.2k against \$10\.80M/);
    expect(d.alerts[0]!.message).toMatch(/50 bps\/h/);
  });

  it('says nothing when the market is deep, and ignores a direction the policy leaves unbounded', () => {
    const deep: PublishedEvidence = { upCost: usd(50_000_000), upExposure: usd(10_800_000), downCost: usd(1), downExposure: usd(10_800_000), timestamp: NOW - 60 };
    // down is economic but the collateral policy leaves drops unbounded, so there is nothing to tighten
    expect(codes(state({ evidence: deep }))).toEqual([]);
  });
});
