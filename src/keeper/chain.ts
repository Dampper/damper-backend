import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { sep40Other, sep40Stellar, type Sep40Asset, type ViewClient } from '../rpc.js';
import { withRetry } from '../scan.js';
import type { AssetState } from './decide.js';

function assetScVal(a: Sep40Asset): xdr.ScVal {
  return a[0] === 'Stellar' ? sep40Stellar(a[1]) : sep40Other(a[1]);
}

export const assetKey = (a: Sep40Asset) => `${a[0]}:${a[1]}`;

interface RawPolicy {
  up_bps_per_hour: number;
  down_bps_per_hour: number;
  window_secs: bigint;
}
interface RawAnchor {
  price: bigint;
  timestamp: bigint;
}
interface RawPrice {
  price: bigint;
  timestamp: bigint;
}
interface RawGate {
  tight_up_bps_per_hour: number;
  tight_down_bps_per_hour: number;
  min_cost_ratio_bps: number;
  max_evidence_age: bigint;
}
interface RawEvidence {
  up_cost: bigint;
  up_exposure: bigint;
  down_cost: bigint;
  down_exposure: bigint;
  timestamp: bigint;
}

/** Everything the keeper needs to know about every asset the oracle serves. */
export async function readOracle(view: ViewClient, oracle: string) {
  const assets = await withRetry(() => view.call<Sep40Asset[]>(oracle, 'assets'));
  const keeper = await withRetry(() => view.call<string>(oracle, 'keeper'));
  const decimals = await withRetry(() => view.call<number>(oracle, 'decimals'));
  const states: { key: string; asset: Sep40Asset; state: AssetState }[] = [];
  for (const asset of assets) {
    const arg = [assetScVal(asset)];
    // A read that fails must fail the pass. Swallowing the error would make a gated asset look
    // ungated and silently drop its alerts. Transport errors are retried; a contract error is not.
    const read = <T>(method: string) => withRetry(() => view.call<T | null>(oracle, method, arg));
    const [policy, effectivePolicy, anchor, raw, quote, gate, evidence] = await Promise.all([
      read<RawPolicy>('policy'),
      read<RawPolicy>('effective_policy'),
      read<RawAnchor>('anchor'),
      read<RawPrice>('raw_price'),
      read<RawPrice>('lastprice'),
      read<RawGate>('gate'),
      read<RawEvidence>('evidence'),
    ]);
    states.push({
      key: assetKey(asset),
      asset,
      state: {
        asset: assetKey(asset),
        policy: policy
          ? {
              upBpsPerHour: policy.up_bps_per_hour,
              downBpsPerHour: policy.down_bps_per_hour,
              windowSecs: Number(policy.window_secs),
            }
          : undefined,
        effectivePolicy: effectivePolicy
          ? {
              upBpsPerHour: effectivePolicy.up_bps_per_hour,
              downBpsPerHour: effectivePolicy.down_bps_per_hour,
              windowSecs: Number(effectivePolicy.window_secs),
            }
          : undefined,
        anchor: anchor ? { price: anchor.price, timestamp: Number(anchor.timestamp) } : undefined,
        raw: raw?.price,
        quote: quote?.price,
        decimals,
        gate: gate
          ? {
              tightUpBpsPerHour: gate.tight_up_bps_per_hour,
              tightDownBpsPerHour: gate.tight_down_bps_per_hour,
              minCostRatioBps: gate.min_cost_ratio_bps,
              maxEvidenceAge: Number(gate.max_evidence_age),
            }
          : undefined,
        evidence: evidence
          ? {
              upCost: evidence.up_cost,
              upExposure: evidence.up_exposure,
              downCost: evidence.down_cost,
              downExposure: evidence.down_exposure,
              timestamp: Number(evidence.timestamp),
            }
          : undefined,
      },
    });
  }
  return { keeper, decimals, states };
}

export interface PokeResult {
  hash: string;
  ledger: number | undefined;
}

/** Simulate, sign and submit one contract call, then wait for it to land. */
async function submitInvoke(
  view: ViewClient,
  signer: Keypair,
  oracle: string,
  method: string,
  args: xdr.ScVal[],
): Promise<PokeResult> {
  const account = await view.server.getAccount(signer.publicKey());
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: view.network.passphrase,
  })
    .addOperation(new Contract(oracle).call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await view.server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} simulation failed: ${sim.error}`);
  const tx = rpc.assembleTransaction(built, sim).build();
  tx.sign(signer);

  const sent = await view.server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`${method} rejected: ${sent.errorResult?.toXDR('base64')}`);
  const final = await view.server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${method} ${sent.hash} ended ${final.status}`);
  }
  return { hash: sent.hash, ledger: final.ledger };
}

export function submitPoke(view: ViewClient, signer: Keypair, oracle: string, asset: Sep40Asset) {
  return submitInvoke(view, signer, oracle, 'poke', [assetScVal(asset)]);
}

export function submitEvidence(
  view: ViewClient,
  signer: Keypair,
  oracle: string,
  asset: Sep40Asset,
  e: { upCost: bigint; upExposure: bigint; downCost: bigint; downExposure: bigint },
) {
  const i128 = (v: bigint) => nativeToScVal(v, { type: 'i128' });
  return submitInvoke(view, signer, oracle, 'publish_evidence', [
    assetScVal(asset),
    i128(e.upCost),
    i128(e.upExposure),
    i128(e.downCost),
    i128(e.downExposure),
  ]);
}
