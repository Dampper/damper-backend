import { PoolV2, type ReserveConfigV2 } from '@blend-capital/blend-sdk';
import { MAINNET, USDC_CLASSIC, type Network } from './config.js';
import { ViewClient } from './rpc.js';
import { resolveSources, type PriceSource } from './oracle.js';
import { tokenInfo } from './assets.js';
import { depth, fetchOrderBook, fetchVolume, type Depth } from './market.js';
import {
  borrowableUsd,
  collateralSideExposure,
  tier,
  worst,
  type ReserveSnapshot,
  type Tier,
} from './score.js';

export const POOL_STATUS: Record<number, string> = {
  0: 'admin active',
  1: 'active',
  2: 'admin on ice',
  3: 'on ice',
  4: 'admin frozen',
  5: 'frozen',
  6: 'setup',
};

export interface SideReport {
  exposureUsd: number;
  costUsd: number | undefined;
  tier: Tier;
}

export interface ReserveReport extends ReserveSnapshot {
  source: PriceSource;
  market: (Depth & { volume24hUsd: number }) | undefined;
  collateralSide: SideReport;
  debtSide: SideReport;
  notes: string[];
}

export interface PoolReport {
  id: string;
  name: string;
  status: string;
  /** New borrows are only possible while the pool is active. */
  borrowingOpen: boolean;
  oracle: string;
  supplyUsd: number;
  borrowedUsd: number;
  tier: Tier;
  reserves: ReserveReport[];
}

export interface ScanReport {
  scannedAt: string;
  ledger: number;
  pools: PoolReport[];
  errors: { pool: string; error: string }[];
}

const FIXED_7 = 1e7;
/** Circle USDC's Stellar Asset Contract; the pools quote everything in it. */
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

/** Longest a single retry waits on a server-given Retry-After, matching the cap `deliver` (notify.ts) uses for webhooks. */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * An error that names how long the server asked callers to wait before trying again
 * (`retryAfterMs`), so a 429 can be honoured instead of guessed at. Thrown by the Horizon
 * helper in `market.ts`; errors from other sources simply do not have this property.
 */
export interface RetryableError extends Error {
  retryAfterMs?: number;
}

function hasRetryAfter(e: unknown): e is RetryableError {
  return e instanceof Error && typeof (e as RetryableError).retryAfterMs === 'number';
}

/**
 * Public RPC and Horizon endpoints drop the odd request; retry transport failures only.
 * A 429 that carries a `Retry-After` (see `RetryableError`) waits exactly that long, capped
 * at `MAX_RETRY_AFTER_MS`; everything else falls back to exponential backoff, as before.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message ?? '';
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|socket|429|50[234]/.test(msg);
      if (!transient || i >= attempts) throw e;
      const wait = hasRetryAfter(e) ? Math.min(e.retryAfterMs!, MAX_RETRY_AFTER_MS) : 1000 * 2 ** (i - 1);
      await sleep(wait);
    }
  }
}

export async function scan(poolIds: string[], network: Network = MAINNET): Promise<ScanReport> {
  const view = new ViewClient(network);
  // Public RPCs reset connections under bursts of parallel reads; keep the SDK polite.
  const blendNetwork = { rpc: network.rpc, passphrase: network.passphrase, maxConcurrentRequests: 4 };
  const ledger = (await view.server.getLatestLedger()).sequence;
  const report: ScanReport = { scannedAt: new Date().toISOString(), ledger, pools: [], errors: [] };

  for (const id of poolIds) {
    try {
      report.pools.push(await withRetry(() => scanPool(view, network, blendNetwork, id)));
    } catch (e) {
      report.errors.push({ pool: id, error: (e as Error).message.slice(0, 300) });
    }
  }
  report.pools.sort((a, b) => b.supplyUsd - a.supplyUsd);
  return report;
}

async function scanPool(
  view: ViewClient,
  network: Network,
  blendNetwork: { rpc: string; passphrase: string; maxConcurrentRequests: number },
  id: string,
): Promise<PoolReport> {
  const pool = await PoolV2.load(blendNetwork, id);
  const oracle = await pool.loadOracle();
  const assets = [...pool.reserves.keys()];
  const sources = await resolveSources(view, pool.metadata.oracle, assets);

  const snapshots: ReserveSnapshot[] = [];
  for (const r of pool.reserves.values()) {
    const cfg = r.config as ReserveConfigV2;
    const info = await tokenInfo(view, r.assetId);
    snapshots.push({
      asset: r.assetId,
      symbol: info.symbol,
      priceUsd: oracle.getPriceFloat(r.assetId),
      collateralFactor: r.getCollateralFactor(),
      liabilityFactor: r.getLiabilityFactor(),
      maxUtil: cfg.max_util / FIXED_7,
      supplied: r.totalSupplyFloat(),
      borrowed: r.totalLiabilitiesFloat(),
      enabled: cfg.enabled ?? true,
    });
  }

  const reserves: ReserveReport[] = [];
  for (const s of snapshots) {
    const source = sources.get(s.asset)!;
    const notes: string[] = [];
    const info = await tokenInfo(view, s.asset);

    let market: ReserveReport['market'];
    let external = false;
    if (source.isBaseAsset) {
      notes.push('base asset: the aggregator always returns 1');
      if (s.collateralFactor > 0 && s.asset !== USDC_SAC) {
        notes.push(
          `fixed-price collateral (cf ${s.collateralFactor.toFixed(2)}): a depeg is invisible to the pool`,
        );
      }
    } else if (source.upstreamKind === 'reflector-cex') {
      external = true;
      notes.push('priced from off-chain venues (Reflector CEX feed)');
    } else if (source.upstreamKind === 'operator-feed') {
      external = true;
      notes.push(`prices pushed by admin key ${source.upstreamAdmin}; not derived from SDEX trades`);
    } else if (source.upstreamKind === 'reflector-dex' && info.classic) {
      const classic = info.classic;
      const [book, volume] = await Promise.all([
        withRetry(() => fetchOrderBook(network.horizon, classic, USDC_CLASSIC)),
        withRetry(() => fetchVolume(network.horizon, classic, USDC_CLASSIC)),
      ]);
      market = { ...depth(book), volume24hUsd: volume };
    } else {
      notes.push(`upstream ${source.upstreamKind}; no on-chain market model yet`);
    }
    if (source.maxDevPct !== undefined && source.maxDevPct > 0 && source.maxDevPct < 100) {
      notes.push(
        `max_dev ${source.maxDevPct}% vs the previous round only (${source.resolutionSec}s); ` +
          'a price held for two rounds passes',
      );
    } else if (source.maxDevPct === 0) {
      notes.push('max_dev disabled');
    }

    const evidence = (cost: number | undefined) => ({
      costUsd: source.isBaseAsset ? undefined : cost,
      volume24hUsd: market?.volume24hUsd,
      external,
    });

    const collateralExposure = s.collateralFactor > 0 ? collateralSideExposure(snapshots, s.asset) : 0;
    const debtExposure = borrowableUsd(s);
    reserves.push({
      ...s,
      source,
      market,
      collateralSide: {
        exposureUsd: collateralExposure,
        costUsd: market?.up10x,
        tier: tier(collateralExposure, evidence(market?.up10x)),
      },
      debtSide: {
        exposureUsd: debtExposure,
        costUsd: market?.down10x,
        tier: tier(debtExposure, evidence(market?.down10x)),
      },
      notes,
    });
  }

  const status = pool.metadata.status;
  const value = (f: (s: ReserveSnapshot) => number) =>
    snapshots.reduce((sum, s) => sum + f(s) * (s.priceUsd ?? 0), 0);
  return {
    id,
    name: pool.metadata.name,
    status: POOL_STATUS[status] ?? String(status),
    borrowingOpen: status <= 1,
    oracle: pool.metadata.oracle,
    supplyUsd: value((s) => s.supplied),
    borrowedUsd: value((s) => s.borrowed),
    tier: worst(reserves.flatMap((r) => [r.collateralSide.tier, r.debtSide.tier])),
    reserves,
  };
}
