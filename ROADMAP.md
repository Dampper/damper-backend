# Roadmap

## Done

- Pool scanner over mainnet Blend V2 / V2.1 pools, with a persisted pool registry.
- Keeper: anchor pokes, hold on suspicious moves, alerts in the log; run end to end against a testnet oracle.
- Scheduled report publishing for the dashboard.
- Market evidence published to the oracle's cost gate, run end to end on testnet.
- Alert delivery to a webhook, with de-duplication, reminders, resolution notices and retries.
- Keeper heartbeat and a GitHub Actions schedule to run it (ADR 0006, ADR 0008).
- Keeper status report: raw price, quote, anchor, policy, effective policy, evidence and alerts per asset, published for the dashboard's status page (ADR 0009).

## Next

- **Historical pool discovery.** RPC nodes keep about seven days of events, so pools deployed earlier and outside a reward zone are only found if seeded. Backfill from ledger archives.
- **AMM-aware depth.** The order-book model ignores classic liquidity pools and Soroban AMMs. Model them, since they absorb a manipulated print through arbitrage. This also affects the cost the keeper publishes as evidence.
- **Evidence for assets without a DEX market**, such as exchange-priced assets, which currently stay on the oracle's tight rate.
- **Depeg risk for fixed-price collateral.** Flagged today, not scored.
- **Per-asset history** for the dashboard. It currently reads only the latest scan, published as a static file; the status report above is a second file in the same shape, not yet a series over time.
