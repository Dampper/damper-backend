/**
 * A serializable snapshot of what the oracle reports for one asset, for a status page.
 *
 * Everything the dashboard needs to show "is this oracle healthy right now" already passes
 * through the keeper on every pass (`AssetState`, read in chain.ts). This just turns it into
 * plain JSON: bigints as decimal strings (JSON has no 64/128-bit integer type, and a price in
 * the oracle's fixed-point units can exceed `Number`'s safe range), everything else as-is.
 */
import type { Alert, AssetState } from './decide.js';

export interface AssetStatus {
  asset: string;
  decimals: number | undefined;
  policy: AssetState['policy'];
  effectivePolicy: AssetState['effectivePolicy'];
  gate: AssetState['gate'];
  anchor: { price: string; timestamp: number } | undefined;
  /** The median before any clamp, as a decimal string. */
  raw: string | undefined;
  /** What a pool actually reads from `lastprice`, as a decimal string. */
  quote: string | undefined;
  evidence:
    | { upCost: string; upExposure: string; downCost: string; downExposure: string; timestamp: number }
    | undefined;
  alerts: Alert[];
}

export interface StatusReport {
  at: number;
  network: string;
  oracle: string;
  assets: AssetStatus[];
}

export function assetStatus(state: AssetState, alerts: Alert[]): AssetStatus {
  return {
    asset: state.asset,
    decimals: state.decimals,
    policy: state.policy,
    effectivePolicy: state.effectivePolicy,
    gate: state.gate,
    anchor: state.anchor ? { price: state.anchor.price.toString(), timestamp: state.anchor.timestamp } : undefined,
    raw: state.raw?.toString(),
    quote: state.quote?.toString(),
    evidence: state.evidence
      ? {
          upCost: state.evidence.upCost.toString(),
          upExposure: state.evidence.upExposure.toString(),
          downCost: state.evidence.downCost.toString(),
          downExposure: state.evidence.downExposure.toString(),
          timestamp: state.evidence.timestamp,
        }
      : undefined,
    alerts,
  };
}

export function buildStatusReport(network: string, oracle: string, assets: AssetStatus[], now: number): StatusReport {
  return { at: now, network, oracle, assets };
}
