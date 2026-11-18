import { Keypair } from '@stellar/stellar-sdk';
import { parseArgs } from 'node:util';
import { MAINNET, type Network } from '../config.js';
import { tick, type TickReport } from '../keeper/run.js';

const { values } = parseArgs({
  options: {
    oracle: { type: 'string' },
    network: { type: 'string', default: 'mainnet' },
    rpc: { type: 'string' },
    once: { type: 'boolean', default: false },
    interval: { type: 'string', default: '300' },
    submit: { type: 'boolean', default: false },
  },
});

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
    for (const a of row.alerts) console.log(`    [${a.severity}] ${a.code}: ${a.message}`);
  }
}

async function main() {
  if (!values.oracle) throw new Error('--oracle <contract id> is required');
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

  const suspicious = new Map<string, number>();
  const every = Math.max(60, Number(values.interval)) * 1000;
  for (;;) {
    try {
      printReport(await tick({ network, oracle: values.oracle, signer }, suspicious));
    } catch (e) {
      console.error(`tick failed: ${(e as Error).message}`);
      if (values.once) process.exitCode = 1;
    }
    if (values.once) return;
    await new Promise((r) => setTimeout(r, every));
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
