import { readFile, writeFile } from 'node:fs/promises';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import { BLEND_DEPLOYMENTS } from './config.js';
import type { ViewClient } from './rpc.js';

/**
 * Blend pools can't be enumerated from contract storage, and RPC nodes only keep about
 * seven days of events. The registry is a JSON file that only grows: each run merges
 * in the backstop reward zones and whatever pool-factory `deploy` events the RPC still
 * has, on top of a seed list of known pools.
 */
export interface PoolRegistry {
  updatedAt: string;
  pools: Record<string, { deployment: string; source: string; firstSeen: string }>;
}

export async function loadRegistry(path: string): Promise<PoolRegistry> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PoolRegistry;
  } catch {
    return { updatedAt: new Date(0).toISOString(), pools: {} };
  }
}

export async function saveRegistry(path: string, registry: PoolRegistry) {
  const sorted = Object.fromEntries(Object.entries(registry.pools).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, JSON.stringify({ ...registry, pools: sorted }, null, 2) + '\n');
}

export async function discoverPools(view: ViewClient, registry: PoolRegistry): Promise<string[]> {
  const now = new Date().toISOString();
  const add = (id: string, deployment: string, source: string) => {
    if (!registry.pools[id]) registry.pools[id] = { deployment, source, firstSeen: now };
  };

  for (const d of BLEND_DEPLOYMENTS) {
    const zone = (await view.tryCall<string[]>(d.backstop, 'reward_zone')) ?? [];
    zone.forEach((id) => add(id, d.name, 'reward_zone'));
    for (const id of await recentDeploys(view, d.poolFactory)) add(id, d.name, 'factory_event');
  }

  registry.updatedAt = now;
  return Object.keys(registry.pools);
}

/** Pool addresses from the factory's `deploy` events still inside the RPC retention window. */
async function recentDeploys(view: ViewClient, factory: string): Promise<string[]> {
  const latest = await view.server.getLatestLedger();
  // Stay a little inside the ~7 day (120,960 ledger) retention window.
  const startLedger = Math.max(1, latest.sequence - 120_000);
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const req = {
      filters: [
        {
          type: 'contract' as const,
          contractIds: [factory],
          topics: [[xdr.ScVal.scvSymbol('deploy').toXDR('base64')]],
        },
      ],
      limit: 200,
    };
    const res = cursor
      ? await view.server.getEvents({ ...req, cursor })
      : await view.server.getEvents({ ...req, startLedger });
    for (const ev of res.events) {
      const data = scValToNative(ev.value);
      if (typeof data === 'string' && data.startsWith('C')) out.push(data);
      else if (data instanceof Address) out.push(data.toString());
    }
    if (res.events.length < 200) break;
    cursor = res.cursor;
  }
  return out;
}
