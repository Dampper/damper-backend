/**
 * What the keeper does about one asset, given what the oracle reports. Pure: no network,
 * no clock, so every branch is unit-tested.
 *
 * The keeper's one job is `poke`: move the anchor to the current clamped quote so the
 * anchor tracks real price changes at the policy's rate. The rest is telling a human
 * when something is off, because most failure modes of a guarded oracle are silent
 * (a clamp that is binding looks like a normal price to the pool).
 */

/** Matches `MIN_POKE_SECS` in the contract; below this a poke does nothing. */
export const MIN_POKE_SECS = 300;

export interface AssetState {
  asset: string;
  policy: { upBpsPerHour: number; downBpsPerHour: number; windowSecs: number } | undefined;
  anchor: { price: bigint; timestamp: number } | undefined;
  /** Median of the upstream feeds before any clamp. */
  raw: bigint | undefined;
  /** What a pool reads from `lastprice`. */
  quote: bigint | undefined;
}

export const UNBOUNDED = 4_294_967_295; // u32::MAX, as in the contract

export type Severity = 'critical' | 'warn' | 'info';
export interface Alert {
  severity: Severity;
  code: string;
  message: string;
}

export type Action =
  | { kind: 'poke' }
  | { kind: 'wait'; reason: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'skip'; reason: string };

export interface Options {
  /** Pokes are margin seconds later than the contract minimum, to avoid racing the ledger clock. */
  marginSecs: number;
  /**
   * If the raw price sits further than this ratio from the anchor, pokes are held back
   * instead of dragging the anchor towards it. 1.5 means +50% / -33%.
   */
  holdRatio: number;
  /** Longest the keeper holds pokes for one suspicious move before assuming it is real. */
  maxHoldSecs: number;
  /** Alert when the raw price and the quote differ by more than this ratio. */
  divergenceAlert: number;
}

export const DEFAULTS: Options = {
  marginSecs: 30,
  holdRatio: 1.5,
  maxHoldSecs: 6 * 3600,
  divergenceAlert: 1.02,
};

export interface Decision {
  action: Action;
  alerts: Alert[];
  /** Carry this into the next call for the same asset. Undefined when the move is not suspicious. */
  suspiciousSince: number | undefined;
}

function ratio(a: bigint, b: bigint): number {
  // Only the ratio's magnitude matters; Number() is exact enough for 7..18 decimal prices.
  return Number(a) / Number(b);
}

export function decide(
  s: AssetState,
  now: number,
  suspiciousSince: number | undefined,
  opts: Options = DEFAULTS,
): Decision {
  const alerts: Alert[] = [];
  const done = (action: Action, since: number | undefined = undefined): Decision => ({
    action,
    alerts,
    suspiciousSince: since,
  });

  if (!s.policy) {
    alerts.push({
      severity: 'warn',
      code: 'no-policy',
      message: 'asset has no clamp policy: the oracle returns the raw median',
    });
    return done({ kind: 'skip', reason: 'no policy' });
  }

  if (!s.anchor) {
    alerts.push({
      severity: 'critical',
      code: 'unseeded',
      message: 'policy is set but the anchor was never seeded: the oracle returns no price',
    });
    return done({ kind: 'skip', reason: 'anchor not seeded (admin action)' });
  }

  if (s.quote === undefined) {
    alerts.push({
      severity: 'critical',
      code: 'no-quote',
      message: 'oracle returns no price: too few fresh upstream feeds, or all are stale',
    });
    return done({ kind: 'skip', reason: 'no quote' });
  }

  const age = now - s.anchor.timestamp;
  if (age > 2 * s.policy.windowSecs) {
    alerts.push({
      severity: 'warn',
      code: 'anchor-stale',
      message: `anchor has not moved for ${Math.round(age / 3600)}h (window ${Math.round(s.policy.windowSecs / 3600)}h)`,
    });
  }

  if (s.raw !== undefined && s.raw !== s.quote) {
    const r = ratio(s.raw, s.quote);
    if (r > opts.divergenceAlert || r < 1 / opts.divergenceAlert) {
      alerts.push({
        severity: 'warn',
        code: 'clamp-binding',
        message: `upstreams say ${s.raw} but pools read ${s.quote} (${r.toFixed(3)}x): a real move being rate-limited, or manipulation`,
      });
    }
  }

  // A raw price far from the anchor is either a real revaluation or a pump. Poking would
  // walk the anchor towards it, so hold for a while before treating it as real.
  let since: number | undefined;
  if (s.raw !== undefined) {
    const r = ratio(s.raw, s.anchor.price);
    const upBounded = s.policy.upBpsPerHour !== UNBOUNDED;
    const downBounded = s.policy.downBpsPerHour !== UNBOUNDED;
    const suspicious = (upBounded && r > opts.holdRatio) || (downBounded && r < 1 / opts.holdRatio);
    if (suspicious) {
      since = suspiciousSince ?? now;
      const heldFor = now - since;
      if (heldFor < opts.maxHoldSecs) {
        alerts.push({
          severity: 'critical',
          code: 'suspicious-move',
          message: `raw price is ${r.toFixed(2)}x the anchor; holding pokes (${Math.round(heldFor / 60)} of ${Math.round(opts.maxHoldSecs / 60)} min)`,
        });
        return done({ kind: 'hold', reason: `raw ${r.toFixed(2)}x anchor` }, since);
      }
      alerts.push({
        severity: 'critical',
        code: 'hold-expired',
        message: `raw price has stayed ${r.toFixed(2)}x the anchor for ${Math.round(heldFor / 3600)}h; resuming pokes. Check the upstream markets.`,
      });
    }
  }

  if (age < MIN_POKE_SECS + opts.marginSecs) {
    return done({ kind: 'wait', reason: `anchor moved ${age}s ago` }, since);
  }
  return done({ kind: 'poke' }, since);
}
