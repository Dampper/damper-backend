import { Keypair } from '@stellar/stellar-sdk';
import { MAINNET, type Network } from '../config.js';
import { tick, type TickReport } from '../keeper/run.js';
import { fixedExposure, poolExposure } from '../keeper/market-evidence.js';
import { Heartbeat } from '../keeper/heartbeat.js';
import { NOTIFY_DEFAULTS, Notifier, parseWebhookUrl, type WebhookFormat } from '../keeper/notify.js';
import { loadState, saveState, toMap } from '../keeper/state.js';
import { writeFile } from 'node:fs/promises';
import { resolveConfig } from './keeperConfig.js';

const values = resolveConfig(process.argv.slice(2), process.env);

// The secret and the Telegram chat id are not ordinary flags (no `--secret`, read only from
// the environment so they never show up in `ps`, logs or a saved command line).
const env = (name: string) => process.env[name] || undefined;

const TESTNET: Network = {
  rpc: 'https://soroban-testnet.stellar.org',
  passphrase: 'Test SDF Network ; September 2015',
  horizon: 'https://horizon-testnet.stellar.org',
};

function printReport(r: TickReport) {
  const time = new Date(r.at * 1000).toISOString();
  for (const row of r.rows) {
    const tail = row.poke
      ? ` tx ${row.poke.hash.slice(0, 12)}… ledger ${row.poke.ledger}`
      : row.error
        ? ` ERROR ${row.error}`
        : row.detail
          ? ` (${row.detail})`
          : '';
    console.log(`${time} ${row.asset.padEnd(24)} ${row.action.toUpperCase()}${tail}`);
    if (row.evidence) {
      const tx = row.evidence.tx ? ` tx ${row.evidence.tx.hash.slice(0, 12)}… ledger ${row.evidence.tx.ledger}` : '';
      console.log(`    evidence ${row.evidence.status}: ${row.evidence.detail}${tx}`);
    }
    for (const a of row.alerts) console.log(`    [${a.severity}] ${a.code}: ${a.message}`);
  }
}

async function main() {
  if (!values.oracle) throw new Error('--oracle <contract id> (or DAMPER_ORACLE) is required');
  const base = values.network === 'testnet' ? TESTNET : MAINNET;
  const network = values.rpc ? { ...base, rpc: values.rpc } : base;

  // The secret never appears in arguments, logs or reports.
  let signer: Keypair | undefined;
  if (values.submit) {
    const secret = process.env.DAMPER_KEEPER_SECRET;
    if (!secret) throw new Error('--submit needs DAMPER_KEEPER_SECRET in the environment');
    signer = Keypair.fromSecret(secret);
    console.log(`keeper ${signer.publicKey()} on ${values.network}`);
  } else {
    console.log('dry run: reporting only (pass --submit with DAMPER_KEEPER_SECRET to poke)');
  }

  // Evidence needs to know what an attacker could take: from a live pool, or one fixed number.
  let evidence;
  if (values.pool || values['exposure-usd']) {
    const fixed = values['exposure-usd'] ? Number(values['exposure-usd']) : undefined;
    if (fixed !== undefined && !(fixed >= 0)) throw new Error('--exposure-usd must be a non-negative number');
    evidence = {
      marketHorizon: values['market-horizon'] ?? MAINNET.horizon,
      exposure: async () => (fixed !== undefined ? fixedExposure(fixed) : poolExposure(network, values.pool!)),
    };
  }

  // Alerts reach a person through a webhook. The URL is a secret, so it comes from the
  // environment only and is never printed.
  let notifier: Notifier | undefined;
  const hook = process.env.DAMPER_ALERT_WEBHOOK;
  if (hook) {
    const format = values['webhook-format'] as WebhookFormat;
    if (!['json', 'slack', 'discord', 'telegram'].includes(format)) throw new Error('--webhook-format must be json, slack, discord or telegram');
    const min = values['alert-min'];
    if (min !== 'critical' && min !== 'warn' && min !== 'info') throw new Error('--alert-min must be critical, warn or info');
    const hours = Number(values['alert-reminder-hours']);
    if (!(hours > 0)) throw new Error('--alert-reminder-hours must be a positive number');
    const telegramChatId = env('DAMPER_TELEGRAM_CHAT_ID');
    if (format === 'telegram' && !telegramChatId) throw new Error('--webhook-format telegram needs DAMPER_TELEGRAM_CHAT_ID in the environment');
    const url = parseWebhookUrl(hook);
    notifier = new Notifier(url, format, { network: values.network!, oracle: values.oracle, telegramChatId }, { ...NOTIFY_DEFAULTS, minSeverity: min, reminderSecs: hours * 3600 });
    console.log(`alerts: ${min} and above go to ${url.host} (${format}), reminders every ${hours} h`);
  } else if (values['test-alert']) {
    throw new Error('--test-alert needs DAMPER_ALERT_WEBHOOK in the environment');
  } else {
    console.log('alerts: log only (set DAMPER_ALERT_WEBHOOK to send them to a channel)');
  }
  if (values['test-alert']) {
    await notifier!.test(Math.floor(Date.now() / 1000));
    console.log('test alert delivered');
    return;
  }

  // A dead keeper cannot announce itself, so it pings an external monitor after each healthy
  // pass and the monitor alerts on silence. The URL is a secret: environment only.
  let heartbeat: Heartbeat | undefined;
  const beat = process.env.DAMPER_HEARTBEAT_URL;
  if (beat) {
    heartbeat = Heartbeat.fromUrl(beat);
    console.log(`heartbeat: pinging ${heartbeat.host} after each healthy pass`);
  } else if (values['test-heartbeat']) {
    throw new Error('--test-heartbeat needs DAMPER_HEARTBEAT_URL in the environment');
  } else {
    console.log('heartbeat: none (set DAMPER_HEARTBEAT_URL so a dead keeper is noticed)');
  }
  if (values['test-heartbeat']) {
    await heartbeat!.ping();
    console.log('test heartbeat delivered');
    return;
  }

  // How long each asset's move has looked suspicious (ADR 0003) lives in this map. A
  // long-running process keeps it for free; a process that restarts every pass (a scheduled
  // job, a crash) does not, so a hold could never expire without reading it back here (ADR
  // 0008). Without --state this is exactly the old in-memory-only behaviour.
  const suspicious = values.state ? toMap(await loadState(values.state)) : new Map<string, number>();
  const every = Math.max(60, Number(values.interval)) * 1000;
  for (;;) {
    let report: TickReport | undefined;
    let failure: string | undefined;
    try {
      report = await tick({ network, oracle: values.oracle, signer, evidence }, suspicious);
      printReport(report);
    } catch (e) {
      failure = (e as Error).message;
      console.error(`tick failed: ${failure}`);
      if (values.once) process.exitCode = 1;
    }
    await notifier?.afterPass(report, failure, Math.floor(Date.now() / 1000));
    await heartbeat?.afterPass(report, failure);
    if (values['status-file'] && report?.status) {
      await writeFile(values['status-file'], JSON.stringify(report.status, null, 2) + '\n').catch((e) =>
        console.error(`could not write --status-file: ${(e as Error).message}`),
      );
    }
    if (values.state) {
      await saveState(values.state, suspicious).catch((e) => console.error(`could not save --state: ${(e as Error).message}`));
    }
    if (values.once) return;
    await new Promise((r) => setTimeout(r, every));
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
