import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consecutiveMovesPct,
  fetchTradeAggregations,
  fitRates,
  formatRateFit,
  percentile,
  toVwapBuckets,
  TRADE_AGG_PAGE_LIMIT,
  type TradeAggregationRecord,
} from '../src/rateFitting.js';

describe('percentile', () => {
  it('uses nearest-rank on a sorted series', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 100)).toBe(10);
  });

  it('is 0 for an empty series and the single value for a one-element series', () => {
    expect(percentile([], 90)).toBe(0);
    expect(percentile([42], 1)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('toVwapBuckets', () => {
  it('computes counter/base as the volume-weighted price', () => {
    const buckets = toVwapBuckets([{ timestamp: 1000, base_volume: '100', counter_volume: '25' }]);
    expect(buckets).toEqual([{ timestamp: 1000, vwap: 0.25 }]);
  });

  it('drops a bucket with zero or non-finite volume instead of producing NaN or Infinity', () => {
    const buckets = toVwapBuckets([
      { timestamp: 1, base_volume: '0', counter_volume: '0' },
      { timestamp: 2, base_volume: '0', counter_volume: '5' },
      { timestamp: 3, base_volume: 'not-a-number', counter_volume: '5' },
      { timestamp: 4, base_volume: '10', counter_volume: '5' },
    ]);
    expect(buckets).toEqual([{ timestamp: 4, vwap: 0.5 }]);
  });
});

describe('consecutiveMovesPct', () => {
  it('measures the percent move only between buckets exactly one resolution apart', () => {
    const buckets = [
      { timestamp: 0, vwap: 1 },
      { timestamp: 3_600_000, vwap: 1.1 }, // +10%, consecutive
      { timestamp: 7_200_000 + 1, vwap: 2 }, // not exactly one more hour later: skipped
    ];
    expect(consecutiveMovesPct(buckets)).toEqual([10]);
  });

  it('sorts its input first, so order does not matter', () => {
    const buckets = [
      { timestamp: 3_600_000, vwap: 1.1 },
      { timestamp: 0, vwap: 1 },
    ];
    expect(consecutiveMovesPct(buckets)).toEqual([10]);
  });

  it('is empty for zero or one bucket', () => {
    expect(consecutiveMovesPct([])).toEqual([]);
    expect(consecutiveMovesPct([{ timestamp: 0, vwap: 1 }])).toEqual([]);
  });
});

describe('fitRates', () => {
  it('derives ADR 0005\'s chosen XLM/USDC rates from a series matching its percentile table', () => {
    // ADR 0005 (docs/adr/0005-rates-fitted-to-real-data.md in damper-contracts): 180 days of
    // XLM/USDC trade_aggregations gave p50 0.34%, p90 1.15%, p99 2.85%, p99.9 5.52%, max
    // 7.07% over 4,000 hours, and the project chose a 150 bps/hour tight rate and a 1,500
    // bps/hour policy rate from them. This builds a 1,000-value series whose nearest-rank
    // p50/p90/p99/p99.9/max land exactly on those five figures, so the suggested rates this
    // formula derives from them can be checked against the ones the project actually chose.
    const series = [
      ...Array(499).fill(0.1),
      0.34, // index 499 = ceil(0.50 * 1000) - 1 -> p50
      ...Array(399).fill(0.5),
      1.15, // index 899 = ceil(0.90 * 1000) - 1 -> p90
      ...Array(89).fill(2.0),
      2.85, // index 989 = ceil(0.99 * 1000) - 1 -> p99
      ...Array(8).fill(4.0),
      5.52, // index 998 = ceil(0.999 * 1000) - 1 -> p99.9
      7.07, // index 999 (last) -> max
    ];
    expect(series).toHaveLength(1000);
    const fit = fitRates(series);
    expect(fit.p50).toBe(0.34);
    expect(fit.p90).toBe(1.15);
    expect(fit.p99).toBe(2.85);
    expect(fit.p999).toBe(5.52);
    expect(fit.max).toBe(7.07);
    expect(fit.suggestedTightBpsPerHour).toBe(150);
    expect(fit.suggestedPolicyBpsPerHour).toBe(1500);
  });

  it('keeps the policy rate at least 10x the tight rate even when the worst hour is mild', () => {
    const fit = fitRates(Array(100).fill(0.1)); // p90 = max = 0.1%, nothing dramatic
    expect(fit.suggestedPolicyBpsPerHour).toBeGreaterThanOrEqual(fit.suggestedTightBpsPerHour * 10);
  });

  it('is deterministic and does not mutate its input', () => {
    const series = [3, 1, 2];
    const first = fitRates(series);
    const second = fitRates(series);
    expect(first).toEqual(second);
    expect(series).toEqual([3, 1, 2]);
  });

  it('formats a readable table and suggested rates', () => {
    const text = formatRateFit(fitRates([0.1, 0.2, 0.3]));
    expect(text).toContain('p50');
    expect(text).toContain('suggested tight rate:');
    expect(text).toContain('suggested policy rate:');
    expect(text).toMatch(/bps\/hour/);
  });
});

describe('end-to-end on a recorded fixture', () => {
  // 96 hourly XLM/USDC trade_aggregations records pulled live from
  // https://horizon.stellar.org/trade_aggregations on 2026-11-23 (ledger time ~1,763,856,000,000
  // to 1,764,198,000,000 ms), trimmed to the three fields this module reads. See
  // test/fixtures/xlm-usdc-trade-aggregations.json and CONTRIBUTING.md ("real data in
  // fixtures where you can").
  const records = JSON.parse(
    readFileSync('test/fixtures/xlm-usdc-trade-aggregations.json', 'utf8'),
  ) as TradeAggregationRecord[];

  it('has one real trading hour per record and no gaps bridged across a missing hour', () => {
    const buckets = toVwapBuckets(records);
    expect(buckets).toHaveLength(96);
    const moves = consecutiveMovesPct(buckets);
    // one move between every pair of adjacent hours in a 96-hour, gap-free window
    expect(moves).toHaveLength(95);
    expect(moves.every((m) => m >= 0)).toBe(true);
  });

  it('matches the percentiles independently computed from the same fixture', () => {
    const moves = consecutiveMovesPct(toVwapBuckets(records));
    const fit = fitRates(moves);
    // Computed independently in Python from the same fixture file.
    expect(fit.p50).toBeCloseTo(0.5128, 3);
    expect(fit.p90).toBeCloseTo(1.3311, 3);
    expect(fit.max).toBeCloseTo(1.9744, 3);
    expect(fit.suggestedTightBpsPerHour).toBeGreaterThan(0);
    expect(fit.suggestedPolicyBpsPerHour).toBeGreaterThanOrEqual(fit.suggestedTightBpsPerHour * 10);
  });
});

describe('fetchTradeAggregations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const asset = { code: 'XLM', issuer: undefined };
  const quote = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' };

  function record(hour: number): TradeAggregationRecord {
    return { timestamp: hour * 3_600_000, base_volume: '100', counter_volume: '25' };
  }

  it('pages past the 200-record limit, continuing exactly where the previous page ended', async () => {
    const calls: URLSearchParams[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      calls.push(params);
      // Horizon buckets by hour regardless of the exact (possibly sub-hour) start_time it was
      // asked for, so the mock rounds up to the next whole hour the way the real service would.
      const startHour = Math.ceil(Number(params.get('start_time')) / 3_600_000);
      const records =
        calls.length === 1
          ? Array.from({ length: TRADE_AGG_PAGE_LIMIT }, (_, i) => record(startHour + i))
          : [record(startHour), record(startHour + 1)]; // second (final) page: short, so paging stops
      return new Response(JSON.stringify({ _embedded: { records } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const start = 0;
    const end = 1000 * 3_600_000;
    const all = await fetchTradeAggregations('https://horizon.example', asset, quote, start, end);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(all).toHaveLength(TRADE_AGG_PAGE_LIMIT + 2);
    // the second page's start_time picks up exactly 1ms after the first page's last record
    const firstPageLast = Number(calls[0]!.get('start_time')) / 3_600_000 + (TRADE_AGG_PAGE_LIMIT - 1);
    expect(Number(calls[1]!.get('start_time'))).toBe(firstPageLast * 3_600_000 + 1);
    expect(all.map((r) => r.timestamp)).toEqual([...Array(TRADE_AGG_PAGE_LIMIT + 2).keys()].map((h) => h * 3_600_000));
  });

  it('makes one call and stops when the first page is short', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ _embedded: { records: [record(0), record(1)] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const all = await fetchTradeAggregations('https://horizon.example', asset, quote, 0, 10 * 3_600_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(all).toHaveLength(2);
  });

  it('requests exactly the page limit and the given resolution', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchTradeAggregations('https://horizon.example', asset, quote, 0, 3_600_000, 3_600_000);

    const params = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    expect(params.get('limit')).toBe(String(TRADE_AGG_PAGE_LIMIT));
    expect(params.get('resolution')).toBe('3600000');
    expect(params.get('order')).toBe('asc');
  });
});
