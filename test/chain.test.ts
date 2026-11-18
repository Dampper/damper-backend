import { describe, expect, it } from 'vitest';
import { readOracle } from '../src/keeper/chain.js';
import type { ViewClient } from '../src/rpc.js';

const ASSET = ['Stellar', 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'];
const GATE = { tight_up_bps_per_hour: 50, tight_down_bps_per_hour: 4294967295, min_cost_ratio_bps: 20000, max_evidence_age: 3600n };

/** A fake chain: answers each oracle view, with failures injected by the test. */
function fakeView(failures: Record<string, string[]> = {}): ViewClient {
  const answers: Record<string, unknown> = {
    assets: [ASSET],
    keeper: 'GKEEPER',
    decimals: 7,
    policy: { up_bps_per_hour: 500, down_bps_per_hour: 4294967295, window_secs: 86400n },
    anchor: { price: 10_600_000n, timestamp: 1000n },
    raw_price: { price: 10_600_000n, timestamp: 1000n },
    lastprice: { price: 10_600_000n, timestamp: 1000n },
    gate: GATE,
    evidence: null,
  };
  return {
    call: async (_c: string, method: string) => {
      const queued = failures[method];
      if (queued?.length) throw new Error(queued.shift()!);
      return answers[method];
    },
  } as unknown as ViewClient;
}

describe('readOracle', () => {
  it('reads the gate, evidence and decimals into the asset state', async () => {
    const { states, decimals } = await readOracle(fakeView(), 'CORACLE');
    expect(decimals).toBe(7);
    expect(states[0]!.state.gate).toEqual({ tightUpBpsPerHour: 50, tightDownBpsPerHour: 4294967295, minCostRatioBps: 20000, maxEvidenceAge: 3600 });
    expect(states[0]!.state.evidence).toBeUndefined();
  });

  it('retries a transport failure instead of treating the asset as ungated', async () => {
    const { states } = await readOracle(fakeView({ gate: ['fetch failed'] }), 'CORACLE');
    expect(states[0]!.state.gate).toBeDefined();
  });

  it('fails the pass on a contract error rather than silently dropping the read', async () => {
    await expect(readOracle(fakeView({ gate: ['HostError: Error(Contract, #6)'] }), 'CORACLE')).rejects.toThrow(/Contract, #6/);
  });
});
