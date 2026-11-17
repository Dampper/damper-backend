# Damper — backend

Off-chain services for [Damper](https://github.com/UbsOrg/damper-contracts), a manipulation-resistant price oracle for Blend lending pools on Stellar.

## Components

### Pool scanner (M1)

Reads every Blend V2 pool on mainnet and scores how cheaply each one could be drained through a manipulated price:

- the pool's reserves, collateral factors, supply caps and configured oracle
- for each collateral asset, the upstream market its oracle prices from, and that market's recent volume and order-book depth
- an estimated *cost to move the price* versus the *amount the pool would lend against the moved price*

The February 2026 YieldBlox loss (about $10.2M) came from exactly this gap: a collateral asset priced from a market with almost no volume. The scanner makes that gap visible for every pool before someone else finds it.

### Keeper (M2)

Publishes per-asset manipulation-cost estimates to the Damper registry contract, computed from SDEX order books and AMM pool reserves (Soroswap, Aquarius, Stellar classic liquidity pools).

### Alerts (M2)

Flags anomalies on markets that feed lending-pool oracles: resting offers far from the market price, sudden depth withdrawal, and single trades that dominate a VWAP window.

## Status

Design stage. The scanner is the first deliverable; see the roadmap in [damper-contracts](https://github.com/UbsOrg/damper-contracts#roadmap).

## License

Apache-2.0
