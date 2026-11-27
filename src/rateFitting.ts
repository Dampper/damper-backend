/**
 * Reproducible version of the analysis behind damper-contracts ADR 0005 (#16): pull an
 * asset's SDEX trade history from Horizon, turn it into an hourly VWAP series, measure how
 * much the price actually moves hour over hour, and print percentiles plus suggested clamp
 * rates from them — so the fit can be re-run for another asset instead of redone by hand
 * outside the repo, as 0005's XLM/USDC analysis originally was.
 *
 * VWAP, not the bucket's high/low: ADR 0005 found that pulling the raw high/low gave hourly
 * ranges up to 515%, an artifact of a single dust-sized resting offer getting hit for a few
 * dollars far from where the hour actually traded. The volume-weighted price
 * (`counter_volume / base_volume`) is immune to that: a thin print barely moves it.
 */
import { assetParams, horizon, type ClassicAsset } from './market.js';
import { withRetry } from './scan.js';

export interface TradeAggregationRecord {
  timestamp: number;
  base_volume: string;
  counter_volume: string;
}

/** Horizon's own page cap for /trade_aggregations, same as the order book (#20). */
export const TRADE_AGG_PAGE_LIMIT = 200;

/**
 * Every hourly (or `resolutionMs`) bucket Horizon has for `base`/`counter` between `startMs`
 * and `endMs`, paging past the 200-record limit automatically. Horizon omits a bucket with no
 * trades, so the result can have fewer records than hours in the window.
 */
export async function fetchTradeAggregations(
  horizonUrl: string,
  base: ClassicAsset,
  counter: ClassicAsset,
  startMs: number,
  endMs: number,
  resolutionMs = 3_600_000,
): Promise<TradeAggregationRecord[]> {
  const out: TradeAggregationRecord[] = [];
  let cursor = startMs;
  for (;;) {
    const raw = await withRetry(() =>
      horizon<{ _embedded: { records: TradeAggregationRecord[] } }>(horizonUrl, '/trade_aggregations', {
        ...assetParams('base', base),
        ...assetParams('counter', counter),
        start_time: String(cursor),
        end_time: String(endMs),
        resolution: String(resolutionMs),
        order: 'asc',
        limit: String(TRADE_AGG_PAGE_LIMIT),
      }),
    );
    const records = raw._embedded.records;
    out.push(...records);
    if (records.length < TRADE_AGG_PAGE_LIMIT) break;
    const last = records.at(-1)!.timestamp;
    if (last <= cursor || last >= endMs) break; // guards against an infinite loop on an odd response
    cursor = last + 1;
  }
  return out;
}

export interface VwapBucket {
  timestamp: number;
  vwap: number;
}

/** `counter_volume / base_volume` per bucket. Drops a bucket with no real volume (0/0, or Horizon noise). */
export function toVwapBuckets(records: TradeAggregationRecord[]): VwapBucket[] {
  return records
    .map((r) => ({ timestamp: r.timestamp, vwap: Number(r.counter_volume) / Number(r.base_volume) }))
    .filter((b) => Number.isFinite(b.vwap) && b.vwap > 0);
}

/**
 * Absolute percent change between each bucket and the one exactly `resolutionMs` before it.
 * A gap (an hour Horizon has no trades for) is skipped rather than compared across: the move
 * from one traded hour to the next one two hours later is not "hour-over-hour".
 */
export function consecutiveMovesPct(buckets: VwapBucket[], resolutionMs = 3_600_000): number[] {
  const sorted = [...buckets].sort((a, b) => a.timestamp - b.timestamp);
  const moves: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.timestamp - prev.timestamp !== resolutionMs) continue;
    moves.push((Math.abs(cur.vwap - prev.vwap) / prev.vwap) * 100);
  }
  return moves;
}

/** Nearest-rank percentile of a value already sorted ascending; 0 for an empty series. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[index]!;
}

function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export interface RateFit {
  /** Number of hour-over-hour moves the percentiles below are drawn from. */
  moves: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  /** A little above p90 (×1.3), rounded up to the nearest 10 bps: ordinary movement still gets through while the gate is tight. */
  suggestedTightBpsPerHour: number;
  /** About 2x the worst observed hour, rounded up to the nearest 100 bps, never below 10x the tight rate. */
  suggestedPolicyBpsPerHour: number;
}

/** Percentiles and suggested policy/tight rates (in bps/hour) from a series of hour-over-hour percent moves. */
export function fitRates(movesPct: readonly number[]): RateFit {
  const sorted = [...movesPct].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  const p99 = percentile(sorted, 99);
  const p999 = percentile(sorted, 99.9);
  const max = sorted.at(-1) ?? 0;
  const tight = roundUpTo(p90 * 1.3 * 100, 10);
  const policy = Math.max(roundUpTo(max * 2 * 100, 100), tight * 10);
  return { moves: sorted.length, p50, p90, p99, p999, max, suggestedTightBpsPerHour: tight, suggestedPolicyBpsPerHour: policy };
}

/** Renders the percentile table and suggested rates the way ADR 0005 presents them. */
export function formatRateFit(fit: RateFit): string {
  const pct = (n: number) => `${n.toFixed(2)}%`;
  return [
    `${fit.moves} hour-over-hour moves`,
    `  p50   ${pct(fit.p50)}`,
    `  p90   ${pct(fit.p90)}`,
    `  p99   ${pct(fit.p99)}`,
    `  p99.9 ${pct(fit.p999)}`,
    `  max   ${pct(fit.max)}`,
    '',
    `suggested tight rate:  ${fit.suggestedTightBpsPerHour} bps/hour`,
    `suggested policy rate: ${fit.suggestedPolicyBpsPerHour} bps/hour`,
  ].join('\n');
}
