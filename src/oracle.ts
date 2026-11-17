import type { ViewClient, Sep40Asset } from './rpc.js';

/**
 * Where a pool's price for one asset ultimately comes from.
 *
 * Blend pools point at a single SEP-40 contract. In practice that is usually Blend's
 * oracle-aggregator (github.com/blend-capital/oracle-aggregator), which maps each asset
 * to exactly one upstream feed and optionally applies `max_dev`. `max_dev` compares the
 * latest upstream record with the one before it, so a manipulated price held for two
 * consecutive rounds passes it.
 */
export interface PriceSource {
  /** Contract the pool calls. */
  poolOracle: string;
  /** Upstream feed the price comes from (equal to poolOracle when there is no aggregator). */
  upstream: string;
  upstreamKind: UpstreamKind;
  /** Admin key of an operator-run upstream feed. */
  upstreamAdmin?: string;
  /** Identifier the upstream feed uses for this asset. */
  upstreamAsset: Sep40Asset | undefined;
  /** Aggregator deviation guard in percent; 0 means disabled. Undefined without an aggregator. */
  maxDevPct: number | undefined;
  /** Seconds between upstream rounds, i.e. how far back `max_dev` looks. */
  resolutionSec: number | undefined;
  maxAgeSec: number | undefined;
  /** The aggregator returns a fixed price of 1 for base assets. */
  isBaseAsset: boolean;
}

/**
 * - reflector-dex: Reflector's Stellar DEX feed, priced from SDEX trades
 * - reflector-cex: Reflector's aggregate of off-chain exchanges
 * - operator-feed: a SEP-40 feed whose prices are pushed by a single admin key
 *   (e.g. an issuer publishing NAV); trust rests on that key, not on a market
 */
export type UpstreamKind = 'reflector-dex' | 'reflector-cex' | 'operator-feed' | 'unknown';

/**
 * Reflector feeds, identified on-chain by their base asset:
 * the Stellar DEX feed is quoted in USDC (SAC), the CEX/DEX aggregate feed in Other("USD").
 */
export const KNOWN_UPSTREAMS: Record<string, UpstreamKind> = {
  CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M: 'reflector-dex',
  CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN: 'reflector-cex',
};

const kindCache = new Map<string, { kind: UpstreamKind; admin?: string }>();

async function classify(view: ViewClient, upstream: string): Promise<{ kind: UpstreamKind; admin?: string }> {
  const known = KNOWN_UPSTREAMS[upstream];
  if (known) return { kind: known };
  const hit = kindCache.get(upstream);
  if (hit) return hit;
  const admin = await view.tryCall<string>(upstream, 'admin');
  const result: { kind: UpstreamKind; admin?: string } =
    typeof admin === 'string' && admin.startsWith('G') ? { kind: 'operator-feed', admin } : { kind: 'unknown' };
  kindCache.set(upstream, result);
  return result;
}

interface AggregatorAssetConfig {
  asset: Sep40Asset;
  max_dev: number;
  oracle_index: number;
}
interface AggregatorOracle {
  address: string;
  decimals: number;
  index: number;
  resolution: number;
}

/** Resolve the price source of every asset in `assets` for one pool oracle. */
export async function resolveSources(
  view: ViewClient,
  poolOracle: string,
  assets: string[],
): Promise<Map<string, PriceSource>> {
  const out = new Map<string, PriceSource>();
  const configs = await view.tryCall<Map<unknown, AggregatorAssetConfig> | Record<string, AggregatorAssetConfig>>(
    poolOracle,
    'asset_configs',
  );

  if (configs === undefined) {
    // Not an aggregator: the pool reads its upstream directly.
    const resolution = await view.tryCall<number>(poolOracle, 'resolution');
    const { kind, admin } = await classify(view, poolOracle);
    for (const a of assets) {
      out.set(a, {
        poolOracle,
        upstream: poolOracle,
        upstreamKind: kind,
        upstreamAdmin: admin,
        upstreamAsset: ['Stellar', a],
        maxDevPct: undefined,
        resolutionSec: resolution,
        maxAgeSec: undefined,
        isBaseAsset: false,
      });
    }
    return out;
  }

  const oracles = (await view.call<AggregatorOracle[]>(poolOracle, 'oracles')) ?? [];
  const maxAge = Number(await view.call<bigint>(poolOracle, 'max_age'));
  const byAsset = new Map<string, AggregatorAssetConfig>();
  const entries = configs instanceof Map ? [...configs.entries()] : Object.entries(configs);
  for (const [key, cfg] of entries) {
    // keys decode as ['Stellar', 'C...'] (Map) or "Stellar,C..." (object)
    const id = Array.isArray(key) ? key[1] : String(key).split(',')[1];
    if (id) byAsset.set(id, cfg);
  }

  for (const a of assets) {
    const cfg = byAsset.get(a);
    const oracle = cfg ? oracles.find((o) => o.index === cfg.oracle_index) : undefined;
    const { kind, admin } = oracle ? await classify(view, oracle.address) : { kind: 'unknown' as const, admin: undefined };
    out.set(a, {
      poolOracle,
      upstream: oracle?.address ?? poolOracle,
      upstreamKind: kind,
      upstreamAdmin: admin,
      upstreamAsset: cfg?.asset,
      maxDevPct: cfg?.max_dev,
      resolutionSec: oracle?.resolution,
      maxAgeSec: maxAge,
      // Assets with no config are either base assets (fixed price 1) or unpriced.
      isBaseAsset: cfg === undefined,
    });
  }
  return out;
}
