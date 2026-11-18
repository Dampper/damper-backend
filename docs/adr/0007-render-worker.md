# 0007. Run the keeper as a Render Background Worker, configured entirely by environment

Status: accepted, 2026-11-18

## Context

The keeper is a long-running loop with a secret key and (optionally) a webhook and a monitor URL. It had been run by hand or under some unspecified supervisor on whatever machine; nothing kept it running across a reboot or a crash, which is exactly the gap the heartbeat (ADR 0006) exists to detect rather than close. It needs somewhere that restarts it, keeps its secrets out of the repository, and does not expose a port it has no use for.

## Decision

[`render.yaml`](../../render.yaml) deploys the keeper as a Render **Background Worker**: `npm ci && npm run build` then `node dist/cli/keeper.js`, with no public port and a restart on crash or non-zero exit. Render's blueprint flow asks for each `sync: false` variable once and never displays it again, which fits `DAMPER_KEEPER_SECRET`, `DAMPER_ALERT_WEBHOOK` and `DAMPER_HEARTBEAT_URL`.

Render's own UI is an environment-variable editor, not an argument-string editor, so every CLI flag the keeper takes was given a same-named environment variable fallback (`--oracle` / `DAMPER_ORACLE`, `--submit` / `DAMPER_SUBMIT`, and so on; see [docs/ENVIRONMENT.md](../ENVIRONMENT.md)). A flag on the command line still wins, so local and CI use of `npm run keeper -- ...` is unchanged.

The blueprint defaults `DAMPER_SUBMIT` to `false`. A fresh deployment reports, alerts and pings the heartbeat without holding a funded key, so a new oracle can be watched for a while before the worker is trusted to submit transactions.

## Consequences

- One Render service restarts the keeper on crash and keeps it running across deploys; the separate GitHub Actions scan-and-publish workflow is untouched.
- Render's env var UI is now sufficient on its own: nobody has to hand-build a flags string in a dashboard text box, which is where a stray space or a missing quote would otherwise hide.
- The worker still has no overall pass timeout and no supervisor of its own below the process level; a hang inside a single pass is caught only by the heartbeat's silence, same as before.
- Moving providers again means re-pointing `render.yaml`'s equivalent, not touching `src/cli/keeper.ts`: the environment-variable surface is the actual contract.
