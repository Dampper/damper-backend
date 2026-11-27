# 0008. Run the keeper on a GitHub Actions schedule, with its hold-state persisted

Status: accepted, 2026-11-18

## Context

[0007](0007-render-worker.md) tried to run the keeper as a long-running Render Background Worker. Render has no free tier for one: the API call to create it returned `402 Payment Required`. GitHub Actions is free for a public repository and this repository already uses it for the scan-and-publish workflow, so the keeper moves there instead — but a scheduled workflow starts a **fresh process every run**, which a long-running worker never does, and that difference is not free.

`decide()` holds a poke back while a raw price sits far from the anchor, then lets the move through anyway after `maxHoldSecs` (6 hours by default) — a real crash must still reach the pool (see damper-backend's ADR 0003). "How long has this been held" lived only in an in-memory `Map`, kept across passes for free by a long-running process. A process that restarts every pass has no such memory: every run would see any held move as having "just started," so `heldFor` would never reach `maxHoldSecs` and a hold could never expire. That is a real correctness regression, not a cosmetic one — it would make a genuine move stay clamped away from reality indefinitely under the scheduled design, something the long-running design never did.

## Decision

[`.github/workflows/keeper.yml`](../../.github/workflows/keeper.yml) runs `npm run keeper -- --once` on a 5-minute cron (matching `MIN_POKE_SECS`), reusing every environment variable 0007 already added.

The hold clock is given somewhere to live between runs: [`src/keeper/state.ts`](../../src/keeper/state.ts) reads and writes it as a small JSON file (`--state <path>` / `DAMPER_STATE_FILE`), and the workflow publishes that file to its own orphan `keeper-state` branch after every pass — the same force-push-a-single-commit pattern the scan-and-publish workflow already uses for `reports`, just on a separate branch so the two scheduled jobs, which run on different clocks, never fight over the same branch tip. Each run downloads the previous commit before the pass and publishes the new one after, `if: always()` so a failed pass still saves whatever it had.

Without `--state` the keeper behaves exactly as before (in-memory only), so a long-running deployment (Render, or anywhere else) is unaffected by this change.

**Update (#10):** the same file also carries the `Notifier`'s delivery state (which alerts a person has already been told about, and when) — missed in the original decision above. Without it, a scheduled `--once` run started with an empty `Notifier` on every pass, so `DAMPER_ALERT_WEBHOOK` posted every still-firing alert again each run instead of once plus a reminder every `--alert-reminder-hours`. `state.ts` now reads and writes both maps in the one JSON file, and `keeper.ts` hydrates the `Notifier` from it before the loop and saves its state back alongside the hold clock after each pass. Losing the file resets both clocks the same way: a held move looks freshly suspicious again, and an already-delivered alert may be sent one extra time — never unsafe, just occasionally noisier.

## Consequences

- No hosting cost, but a weaker process: GitHub documents that a scheduled workflow can be delayed or occasionally skipped under load, so the keeper's real cadence is "about every 5 minutes," not exactly every 5 minutes. A late or dropped run only makes the clamp more cautious (an unpoked anchor widens the band more slowly), never less, so this fails toward safety rather than away from it.
- The heartbeat (ADR 0006) matters more here than it did for a long-running worker: a workflow that GitHub stops scheduling (its own documented behavior for an inactive repository) now has no other signal, since there is no long-running process left to notice its own death.
- `keeper-state` is a second disposable branch, force-pushed like `reports`. Losing it (or starting it over) only resets the hold clock on whatever is currently held — the same thing a crash already did before this change, just now the common case instead of the rare one.
- A held move's clock, and the keeper's own `console.log` history, now live only in the Actions run log and the `keeper-state` branch; there's no longer one process whose uptime answers "when did this start."
