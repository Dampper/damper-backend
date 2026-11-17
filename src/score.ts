/**
 * Pure risk scoring. Everything here takes plain numbers so it can be tested without
 * a network.
 *
 * The question for each reserve: if someone could make the oracle report a false price
 * for this asset, how much could they take out of the pool, and what would it cost them
 * to produce that price?
 *
 * - Collateral side: inflate the asset's price, post it as collateral, borrow everything
 *   else. Exposure is the borrowable liquidity of the *other* reserves.
 * - Debt side: deflate the asset's price, then borrow far more of it than the collateral
 *   supports. Exposure is this reserve's own borrowable liquidity.
 */

export interface ReserveSnapshot {
  asset: string;
  symbol: string;
  priceUsd: number | undefined;
  collateralFactor: number; // 0..1
  liabilityFactor: number; // >= 1, or 0 when not borrowable
  maxUtil: number; // 0..1
  supplied: number; // asset units
  borrowed: number; // asset units
  enabled: boolean;
}

/** Liquidity that can still be borrowed out of a reserve, in USD. */
export function borrowableUsd(r: ReserveSnapshot): number {
  if (!r.enabled || r.priceUsd === undefined || r.liabilityFactor === 0) return 0;
  return Math.max(0, r.maxUtil * r.supplied - r.borrowed) * r.priceUsd;
}

/** USD an attacker could borrow from every reserve except `asset`. */
export function collateralSideExposure(reserves: ReserveSnapshot[], asset: string): number {
  return reserves.filter((r) => r.asset !== asset).reduce((s, r) => s + borrowableUsd(r), 0);
}

export type Tier = 'critical' | 'high' | 'medium' | 'low' | 'external' | 'n/a';

export interface MarketEvidence {
  /** Capital needed to make the feed see the manipulated price (USD). Undefined if not an on-chain market. */
  costUsd: number | undefined;
  volume24hUsd: number | undefined;
  /** True when the price comes from off-chain venues (e.g. Reflector CEX feed). */
  external: boolean;
}

/**
 * Tiering, deliberately simple so a pool operator can check it by hand:
 * - external: price comes from off-chain venues; out of scope for SDEX manipulation
 * - critical: exposure is at least 10x the capital needed to move the price,
 *             or the market barely trades (< $1,000 a day) while exposure is over $10,000
 * - high:     exposure exceeds the capital needed
 * - medium:   exposure is at least 10% of the capital needed
 * - low:      otherwise
 */
export function tier(exposureUsd: number, m: MarketEvidence): Tier {
  if (exposureUsd <= 0) return 'n/a';
  if (m.external) return 'external';
  if (m.costUsd === undefined) return 'n/a';
  if (m.volume24hUsd !== undefined && m.volume24hUsd < 1_000 && exposureUsd > 10_000) return 'critical';
  const cost = Math.max(m.costUsd, 1);
  if (exposureUsd >= 10 * cost) return 'critical';
  if (exposureUsd > cost) return 'high';
  if (exposureUsd >= 0.1 * cost) return 'medium';
  return 'low';
}

const ORDER: Tier[] = ['critical', 'high', 'medium', 'low', 'external', 'n/a'];
export function worst(tiers: Tier[]): Tier {
  return tiers.reduce<Tier>((w, t) => (ORDER.indexOf(t) < ORDER.indexOf(w) ? t : w), 'n/a');
}
