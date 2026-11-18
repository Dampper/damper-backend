import { Keypair } from '@stellar/stellar-sdk';
import type { Network } from '../config.js';
import { ViewClient } from '../rpc.js';
import { DEFAULTS, decide, type Alert, type Options } from './decide.js';
import { readOracle, submitPoke } from './chain.js';

export interface KeeperConfig {
  network: Network;
  oracle: string;
  /** Without a signer the keeper only reports what it would do. */
  signer: Keypair | undefined;
  options?: Options;
  log?: (line: string) => void;
}

export interface TickReport {
  at: number;
  rows: {
    asset: string;
    action: string;
    detail: string;
    alerts: Alert[];
    poke?: { hash: string; ledger: number | undefined };
    error?: string;
  }[];
}

/**
 * One pass over every asset the oracle serves. `suspicious` carries, across passes, when
 * each asset first looked suspicious, so a pump is held for a bounded time and not for ever.
 */
export async function tick(
  cfg: KeeperConfig,
  suspicious: Map<string, number>,
  now = Math.floor(Date.now() / 1000),
): Promise<TickReport> {
  const view = new ViewClient(cfg.network);
  const { keeper, states } = await readOracle(view, cfg.oracle);
  const report: TickReport = { at: now, rows: [] };

  if (cfg.signer && cfg.signer.publicKey() !== keeper) {
    throw new Error(
      `signer ${cfg.signer.publicKey()} is not the oracle's keeper (${keeper}); pokes would be rejected`,
    );
  }

  for (const { key, asset, state } of states) {
    const d = decide(state, now, suspicious.get(key), cfg.options ?? DEFAULTS);
    if (d.suspiciousSince === undefined) suspicious.delete(key);
    else suspicious.set(key, d.suspiciousSince);

    const row: TickReport['rows'][number] = {
      asset: key,
      action: d.action.kind,
      detail: 'reason' in d.action ? d.action.reason : '',
      alerts: d.alerts,
    };
    if (d.action.kind === 'poke') {
      if (cfg.signer) {
        try {
          row.poke = await submitPoke(view, cfg.signer, cfg.oracle, asset);
        } catch (e) {
          row.error = (e as Error).message.slice(0, 300);
        }
      } else {
        row.detail = 'dry run: not submitted';
      }
    }
    report.rows.push(row);
  }
  return report;
}
