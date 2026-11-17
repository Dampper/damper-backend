# Damper — backend

Off-chain services for [Damper](https://github.com/UbsOrg/damper-contracts), a manipulation-resistant price oracle for Blend lending pools on Stellar.

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

## Keeper (M2)

Will publish per-asset manipulation-cost estimates to the Damper registry contract so the guarded oracle can tighten its clamp when a market is cheap to move.

## Alerts (M2)

Will flag anomalies on markets that feed lending-pool oracles: resting offers far from the market price, sudden depth withdrawal, and single trades that dominate a VWAP window.

## Development

```sh
npm test          # vitest, no network
npm run typecheck
```

## License

Apache-2.0
