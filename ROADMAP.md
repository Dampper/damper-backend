# Roadmap

## Done

- Pool scanner over mainnet Blend V2 / V2.1 pools, with a persisted pool registry.
- Keeper: anchor pokes, hold on suspicious moves, alerts in the log; run end to end against a testnet oracle.
- Scheduled report publishing for the dashboard.

## Next

- **Cost estimates on-chain.** Publish per-asset manipulation-cost estimates to the Damper oracle once its cost gate exists.
- **Alert delivery.** Alerts only reach the log. Add a webhook (and a way to test it) so `suspicious-move`, `no-quote` and `unseeded` reach a person.
- **Historical pool discovery.** RPC nodes keep about seven days of events, so pools deployed earlier and outside a reward zone are only found if seeded. Backfill from ledger archives.
- **AMM-aware depth.** The order-book model ignores classic liquidity pools and Soroban AMMs. Model them, since they absorb a manipulated print through arbitrage.
- **Depeg risk for fixed-price collateral.** Flagged today, not scored.
- **Per-asset history and keeper status** for the dashboard. It currently reads only the latest scan, published as a static file.
