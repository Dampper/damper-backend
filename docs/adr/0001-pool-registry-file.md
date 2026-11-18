# 0001. Keep a persisted pool registry

Status: accepted, 2026-11-17

## Context

Blend pools cannot be listed from contract storage. The V2 backstop's reward zone was empty when we looked, and the V2.1 one held a single pool. The pool factory emits a `deploy` event per pool, but Soroban RPC nodes keep only about seven days of events (the oldest ledger is about 120,000 behind the latest), so a pool deployed earlier and outside a reward zone is invisible to a fresh run.

## Decision

Pools are tracked in `data/pools.json`, which is committed and only grows. Each run adds the reward zones of both backstops and any factory `deploy` events still on the RPC, on top of a seed list from Blend's deployment file and public ecosystem registries.

## Consequences

- A pool seen once is never lost.
- Pools deployed before the first run and absent from every seed are missed. The README says so, and historical backfill from ledger archives is on the roadmap.
- A seed address can turn out not to be a current V2 pool. Such entries fail to load and are reported as skipped, not hidden.
