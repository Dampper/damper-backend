import type { ViewClient } from './rpc.js';
import type { ClassicAsset } from './market.js';

export interface TokenInfo {
  contract: string;
  symbol: string;
  /** Set when the token is a Stellar Asset Contract wrapping a classic asset. */
  classic: ClassicAsset | undefined;
}

const cache = new Map<string, TokenInfo>();

/**
 * A Stellar Asset Contract's `name()` is "CODE:ISSUER", or "native" for XLM.
 * Anything else is a custom Soroban token with no SDEX market of its own.
 */
export function parseSacName(name: string): ClassicAsset | undefined {
  if (name === 'native') return { code: 'XLM', issuer: undefined };
  const m = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
  return m ? { code: m[1]!, issuer: m[2]! } : undefined;
}

export async function tokenInfo(view: ViewClient, contract: string): Promise<TokenInfo> {
  const hit = cache.get(contract);
  if (hit) return hit;
  const name = (await view.tryCall<string>(contract, 'name')) ?? '';
  const classic = parseSacName(name);
  const symbol = classic?.code ?? (await view.tryCall<string>(contract, 'symbol')) ?? contract.slice(0, 6);
  const info = { contract, symbol, classic };
  cache.set(contract, info);
  return info;
}
