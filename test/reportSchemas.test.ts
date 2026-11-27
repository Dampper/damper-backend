import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateAgainstSchema, type JsonSchema } from '../src/jsonSchema.js';
import type { ScanReport } from '../src/scan.js';
import type { StatusReport } from '../src/keeper/status.js';

const latestSchema = JSON.parse(readFileSync('schemas/latest.schema.json', 'utf8')) as JsonSchema;
const statusSchema = JSON.parse(readFileSync('schemas/oracle-status.schema.json', 'utf8')) as JsonSchema;

/** Drops every key whose value is `undefined`, the way JSON.stringify (and so every real report) does. */
function asPublished<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('schemas/latest.schema.json', () => {
  it('accepts a full ScanReport, including an optional priceUsd/market and lower bounds', () => {
    const report: ScanReport = {
      scannedAt: '2026-11-18T12:00:00.000Z',
      ledger: 123_456,
      pools: [
        {
          id: 'CPOOL',
          name: 'YieldBlox',
          status: 'active',
          borrowingOpen: true,
          oracle: 'CORACLE',
          supplyUsd: 1_000_000,
          borrowedUsd: 400_000,
          tier: 'medium',
          reserves: [
            {
              asset: 'CUSTRY',
              symbol: 'USTRY',
              priceUsd: 1.08,
              collateralFactor: 0.8,
              liabilityFactor: 1.1,
              maxUtil: 0.9,
              supplied: 100_000,
              borrowed: 40_000,
              enabled: true,
              source: {
                poolOracle: 'CORACLE',
                upstream: 'CORACLE',
                upstreamKind: 'reflector-dex',
                upstreamAsset: ['Stellar', 'CUSTRY'],
                maxDevPct: 1,
                resolutionSec: 300,
                maxAgeSec: 600,
                isBaseAsset: false,
              },
              market: {
                mid: 1.08,
                up2x: 50_000,
                up10x: 200_000,
                up100x: 900_000,
                down2x: 60_000,
                down10x: 250_000,
                upIsLowerBound: true,
                downIsLowerBound: false,
                volume24hUsd: 10_000,
              },
              collateralSide: { exposureUsd: 300_000, costUsd: 200_000, tier: 'medium' },
              debtSide: { exposureUsd: 40_000, costUsd: 250_000, tier: 'low' },
              notes: ['max_dev 1% vs the previous round only (300s); a price held for two rounds passes'],
            },
          ],
        },
      ],
      errors: [{ pool: 'CBROKEN', error: 'could not load pool' }],
    };

    expect(validateAgainstSchema(latestSchema, asPublished(report))).toEqual([]);
  });

  it('accepts a reserve with no priceUsd, no market, and an empty book (market.mid absent)', () => {
    const report: ScanReport = {
      scannedAt: '2026-11-18T12:00:00.000Z',
      ledger: 1,
      pools: [
        {
          id: 'CPOOL',
          name: 'Fixed',
          status: 'on ice',
          borrowingOpen: false,
          oracle: 'CORACLE',
          supplyUsd: 0,
          borrowedUsd: 0,
          tier: 'n/a',
          reserves: [
            {
              asset: 'CXLM',
              symbol: 'XLM',
              priceUsd: undefined,
              collateralFactor: 0,
              liabilityFactor: 0,
              maxUtil: 0.9,
              supplied: 0,
              borrowed: 0,
              enabled: true,
              source: {
                poolOracle: 'CORACLE',
                upstream: 'CORACLE',
                upstreamKind: 'reflector-dex',
                upstreamAsset: undefined,
                maxDevPct: undefined,
                resolutionSec: undefined,
                maxAgeSec: undefined,
                isBaseAsset: true,
              },
              market: { mid: undefined, up2x: 0, up10x: 0, up100x: 0, down2x: 0, down10x: 0, upIsLowerBound: false, downIsLowerBound: false, volume24hUsd: 0 },
              collateralSide: { exposureUsd: 0, costUsd: undefined, tier: 'n/a' },
              debtSide: { exposureUsd: 0, costUsd: undefined, tier: 'n/a' },
              notes: [],
            },
          ],
        },
      ],
      errors: [],
    };

    expect(validateAgainstSchema(latestSchema, asPublished(report))).toEqual([]);
  });

  it('rejects an unknown tier, a missing required field, and an extra property', () => {
    const base = JSON.parse(
      readFileSync('schemas/latest.schema.json', 'utf8'),
    ) as unknown; // sanity: the schema file itself is valid JSON
    expect(base).toBeTruthy();

    const minimal = { scannedAt: '2026-01-01T00:00:00.000Z', ledger: 1, pools: [], errors: [] };
    expect(validateAgainstSchema(latestSchema, minimal)).toEqual([]);
    expect(validateAgainstSchema(latestSchema, { ...minimal, ledger: undefined })).toEqual([
      '$.ledger: required property is missing',
    ]);
    expect(validateAgainstSchema(latestSchema, { ...minimal, extra: true })).toEqual(['$.extra: property is not in the schema']);
    expect(
      validateAgainstSchema(latestSchema, {
        ...minimal,
        pools: [
          {
            id: 'C',
            name: 'x',
            status: 's',
            borrowingOpen: true,
            oracle: 'C',
            supplyUsd: 0,
            borrowedUsd: 0,
            tier: 'severe',
            reserves: [],
          },
        ],
      }),
    ).toEqual(['$.pools[0].tier: expected one of ["critical","high","medium","low","external","n/a"], got "severe"']);
  });
});

describe('schemas/oracle-status.schema.json', () => {
  it('accepts a full StatusReport with policy, gate, anchor and evidence', () => {
    const report: StatusReport = {
      at: 1_800_000_000,
      network: 'mainnet',
      oracle: 'CORACLE',
      assets: [
        {
          asset: 'Stellar:CUSTRY',
          decimals: 7,
          policy: { upBpsPerHour: 50, downBpsPerHour: 50, windowSecs: 3600 },
          effectivePolicy: { upBpsPerHour: 10, downBpsPerHour: 10, windowSecs: 3600 },
          gate: { tightUpBpsPerHour: 10, tightDownBpsPerHour: 10, minCostRatioBps: 10_000, maxEvidenceAge: 900 },
          anchor: { price: '10800000', timestamp: 1_800_000_000 },
          raw: '10810000',
          quote: '10800000',
          evidence: { upCost: '1000', upExposure: '2000', downCost: '1000', downExposure: '2000', timestamp: 1_800_000_000 },
          alerts: [{ severity: 'warn', code: 'evidence-stale', message: 'market evidence is 20 min old' }],
        },
      ],
    };

    expect(validateAgainstSchema(statusSchema, asPublished(report))).toEqual([]);
  });

  it('accepts the minimal shape: just asset and an empty alerts array', () => {
    const report: StatusReport = {
      at: 0,
      network: 'testnet',
      oracle: 'CORACLE',
      assets: [
        {
          asset: 'Stellar:CXYZ',
          decimals: undefined,
          policy: undefined,
          effectivePolicy: undefined,
          gate: undefined,
          anchor: undefined,
          raw: undefined,
          quote: undefined,
          evidence: undefined,
          alerts: [],
        },
      ],
    };

    expect(validateAgainstSchema(statusSchema, asPublished(report))).toEqual([]);
  });

  it('accepts the empty-pass fallback the keeper workflow writes when the oracle could not be read', () => {
    const fallback = { at: 1_800_000_000, network: 'mainnet', oracle: 'CORACLE', assets: [] };
    expect(validateAgainstSchema(statusSchema, fallback)).toEqual([]);
  });

  it('rejects an unknown alert severity and a missing required asset field', () => {
    expect(
      validateAgainstSchema(statusSchema, {
        at: 0,
        network: 'mainnet',
        oracle: 'C',
        assets: [{ asset: 'a', alerts: [{ severity: 'severe', code: 'x', message: 'y' }] }],
      }),
    ).toEqual(['$.assets[0].alerts[0].severity: expected one of ["critical","warn","info"], got "severe"']);

    expect(
      validateAgainstSchema(statusSchema, { at: 0, network: 'mainnet', oracle: 'C', assets: [{ alerts: [] }] }),
    ).toEqual(['$.assets[0].asset: required property is missing']);
  });
});
