/**
 * Reproduce damper-contracts ADR 0005's rate-fitting analysis for any asset (#16).
 * Usage: npm run fit-rates -- --asset CODE:ISSUER [--days 180] [--horizon URL] [--quote CODE:ISSUER]
 */
import { parseArgs } from 'node:util';
import { MAINNET, USDC_CLASSIC } from '../config.js';
import { consecutiveMovesPct, fetchTradeAggregations, fitRates, formatRateFit, toVwapBuckets } from '../rateFitting.js';

const { values } = parseArgs({
  options: {
    asset: { type: 'string' },
    days: { type: 'string', default: '180' },
    horizon: { type: 'string' },
    quote: { type: 'string' },
  },
});

function parseClassic(spec: string): { code: string; issuer: string } {
  const [code, issuer] = spec.split(':');
  if (!code || !issuer) throw new Error(`--asset/--quote must be CODE:ISSUER, got ${JSON.stringify(spec)}`);
  return { code, issuer };
}

async function main(): Promise<void> {
  if (!values.asset) throw new Error('--asset CODE:ISSUER is required');
  const days = Number(values.days);
  if (!(days > 0)) throw new Error('--days must be a positive number');

  const base = parseClassic(values.asset);
  const quote = values.quote ? parseClassic(values.quote) : USDC_CLASSIC;
  const horizonUrl = values.horizon ?? MAINNET.horizon;

  const end = Date.now();
  const start = end - days * 24 * 3_600_000;
  console.log(`pulling ${days} days of ${base.code}/${quote.code} trade_aggregations from ${horizonUrl}…`);
  const records = await fetchTradeAggregations(horizonUrl, base, quote, start, end);
  const buckets = toVwapBuckets(records);
  const moves = consecutiveMovesPct(buckets);
  if (moves.length === 0) {
    throw new Error('no two consecutive hourly buckets with trades in this window; try a wider --days or a liquid asset');
  }

  console.log(`${buckets.length} hourly VWAP buckets out of ${days * 24} possible hours\n`);
  console.log(formatRateFit(fitRates(moves)));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
