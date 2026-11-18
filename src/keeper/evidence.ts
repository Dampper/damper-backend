/**
 * Market evidence for an oracle's cost gate. Pure: no network, no clock.
 *
 * The oracle's gate keeps an asset's policy rate only while fresh evidence says moving its
 * price costs at least `minCostRatioBps / 10_000` times what that would let an attacker
 * borrow. This file turns an order-book depth and an exposure into the numbers the contract
 * takes, and repeats the contract's own rule so the keeper can say what the oracle is doing.
 */
import type { Depth } from '../market.js';

/** The contract's `UNLIMITED`: a price that trading cannot move. i128::MAX. */
export const UNLIMITED = (1n << 127n) - 1n;

export interface EvidenceValues {
  upCost: bigint;
  upExposure: bigint;
  downCost: bigint;
  downExposure: bigint;
}

export interface GateConfig {
  tightUpBpsPerHour: number;
  tightDownBpsPerHour: number;
  minCostRatioBps: number;
  maxEvidenceAge: number;
}

export interface PublishedEvidence extends EvidenceValues {
  timestamp: number;
}

/** USD to the oracle's fixed-point amount, rounded, never negative or non-finite. */
export function toFixed(usd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  // go through a string so large amounts do not lose precision to a double
  const scaled = usd * 10 ** decimals;
  return BigInt(Math.round(scaled));
}

export interface EvidenceInput {
  /** The asset's SDEX order-book depth against USDC; undefined when it could not be read. */
  depth: Depth | undefined;
  /** The asset's price does not come from a market a trade can move. */
  external: boolean;
  /** What an attacker could borrow once the price is pushed up / down, in USD. */
  upExposureUsd: number;
  downExposureUsd: number;
  /** The oracle's price decimals. */
  decimals: number;
}

/**
 * Evidence to publish, or undefined when there is nothing trustworthy to say. Saying nothing
 * is safe: missing evidence makes the oracle use its tight rate.
 *
 * The cost model assumes the worst case, that every upstream feed reads this asset's SDEX
 * market. If some read other venues the real cost is higher, so the estimate errs towards
 * the tight rate.
 */
export function buildEvidence(i: EvidenceInput): EvidenceValues | undefined {
  const upExposure = toFixed(i.upExposureUsd, i.decimals);
  const downExposure = toFixed(i.downExposureUsd, i.decimals);
  if (i.external) return { upCost: UNLIMITED, upExposure, downCost: UNLIMITED, downExposure };
  if (!i.depth || i.depth.mid === undefined) return undefined;
  // The contract rejects a zero cost. An empty side of the book means the move is free.
  const atLeastOne = (n: bigint) => (n > 0n ? n : 1n);
  return {
    upCost: atLeastOne(toFixed(i.depth.up10x, i.decimals)),
    upExposure,
    downCost: atLeastOne(toFixed(i.depth.down10x, i.decimals)),
    downExposure,
  };
}

/** The contract's `uneconomic`: moving the price costs at least `ratio/10_000` times what it unlocks. */
export function uneconomic(cost: bigint, exposure: bigint, minRatioBps: number): boolean {
  if (cost === UNLIMITED || exposure <= 0n) return true;
  return cost * 10_000n >= exposure * BigInt(minRatioBps);
}

export function isFresh(timestamp: number, now: number, maxAge: number): boolean {
  return timestamp <= now && now - timestamp <= maxAge;
}

export interface GateStatus {
  /** There is evidence the oracle will accept. */
  fresh: boolean;
  /** The up and down directions currently keep their policy rate (before the policy's own bounds). */
  upKeepsPolicyRate: boolean;
  downKeepsPolicyRate: boolean;
}

/** What the contract's `effective_policy` will do for each direction right now. */
export function gateStatus(gate: GateConfig, evidence: PublishedEvidence | undefined, now: number): GateStatus {
  const fresh = evidence !== undefined && isFresh(evidence.timestamp, now, gate.maxEvidenceAge);
  if (!fresh || !evidence) return { fresh: false, upKeepsPolicyRate: false, downKeepsPolicyRate: false };
  return {
    fresh: true,
    upKeepsPolicyRate: uneconomic(evidence.upCost, evidence.upExposure, gate.minCostRatioBps),
    downKeepsPolicyRate: uneconomic(evidence.downCost, evidence.downExposure, gate.minCostRatioBps),
  };
}

/**
 * Publish when there is no evidence, or it has used up a third of its life. Pokes happen far
 * more often than evidence needs to, and each publish is a transaction.
 */
export function shouldPublish(gate: GateConfig, existing: PublishedEvidence | undefined, now: number): boolean {
  if (!existing) return true;
  if (!isFresh(existing.timestamp, now, gate.maxEvidenceAge)) return true;
  return now - existing.timestamp >= gate.maxEvidenceAge / 3;
}

/** '$1,200' for an oracle amount, or 'unmovable' for the sentinel. */
export function describeAmount(v: bigint, decimals: number): string {
  if (v === UNLIMITED) return 'unmovable';
  const whole = Number(v) / 10 ** decimals;
  if (whole >= 1e6) return `$${(whole / 1e6).toFixed(2)}M`;
  if (whole >= 1e3) return `$${(whole / 1e3).toFixed(1)}k`;
  return `$${whole.toFixed(0)}`;
}
