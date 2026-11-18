import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { MAINNET } from '../config.js';
import { ViewClient } from '../rpc.js';
import { readFile } from 'node:fs/promises';
import { discoverPools, loadRegistry, mergeRegistry, saveRegistry } from '../discovery.js';
import { scan, type PoolReport } from '../scan.js';

const { values } = parseArgs({
  options: {
    registry: { type: 'string', default: 'data/pools.json' },
    out: { type: 'string', default: 'reports/latest.json' },
    pool: { type: 'string', multiple: true },
    'merge-from': { type: 'string' },
  },
});

const usd = (n: number | undefined) =>
  n === undefined ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;

async function main() {
  const view = new ViewClient(MAINNET);
  let ids = values.pool ?? [];
  if (ids.length === 0) {
    let registry = await loadRegistry(values.registry!);
    if (values['merge-from']) registry = await mergeFrom(registry, values['merge-from']);
    ids = await discoverPools(view, registry);
    await saveRegistry(values.registry!, registry);
  }

  const report = await scan(ids);
  await mkdir(dirname(values.out!), { recursive: true });
  await writeFile(values.out!, JSON.stringify(report, null, 2) + '\n');

  console.log(`Scanned ${report.pools.length} pools at ledger ${report.ledger}\n`);
  for (const p of report.pools) printPool(p);
  if (report.errors.length) {
    console.log(`\nSkipped ${report.errors.length}:`);
    for (const e of report.errors) console.log(`  ${e.pool}  ${e.error.slice(0, 120)}`);
  }
  console.log(`\nFull report: ${values.out}`);
}

/** Merge a previously published registry (URL or file) so pools seen on earlier runs are never lost. */
async function mergeFrom(registry: Awaited<ReturnType<typeof loadRegistry>>, source: string) {
  try {
    const text = /^https?:/.test(source) ? await (await fetch(source)).text() : await readFile(source, 'utf8');
    const merged = mergeRegistry(registry, JSON.parse(text));
    console.log(`merged registry from ${source}: ${Object.keys(registry.pools).length} -> ${Object.keys(merged.pools).length} pools`);
    return merged;
  } catch (e) {
    console.log(`could not merge registry from ${source}: ${(e as Error).message}`);
    return registry;
  }
}

function printPool(p: PoolReport) {
  console.log(
    `${p.tier.toUpperCase().padEnd(9)} ${p.name} (${p.id.slice(0, 8)}…)  ${p.status}  ` +
      `supplied ${usd(p.supplyUsd)}  borrowed ${usd(p.borrowedUsd)}`,
  );
  for (const r of p.reserves) {
    const c = r.collateralSide;
    const d = r.debtSide;
    console.log(
      `    ${r.symbol.padEnd(7)} cf ${r.collateralFactor.toFixed(2)}  ` +
        `collateral: ${c.tier} (exposure ${usd(c.exposureUsd)} vs cost ${usd(c.costUsd)})  ` +
        `debt: ${d.tier} (exposure ${usd(d.exposureUsd)} vs cost ${usd(d.costUsd)})  ` +
        `vol24h ${usd(r.market?.volume24hUsd)}`,
    );
    for (const n of r.notes) console.log(`        · ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
