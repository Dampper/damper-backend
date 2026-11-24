# Changelog

All notable changes to this repository are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Nothing has been released yet.

## [Unreleased]

### Added

- `render.yaml`: deploy the keeper as a Render Background Worker. Every CLI flag also reads from a same-named environment variable, so it needs no constructed argument string. Superseded as the deployed path by the GitHub Actions workflow below (Render has no free tier), but left in the repository.
- `.github/workflows/keeper.yml`: run the keeper every 5 minutes on GitHub Actions instead, at no hosting cost. A `--state` file persists the suspicious-move hold clock (ADR 0003) across the fresh process each run starts, published to its own `keeper-state` branch.
- `--status-file`: writes every asset's raw price, quote, anchor, policy, effective policy, evidence and alerts as JSON after each pass, published alongside the hold clock for the dashboard's status page (ADR 0009).
- Pool scanner: discovers Blend V2 and V2.1 pools, traces each reserve's price to its upstream feed through Blend's oracle aggregator, reads SDEX depth and volume for DEX-priced assets, and scores collateral-side and debt-side exposure against the capital needed to move the price.
- Notes on aggregator `max_dev` (one round of lookback) and on fixed-price collateral.
- Keeper: pokes anchors when due, holds pokes when the raw price is far from the anchor, and reports unseeded policies, lost quorum and a binding clamp. Dry run by default.
- Keeper publishes market evidence for the oracle's cost gate: order-book cost, and exposure from a pool or a fixed number. Alerts `evidence-stale` and `gate-tight`.
- Keeper heartbeat: after each healthy pass it requests `DAMPER_HEARTBEAT_URL`, so an external monitor alerts when the keeper dies, hangs or fails every pass. `--test-heartbeat` checks the wiring.
- Alert delivery to a Slack, Discord or generic webhook: each problem is sent once, reminded after a while, and reported as resolved; a failed delivery is retried; the keeper reports when it cannot run (`tick-failing`) or an action fails (`action-failed`). `--test-alert` checks the setup.
- Oracle reads are retried and a failing read fails the pass, so a transient RPC error cannot make a gated asset look ungated.
- First mainnet scan results in the README.
- Scheduled workflow that publishes the scan to the `reports` branch for the dashboard, with `--merge-from` so the pool registry survives the RPC's seven-day event retention.
