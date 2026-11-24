# 0009. The keeper publishes a per-asset status report

Status: accepted, 2026-11-24

## Context

The scanner's published report tells a pool operator the manipulation risk of a pool's reserves, but it never looks at the oracle itself: whether its anchor has gone stale, whether a clamp is currently binding, whether the gate is on its tight rate for lack of evidence. That state exists only in the keeper, which already reads every field involved — `AssetState` in `chain.ts` carries the raw price, the quote, the anchor, the policy, the gate and the evidence for every asset on every pass, to decide what to do and what to alert on. None of it was kept once the pass finished.

A dashboard reading the chain directly to show this would duplicate the keeper's own RPC reads and its own interpretation of the contract (`effective_policy`'s rate, for instance, already comes straight from the contract so the frontend never has to reimplement the gate's arithmetic to show it). The scanner's report already solves the shape of this problem once: read something expensive on a schedule, publish the plain-JSON result, let a static site read that instead of the chain.

## Decision

`src/keeper/status.ts` turns an `AssetState` and that pass's alerts into `AssetStatus` — the same fields, with every `bigint` as a decimal string (JSON has no integer type wide enough for a price in the oracle's fixed-point units). `tick()` (`run.ts`) builds one of these per asset it looks at and attaches the whole `StatusReport` to `TickReport.status`, reusing data it already read rather than issuing new RPC calls.

`--status-file <path>` / `DAMPER_STATUS_FILE` (`cli/keeper.ts`) writes that report to disk after every pass, the same way `--state` does for the hold clock. The GitHub Actions workflow (ADR 0008) publishes it to the `keeper-state` branch alongside `keeper-state.json`, in the same commit. When a pass fails before reading the oracle, an empty, clearly-timestamped report is published instead of nothing, since leaving the previous one in place would let a stale report look current.

## Consequences

- A status page can show an oracle's real-time health from a static file, the same way the pool dashboard already does, without a server and without re-deriving the gate's or the clamp's arithmetic.
- The report is only as fresh as the last successful pass; a keeper that has stopped (caught by the heartbeat, ADR 0006) leaves a report with an old `at` and no indication beyond that timestamp that nothing has changed.
- `keeper-state` is now two files instead of one, published by the same step. A dashboard reading it should check `at`, not assume it is recent.
- This is one oracle's status, not a history: see the roadmap for a time series, which needs more than a single overwritten file.
