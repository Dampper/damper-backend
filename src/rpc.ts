import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { Network } from './config.js';

/**
 * Read-only contract calls via simulation. No account or signature is needed: the
 * source is a throwaway keypair and the transaction is never submitted.
 */
export class ViewClient {
  readonly server: rpc.Server;
  private readonly source = new Account(Keypair.random().publicKey(), '0');

  constructor(readonly network: Network) {
    this.server = new rpc.Server(network.rpc, { allowHttp: network.rpc.startsWith('http://') });
  }

  async call<T = unknown>(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T> {
    const tx = new TransactionBuilder(this.source, {
      fee: BASE_FEE,
      networkPassphrase: this.network.passphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new ViewError(contractId, method, sim.error);
    }
    if (!sim.result) {
      throw new ViewError(contractId, method, 'no result');
    }
    return scValToNative(sim.result.retval) as T;
  }

  /** Like `call`, but returns undefined instead of throwing. */
  async tryCall<T = unknown>(contractId: string, method: string, args: xdr.ScVal[] = []) {
    try {
      return await this.call<T>(contractId, method, args);
    } catch {
      return undefined;
    }
  }
}

export class ViewError extends Error {
  constructor(
    readonly contractId: string,
    readonly method: string,
    detail: string,
  ) {
    super(`${method} on ${contractId} failed: ${detail.slice(0, 300)}`);
  }
}

/** SEP-40 `Asset::Stellar(address)` as an ScVal. */
export function sep40Stellar(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(address).toScVal()]);
}

/** SEP-40 `Asset::Other(symbol)` as an ScVal. */
export function sep40Other(symbol: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(symbol)]);
}

/** Decoded SEP-40 asset, as `scValToNative` returns it: ['Stellar', 'C...'] or ['Other', 'XLM']. */
export type Sep40Asset = ['Stellar', string] | ['Other', string];

export function sep40Key(asset: Sep40Asset): string {
  return `${asset[0]}:${asset[1]}`;
}
