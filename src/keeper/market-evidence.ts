import { USDC_CLASSIC, type Network } from '../config.js';
import { tokenInfo } from '../assets.js';
import { depth, fetchOrderBook, type Depth } from '../market.js';
import { scan, withRetry } from '../scan.js';
import type { Sep40Asset, ViewClient } from '../rpc.js';

export interface DepthResult {
  depth?: Depth;
  /** Why there is no depth, when there is none. */
  reason?: string;
}

/**
 * The asset's SDEX order-book depth against USDC. The oracle may sit on testnet while the
 * market that matters is mainnet's, so the horizon to read is passed in separately.
 */
export async function depthFor(view: ViewClient, marketHorizon: string, asset: Sep40Asset): Promise<DepthResult> {
  if (asset[0] !== 'Stellar') return { reason: 'not a Stellar asset' };
  const info = await tokenInfo(view, asset[1]);
  if (!info.classic) return { reason: 'a custom token with no Stellar DEX market of its own' };
  const c = info.classic;
  if (c.code === USDC_CLASSIC.code && c.issuer === USDC_CLASSIC.issuer) return { reason: 'the quote asset itself' };
  const book = await withRetry(() => fetchOrderBook(marketHorizon, c, USDC_CLASSIC));
  const d = depth(book);
  return d.mid === undefined ? { reason: `no ${c.code} offers on the order book` } : { depth: d };
}

/** What an attacker could borrow once an asset's price is pushed up or down, in USD. */
export interface Exposure {
  up: number;
  down: number;
}
export type ExposureSource = (assetContract: string) => Exposure | undefined;

/** One number for every asset, for a pool that is not on-chain yet or a demonstration. */
export function fixedExposure(usd: number): ExposureSource {
  return () => ({ up: usd, down: usd });
}

/**
 * Read the exposure from a live pool that uses the oracle: for each reserve, what the other
 * reserves could lend (collateral side) and what this one could lend (debt side). One scan
 * per call, so call it once per keeper pass.
 */
export async function poolExposure(network: Network, poolId: string): Promise<ExposureSource> {
  const report = await scan([poolId], network);
  const pool = report.pools[0];
  if (!pool) throw new Error(`could not read pool ${poolId}: ${report.errors[0]?.error ?? 'unknown error'}`);
  const byAsset = new Map(pool.reserves.map((r) => [r.asset, { up: r.collateralSide.exposureUsd, down: r.debtSide.exposureUsd }]));
  return (asset) => byAsset.get(asset);
}
