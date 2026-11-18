import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { sep40Other, sep40Stellar, type Sep40Asset, type ViewClient } from '../rpc.js';
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

/** Everything the keeper needs to know about every asset the oracle serves. */
export async function readOracle(view: ViewClient, oracle: string) {
  const assets = await view.call<Sep40Asset[]>(oracle, 'assets');
  const keeper = await view.call<string>(oracle, 'keeper');
  const states: { key: string; asset: Sep40Asset; state: AssetState }[] = [];
  for (const asset of assets) {
    const arg = [assetScVal(asset)];
    const [policy, anchor, raw, quote] = await Promise.all([
      view.tryCall<RawPolicy | null>(oracle, 'policy', arg),
      view.tryCall<RawAnchor | null>(oracle, 'anchor', arg),
      view.tryCall<RawPrice | null>(oracle, 'raw_price', arg),
      view.tryCall<RawPrice | null>(oracle, 'lastprice', arg),
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
        anchor: anchor ? { price: anchor.price, timestamp: Number(anchor.timestamp) } : undefined,
        raw: raw?.price,
        quote: quote?.price,
      },
    });
  }
  return { keeper, states };
}

export interface PokeResult {
  hash: string;
  ledger: number | undefined;
}

/** Simulate, sign and submit `poke(asset)`, then wait for it to land. */
export async function submitPoke(
  view: ViewClient,
  signer: Keypair,
  oracle: string,
  asset: Sep40Asset,
): Promise<PokeResult> {
  const account = await view.server.getAccount(signer.publicKey());
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: view.network.passphrase,
  })
    .addOperation(new Contract(oracle).call('poke', assetScVal(asset)))
    .setTimeout(60)
    .build();

  const sim = await view.server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`poke simulation failed: ${sim.error}`);
  const tx = rpc.assembleTransaction(built, sim).build();
  tx.sign(signer);

  const sent = await view.server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`poke rejected: ${sent.errorResult?.toXDR('base64')}`);
  const final = await view.server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`poke ${sent.hash} ended ${final.status}`);
  }
  return { hash: sent.hash, ledger: final.ledger };
}
