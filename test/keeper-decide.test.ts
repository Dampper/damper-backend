import { describe, expect, it } from 'vitest';
import { DEFAULTS, UNBOUNDED, decide, type AssetState } from '../src/keeper/decide.js';

const NOW = 1_800_000_000;
const P = 10_600_000n; // $1.06 at 7 decimals

const collateralPolicy = { upBpsPerHour: 500, downBpsPerHour: UNBOUNDED, windowSecs: 24 * 3600 };

const state = (over: Partial<AssetState> = {}): AssetState => ({
  asset: 'Stellar:CUSTRY',
  policy: collateralPolicy,
  anchor: { price: P, timestamp: NOW - 3600 },
  raw: P,
  quote: P,
  ...over,
});

describe('keeper decisions', () => {
  it('pokes when the anchor is old enough and nothing is wrong', () => {
    const d = decide(state(), NOW, undefined);
    expect(d.action.kind).toBe('poke');
    expect(d.alerts).toEqual([]);
    expect(d.suspiciousSince).toBeUndefined();
  });

  it('waits inside the contract minimum plus margin', () => {
    const young = state({ anchor: { price: P, timestamp: NOW - 320 } });
    expect(decide(young, NOW, undefined).action.kind).toBe('wait'); // 300 + 30 margin
    const ok = state({ anchor: { price: P, timestamp: NOW - 331 } });
    expect(decide(ok, NOW, undefined).action.kind).toBe('poke');
  });

  it('skips and flags an asset with no policy', () => {
    const d = decide(state({ policy: undefined }), NOW, undefined);
    expect(d.action.kind).toBe('skip');
    expect(d.alerts.map((a) => a.code)).toContain('no-policy');
  });

  it('flags a policy with no anchor as critical: the oracle returns nothing', () => {
    const d = decide(state({ anchor: undefined }), NOW, undefined);
    expect(d.action.kind).toBe('skip');
    expect(d.alerts[0]).toMatchObject({ severity: 'critical', code: 'unseeded' });
  });

  it('flags a missing quote as critical', () => {
    const d = decide(state({ quote: undefined, raw: undefined }), NOW, undefined);
    expect(d.action.kind).toBe('skip');
    expect(d.alerts[0]).toMatchObject({ severity: 'critical', code: 'no-quote' });
  });

  it('warns when the clamp is binding but the move is not extreme', () => {
    // upstreams +30%, pools read +4%: a real rally being rate-limited
    const d = decide(state({ raw: (P * 130n) / 100n, quote: (P * 104n) / 100n }), NOW, undefined);
    expect(d.action.kind).toBe('poke');
    expect(d.alerts.map((a) => a.code)).toEqual(['clamp-binding']);
  });

  it('ignores tiny raw/quote differences', () => {
    const d = decide(state({ raw: P + 1n }), NOW, undefined);
    expect(d.alerts).toEqual([]);
  });

  it('holds pokes when the raw price is far above the anchor (the YieldBlox shape)', () => {
    const pumped = state({ raw: 1_067_372_828n, quote: 11_000_000n });
    const d = decide(pumped, NOW, undefined);
    expect(d.action.kind).toBe('hold');
    expect(d.suspiciousSince).toBe(NOW);
    expect(d.alerts.map((a) => a.code)).toContain('suspicious-move');
  });

  it('keeps holding, remembering when the move started, until the hold expires', () => {
    const pumped = state({ raw: 1_067_372_828n, quote: 11_000_000n });
    const started = NOW - 3 * 3600;
    const mid = decide(pumped, NOW, started);
    expect(mid.action.kind).toBe('hold');
    expect(mid.suspiciousSince).toBe(started);

    const expired = decide(pumped, NOW, NOW - DEFAULTS.maxHoldSecs);
    expect(expired.action.kind).toBe('poke');
    expect(expired.alerts.map((a) => a.code)).toContain('hold-expired');
    expect(expired.suspiciousSince).toBe(NOW - DEFAULTS.maxHoldSecs);
  });

  it('clears the suspicion once the raw price comes back', () => {
    const d = decide(state(), NOW, NOW - 600);
    expect(d.suspiciousSince).toBeUndefined();
    expect(d.action.kind).toBe('poke');
  });

  it('does not treat a crash as suspicious when downward moves are unbounded', () => {
    const crash = state({ raw: P / 3n, quote: P / 3n });
    const d = decide(crash, NOW, undefined);
    expect(d.action.kind).toBe('poke');
    expect(d.alerts).toEqual([]);
  });

  it('treats a collapse as suspicious on a debt-side policy', () => {
    const debt = state({
      policy: { upBpsPerHour: UNBOUNDED, downBpsPerHour: 500, windowSecs: 24 * 3600 },
      raw: P / 3n,
      quote: (P * 95n) / 100n,
    });
    expect(decide(debt, NOW, undefined).action.kind).toBe('hold');
  });

  it('warns about an anchor that has not moved for over two windows', () => {
    const d = decide(state({ anchor: { price: P, timestamp: NOW - 3 * 24 * 3600 } }), NOW, undefined);
    expect(d.alerts.map((a) => a.code)).toContain('anchor-stale');
  });
});
