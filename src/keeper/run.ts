import { Keypair } from '@stellar/stellar-sdk';
import type { Network } from '../config.js';
import { ViewClient } from '../rpc.js';
import { DEFAULTS, decide, type Alert, type Options } from './decide.js';
import { readOracle, submitEvidence, submitPoke } from './chain.js';
import { buildEvidence, describeAmount, shouldPublish } from './evidence.js';
import { depthFor, type ExposureSource } from './market-evidence.js';
import { assetStatus, buildStatusReport, type StatusReport } from './status.js';

export interface KeeperConfig {
  network: Network;
  oracle: string;
  /** Without a signer the keeper only reports what it would do. */
  signer: Keypair | undefined;
  options?: Options;
  log?: (line: string) => void;
  /**
   * Market evidence for assets that have a cost gate. Without it the keeper still pokes, and
   * reports that the gate has no fresh evidence.
   */
  evidence?: {
    /** Horizon to read SDEX order books from; the market that matters may be mainnet's even when the oracle is not. */
    marketHorizon: string;
    exposure: () => Promise<ExposureSource>;
  };
}

export interface TickReport {
  at: number;
  /** What the oracle reports for every asset right now, for a status page. Omitted when the pass itself failed before reading the oracle. */
  status?: StatusReport;
  rows: {
    asset: string;
    action: string;
    detail: string;
    alerts: Alert[];
    poke?: { hash: string; ledger: number | undefined };
    evidence?: { status: 'published' | 'would-publish' | 'fresh' | 'skipped'; detail: string; tx?: { hash: string; ledger: number | undefined } };
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
  const { keeper, decimals, states } = await readOracle(view, cfg.oracle);
  const exposure = cfg.evidence && states.some((x) => x.state.gate) ? await cfg.evidence.exposure() : undefined;
  const report: TickReport = { at: now, rows: [] };
  const statuses: ReturnType<typeof assetStatus>[] = [];

  if (cfg.signer && cfg.signer.publicKey() !== keeper) {
    throw new Error(
      `signer ${cfg.signer.publicKey()} is not the oracle's keeper (${keeper}); pokes would be rejected`,
    );
  }

  for (const { key, asset, state } of states) {
    let evidenceRow: EvidenceOutcome | undefined;
    let evidenceError: string | undefined;
    if (state.gate && cfg.evidence && exposure) {
      try {
        evidenceRow = await publishEvidence(cfg, view, asset, state, exposure, decimals, now);
        if (evidenceRow.status === 'published') {
          // reflect what was just published in this pass's alerts
          state.evidence = evidenceRow.values ? { ...evidenceRow.values, timestamp: now } : state.evidence;
        }
      } catch (e) {
        evidenceError = `evidence: ${(e as Error).message.slice(0, 250)}`;
      }
    }
    const d = decide(state, now, suspicious.get(key), cfg.options ?? DEFAULTS);
    if (d.suspiciousSince === undefined) suspicious.delete(key);
    else suspicious.set(key, d.suspiciousSince);

    const row: TickReport['rows'][number] = {
      asset: key,
      action: d.action.kind,
      detail: 'reason' in d.action ? d.action.reason : '',
      alerts: d.alerts,
      evidence: evidenceRow ? { status: evidenceRow.status, detail: evidenceRow.detail, tx: evidenceRow.tx } : undefined,
      error: evidenceError,
    };
    if (d.action.kind === 'poke') {
      if (cfg.signer) {
        try {
          row.poke = await submitPoke(view, cfg.signer, cfg.oracle, asset);
        } catch (e) {
          row.error = [row.error, (e as Error).message.slice(0, 300)].filter(Boolean).join(' | ');
        }
      } else {
        row.detail = 'dry run: not submitted';
      }
    }
    report.rows.push(row);
    statuses.push(assetStatus(state, d.alerts));
  }
  const networkLabel = cfg.network.passphrase.includes('Test') ? 'testnet' : 'mainnet';
  report.status = buildStatusReport(networkLabel, cfg.oracle, statuses, now);
  return report;
}

type EvidenceOutcome = NonNullable<TickReport['rows'][number]['evidence']> & {
  values?: { upCost: bigint; upExposure: bigint; downCost: bigint; downExposure: bigint };
};

/** Publish fresh evidence for one gated asset when it is due. Says why when it cannot. */
async function publishEvidence(
  cfg: KeeperConfig,
  view: ViewClient,
  asset: Parameters<typeof depthFor>[2],
  state: Parameters<typeof decide>[0],
  exposure: ExposureSource,
  decimals: number,
  now: number,
): Promise<EvidenceOutcome> {
  const gate = state.gate!;
  if (!shouldPublish(gate, state.evidence, now)) {
    return { status: 'fresh', detail: `published ${Math.round((now - state.evidence!.timestamp) / 60)} min ago` };
  }
  if (asset[0] !== 'Stellar') return { status: 'skipped', detail: 'not a Stellar asset' };
  const ex = exposure(asset[1]);
  if (!ex) return { status: 'skipped', detail: 'no exposure known for this asset (not a reserve of the pool)' };
  const { depth, reason } = await depthFor(view, cfg.evidence!.marketHorizon, asset);
  const values = buildEvidence({ depth, external: false, upExposureUsd: ex.up, downExposureUsd: ex.down, decimals });
  if (!values) return { status: 'skipped', detail: `no market model: ${reason ?? 'unknown'}` };

  const d = `up: ${describeAmount(values.upCost, decimals)} to move vs ${describeAmount(values.upExposure, decimals)} unlocked; down: ${describeAmount(values.downCost, decimals)} vs ${describeAmount(values.downExposure, decimals)}`;
  if (!cfg.signer) return { status: 'would-publish', detail: `dry run, ${d}`, values };
  const tx = await submitEvidence(view, cfg.signer, cfg.oracle, asset, values);
  return { status: 'published', detail: d, tx, values };
}
