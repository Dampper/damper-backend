import { describe, expect, it } from 'vitest';
import { assetStatus, buildStatusReport } from '../src/keeper/status.js';
import type { AssetState } from '../src/keeper/decide.js';

const BASE: AssetState = {
  asset: 'Stellar:CABC',
  policy: { upBpsPerHour: 1500, downBpsPerHour: 4_294_967_295, windowSecs: 86400 },
  anchor: { price: 10_600_000n, timestamp: 1_800_000_000 },
  raw: 10_674_000_000n,
  quote: 10_605_300n,
  decimals: 7,
};

describe('assetStatus', () => {
  it('turns every bigint into a decimal string, exactly', () => {
    const s = assetStatus(BASE, []);
    expect(s.anchor).toEqual({ price: '10600000', timestamp: 1_800_000_000 });
    expect(s.raw).toBe('10674000000');
    expect(s.quote).toBe('10605300');
    // large enough that Number() would have lost precision, to prove the string path is used
    const huge: AssetState = { ...BASE, raw: 123_456_789_012_345_678_901_234_567_890n };
    expect(assetStatus(huge, []).raw).toBe('123456789012345678901234567890');
  });

  it('carries undefined through for an asset the oracle has no opinion on yet', () => {
    const s = assetStatus({ asset: 'Stellar:CNEW', policy: undefined, anchor: undefined, raw: undefined, quote: undefined }, []);
    expect(s).toMatchObject({ anchor: undefined, raw: undefined, quote: undefined, policy: undefined, gate: undefined, evidence: undefined });
  });

  it('carries the gate, the effective policy and the evidence through unchanged except for bigints', () => {
    const s = assetStatus(
      {
        ...BASE,
        effectivePolicy: { upBpsPerHour: 150, downBpsPerHour: 4_294_967_295, windowSecs: 86400 },
        gate: { tightUpBpsPerHour: 150, tightDownBpsPerHour: 4_294_967_295, minCostRatioBps: 100_000, maxEvidenceAge: 3600 },
        evidence: { upCost: 4_035_000_000n, upExposure: 500_000_000_000n, downCost: 3_025_000_000n, downExposure: 500_000_000_000n, timestamp: 1_800_000_050 },
      },
      [],
    );
    expect(s.effectivePolicy).toEqual({ upBpsPerHour: 150, downBpsPerHour: 4_294_967_295, windowSecs: 86400 });
    expect(s.gate?.minCostRatioBps).toBe(100_000);
    expect(s.evidence).toEqual({ upCost: '4035000000', upExposure: '500000000000', downCost: '3025000000', downExposure: '500000000000', timestamp: 1_800_000_050 });
  });

  it('carries this pass’s alerts through unchanged', () => {
    const alerts = [{ severity: 'warn' as const, code: 'gate-tight', message: 'x' }];
    expect(assetStatus(BASE, alerts).alerts).toBe(alerts);
  });

  it('round-trips through JSON.stringify/parse with no precision loss', () => {
    const s = assetStatus({ ...BASE, raw: 123_456_789_012_345_678_901_234_567_890n }, []);
    const back = JSON.parse(JSON.stringify(s));
    expect(back.raw).toBe('123456789012345678901234567890');
  });
});

describe('buildStatusReport', () => {
  it('wraps the assets with when, which network and which oracle', () => {
    const r = buildStatusReport('testnet', 'CORACLE', [assetStatus(BASE, [])], 1_800_000_100);
    expect(r).toMatchObject({ at: 1_800_000_100, network: 'testnet', oracle: 'CORACLE' });
    expect(r.assets).toHaveLength(1);
  });
});
