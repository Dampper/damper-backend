<p align="center">
  <img src="https://raw.githubusercontent.com/Dampper/.github/main/profile/damper-wordmark.png" alt="Damper" width="420">
</p>

# Damper Backend

[![CI](https://github.com/Dampper/damper-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Dampper/damper-backend/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) ![Stellar](https://img.shields.io/badge/network-Stellar-informational)

Off-chain services for [Damper](https://github.com/Dampper/damper-contracts), a manipulation-resistant price oracle for Blend lending pools on Stellar.

More documentation:

- [Architecture](docs/ARCHITECTURE.md): the scanner and keeper pipelines
- [Environment](docs/ENVIRONMENT.md): variables and commands
- [Decision records](docs/adr/README.md): why it is built this way
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)

## Pool scanner

Reads every Blend V2 / V2.1 pool it can find on mainnet and asks, for each reserve: if the oracle could be made to report a false price for this asset, how much could leave the pool, and what would it cost to produce that price?

```sh
npm install
npm run scan                       # discover pools, scan, write reports/latest.json
npm run scan -- --pool C...        # scan specific pools
```

Environment: `DAMPER_RPC_URL` (default `https://mainnet.sorobanrpc.com`), `DAMPER_HORIZON_URL` (default `https://horizon.stellar.org`).

### How it works

1. **Discovery** ([`discovery.ts`](src/discovery.ts)). Pools can't be enumerated from contract storage and RPC nodes keep only about seven days of events, so pools are tracked in [`data/pools.json`](data/pools.json), which only grows. Each run adds the V2 and V2.1 backstop reward zones and any recent pool-factory `deploy` events.
2. **Price source resolution** ([`oracle.ts`](src/oracle.ts)). Most pools point at Blend's [oracle-aggregator](https://github.com/blend-capital/oracle-aggregator), which maps each asset to exactly one upstream feed. The scanner reads `asset_configs` and `oracles` to find, per asset: the upstream feed, its kind (Reflector Stellar DEX feed, Reflector CEX feed, or an operator-run feed with an admin key), and the `max_dev` setting.
3. **Market evidence** ([`market.ts`](src/market.ts)). For assets priced by Reflector's Stellar DEX feed, the scanner reads the SDEX order book against USDC and 24h volume from Horizon. Reflector's DEX feed is derived from trades, and printing a trade at price P requires first buying every ask below P, so the USDC needed to clear the book up to P is the capital needed to make the feed see P.
4. **Scoring** ([`score.ts`](src/score.ts)). Two directions per reserve:
   - *collateral side*: inflate the price, post it as collateral, borrow every other reserve's available liquidity;
   - *debt side*: deflate the price, borrow this reserve's available liquidity against too little collateral.

   Exposure is compared with the cost of a 10x move. Tiers: **critical** (exposure ≥ 10x cost, or < $1,000 daily volume with > $10,000 exposure), **high** (exposure > cost), **medium** (≥ 10% of cost), **low**, **external** (priced off-SDEX, not scored here).

### What the scanner checks that the pool doesn't

- **`max_dev` only looks one round back.** The aggregator compares the latest upstream price with the previous round (300 s on Reflector). A manipulated price held for two consecutive rounds passes, which is how the YieldBlox exploit got through. The scanner notes this on every asset that relies on it.
- **Fixed-price collateral.** Assets registered as aggregator base assets always price at exactly 1. When such an asset is also collateral, a depeg is invisible to the pool.

### First scan (mainnet, ledger 65,532,762, 2026-11-17)

| Pool | Status | Supplied | Borrowed | Worst tier | Notes |
|---|---|---|---|---|---|
| Fixed (V2) | on ice | $137.5M | $32.5M | external | XLM, USDC, EURC all priced from Reflector's CEX feed |
| Fixed v2.1 | admin active | $0.20M | $0.05M | external | Same feed setup as Fixed (V2) |
| YieldBlox (V2) | on ice | $0.14M | $0.04M | medium | USTRY is no longer collateral (cf 0). XLM is priced from the SDEX feed with `max_dev` disabled. PYUSD is collateral at cf 0.90 with a fixed $1 price. |
| Etherfuse | admin frozen | $0.02M | $0.001M | external | CETES, USTRY and TESOURO are priced by an operator-run feed (admin key `GDH3…AETH`, 24 h period) |

Two pools in the registry could not be scanned: one is a V1 pool (`CDE65QK2…`), the other's oracle reverts with `Error(Contract, #2)` (`CBYOBT7Z…`).

### Known limitations

- Pool discovery is incomplete for pools deployed more than about seven days before the first run and not in a reward zone. Historical discovery from ledger archives is planned.
- The order-book model ignores classic AMM liquidity pools and Soroban AMMs, which an attacker cannot use to print a manipulated trade but which can absorb it via arbitrage.
- Cost is capital required, not loss: the attacker keeps the asset they buy.
- Depeg risk for fixed-price collateral is flagged but not scored.

## Keeper

Keeps a [Damper oracle](https://github.com/Dampper/damper-contracts) healthy: pokes each asset's anchor when it is due, and reports what the pool cannot see for itself.

```sh
# dry run: read the oracle and report what it would do
npm run keeper -- --network testnet --oracle C... --once

# live: poke anchors every 5 minutes (the signer must be the oracle's keeper address)
DAMPER_KEEPER_SECRET=S... npm run keeper -- --network testnet --oracle C... --submit
```

The secret is read only from the environment and never printed. The keeper refuses to start if its key is not the oracle's configured keeper, since the contract would reject every poke.

Per asset, [`decide.ts`](src/keeper/decide.ts) returns one of:

| Action | When |
|---|---|
| `poke` | the anchor is older than the contract's 300 s minimum (plus a margin) and nothing looks wrong |
| `wait` | the anchor moved too recently |
| `hold` | the raw upstream price is more than 1.5x away from the anchor in a bounded direction. Poking would walk the anchor towards a possible pump, so pokes are held for up to 6 hours, after which the move is treated as real and pokes resume with a critical alert |
| `skip` | no policy, no seeded anchor, or no quote; all three are reported |

**Market evidence.** For an asset whose oracle has a cost gate, the keeper also publishes what it costs to move the price and what that would unlock, so the oracle can tighten its clamp where an attack would pay (see the [contracts README](https://github.com/Dampper/damper-contracts#readme)). Give it an exposure, from a live pool or one fixed number:

```sh
npm run keeper -- --network testnet --oracle C... --pool C...            # exposure from a Blend pool using the oracle
npm run keeper -- --network testnet --oracle C... --exposure-usd 50000   # one number for every asset
# --market-horizon URL reads order books from another Horizon (default: mainnet's)
```

Evidence is published when none exists or a third of its life is used. Cost comes from the asset's Stellar DEX order book against USDC ([decision record 0004](docs/adr/0004-evidence-from-the-order-book.md)). Assets with no DEX market get no evidence and stay on the oracle's tight rate.

Alerts, because a binding clamp looks like a normal price to the pool: `unseeded` and `no-quote` (the oracle returns nothing, so borrows revert), `suspicious-move`, `hold-expired`, `clamp-binding` (upstreams and quote differ by more than 2%), `anchor-stale`, `no-policy`, and for gated assets `evidence-stale` (the oracle is on its tight rate because no fresh evidence exists) and `gate-tight` (an attack in that direction would pay, so that direction is on its tight rate).

### Getting alerts to a person

Set `DAMPER_ALERT_WEBHOOK` to a Slack, Discord or generic webhook URL (it is a secret, so it is read only from the environment and is never printed beyond its host name):

```sh
DAMPER_ALERT_WEBHOOK=https://hooks.slack.com/services/... npm run keeper -- --oracle C... --webhook-format slack --test-alert   # check it works
DAMPER_ALERT_WEBHOOK=...  npm run keeper -- --oracle C... --webhook-format slack --alert-min warn --alert-reminder-hours 6 --submit
```

A new alert is sent once, one that persists is mentioned again after the reminder interval, and one that clears is reported as resolved. A delivery that fails is retried on the next pass, so a short outage loses nothing. The keeper reports itself too: `tick-failing` (critical) after three failed passes in a row, and `action-failed` when a poke or an evidence publish does not land. See [decision record 0005](docs/adr/0005-alert-delivery.md).

A keeper that dies outright cannot announce it, so it pings an external monitor after each healthy pass (`DAMPER_HEARTBEAT_URL`, for example a healthchecks.io check). The monitor alerts when the pings stop, which covers a crash, a hang and a lost host. A pass that failed does not ping. See [decision record 0006](docs/adr/0006-heartbeat.md).

`--status-file` writes a JSON snapshot of every asset's raw price, quote, anchor, policy, effective policy, evidence and alerts after each pass — the keeper is the only thing that can see a clamp binding or an anchor going stale, so the dashboard's status page reads this rather than the chain. See [decision record 0009](docs/adr/0009-oracle-status-report.md).

## Running the keeper

[`keeper.yml`](.github/workflows/keeper.yml) runs one keeper pass every 5 minutes on GitHub Actions — free for a public repository. Every CLI flag above also reads from an environment variable of the same shape (`DAMPER_ORACLE`, `DAMPER_SUBMIT`, ...), set as repository variables and secrets rather than built into an argument string; see [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md). Because each run is a fresh process, the "how long has this move looked suspicious" clock (ADR 0003) is persisted to its own `keeper-state` branch between runs instead of living in memory — see [decision record 0008](docs/adr/0008-github-actions-keeper.md).

[`render.yaml`](render.yaml) deploys the same keeper as a long-running Render Background Worker instead, which avoids the fresh-process problem above entirely, but Render has no free tier for one. It is left in the repository, not deployed; see [decision record 0007](docs/adr/0007-render-worker.md).

## Development

```sh
npm test          # vitest, no network (pool scoring, order-book math, keeper decisions)
npm run typecheck
```

## License

Apache-2.0
