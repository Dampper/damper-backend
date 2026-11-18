# Architecture

Two programs share one thin chain client: a **scanner** that reports on Blend pools, and a **keeper** that looks after a Damper oracle.

```
                    ┌──────────── scanner ────────────┐
 pool registry ───▶ │ discovery → load pool → resolve │ ──▶ reports/latest.json
 (data/pools.json)  │ price sources → market depth →  │      + console summary
                    │ score exposure vs cost          │
                    └──────────────────────────────────┘
                    ┌──────────── keeper ─────────────┐
 Damper oracle ───▶ │ read state → decide per asset → │ ──▶ poke tx, or a report
                    │ poke / wait / hold / skip       │
                    └──────────────────────────────────┘
```

## Scanner

| Step | File | What it does |
| --- | --- | --- |
| Discovery | [`discovery.ts`](src/discovery.ts) | Merges the V2 and V2.1 backstop reward zones and recent pool-factory `deploy` events into a registry that only grows ([ADR 0001](adr/0001-pool-registry-file.md)) |
| Load | [`scan.ts`](src/scan.ts) | Loads each pool, its reserves and oracle prices through the Blend SDK |
| Price source | [`oracle.ts`](src/oracle.ts) | For each reserve, reads Blend's oracle aggregator (`asset_configs`, `oracles`) to find the upstream feed, its kind, and the `max_dev` setting |
| Market | [`market.ts`](src/market.ts), [`assets.ts`](src/assets.ts) | For assets priced from the Stellar DEX, reads the SDEX order book and 24 h volume from Horizon; identifies the classic asset behind a token contract |
| Score | [`score.ts`](src/score.ts) | Exposure versus the capital needed to move the price ([ADR 0002](adr/0002-score-by-capital-to-clear-the-book.md)) |

Upstream feeds are classified by what is on-chain: the known Reflector DEX and CEX feeds, an **operator feed** (a feed with an admin key that pushes prices), or unknown. Only DEX-priced assets get a market model; the others are reported with the reason.

## Keeper

| Step | File | What it does |
| --- | --- | --- |
| Read | [`keeper/chain.ts`](src/keeper/chain.ts) | For every asset the oracle serves: policy, anchor, raw median and quote |
| Decide | [`keeper/decide.ts`](src/keeper/decide.ts) | Pure function returning `poke`, `wait`, `hold` or `skip` plus alerts ([ADR 0003](adr/0003-keeper-holds-on-suspicious-moves.md)) |
| Evidence | [`keeper/evidence.ts`](src/keeper/evidence.ts), [`market-evidence.ts`](src/keeper/market-evidence.ts) | For gated assets: reads the order book for the cost, a pool or a fixed number for the exposure, and builds the evidence. Repeats the contract's gate rule so alerts match what the oracle does ([ADR 0004](adr/0004-evidence-from-the-order-book.md)) |
| Act | [`keeper/run.ts`](src/keeper/run.ts), `chain.ts` | Simulates, signs and submits `poke` and `publish_evidence`, or reports in dry run |

`rpc.ts` does reads by simulating a call from a throwaway account, so no funded account is needed to read.

## Data

- `data/pools.json`: the pool registry, committed. Pools found only through events would otherwise be lost once the RPC forgets them.
- `reports/`: scan output, not committed.
