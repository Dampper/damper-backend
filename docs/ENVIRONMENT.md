# Environment

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `DAMPER_RPC_URL` | scanner, keeper | `https://mainnet.sorobanrpc.com` | Soroban RPC endpoint. The keeper's `--network testnet` switches to the testnet RPC; `--rpc` overrides either. |
| `DAMPER_HORIZON_URL` | scanner | `https://horizon.stellar.org` | Horizon endpoint for SDEX order books and trade volume |
| `DAMPER_ALERT_WEBHOOK` | keeper | none | Where alerts are posted: a Slack, Discord or generic webhook URL. A secret: anyone holding it can post to the channel. https only (plain http is accepted for localhost, to test a receiver). Without it, alerts only go to the log. |
| `DAMPER_HEARTBEAT_URL` | keeper | none | A monitor's ping URL (healthchecks.io, Uptime Kuma, Cronitor, ...). Requested with `GET` after each healthy pass, so the monitor alerts when pings stop. A secret: whoever has it can mark the keeper alive. https only (http for localhost). Without it a dead keeper goes unnoticed. |
| `DAMPER_KEEPER_SECRET` | keeper, with `--submit`/`DAMPER_SUBMIT` | none | The keeper's secret key (`S...`). Read only from the environment, never printed. Must be the oracle's keeper address. |

Every other keeper flag also has an environment-variable form, read when the flag is not given, so a host that only offers an env var editor (Render, and similar) needs no constructed argument string:

| Variable | Same as | Default |
| --- | --- | --- |
| `DAMPER_ORACLE` | `--oracle` | required |
| `DAMPER_NETWORK` | `--network` | `mainnet` |
| `DAMPER_INTERVAL` | `--interval` | `300` |
| `DAMPER_SUBMIT` | `--submit` | `false` (`1`/`true`/`yes` turn it on) |
| `DAMPER_POOL` | `--pool` | none |
| `DAMPER_EXPOSURE_USD` | `--exposure-usd` | none |
| `DAMPER_MARKET_HORIZON` | `--market-horizon` | none |
| `DAMPER_WEBHOOK_FORMAT` | `--webhook-format` | `json` |
| `DAMPER_ALERT_MIN` | `--alert-min` | `warn` |
| `DAMPER_ALERT_REMINDER_HOURS` | `--alert-reminder-hours` | `6` |

A flag given on the command line always wins over its environment variable.

Node 20 or newer.

## Commands

```sh
npm run scan -- [--registry data/pools.json] [--out reports/latest.json] [--pool C... ...] [--merge-from URL|FILE]
npm run keeper -- --oracle C... [--network mainnet|testnet] [--rpc URL] [--once] [--interval 300] [--submit]
                  [--pool C... | --exposure-usd N] [--market-horizon URL]
                  [--webhook-format json|slack|discord] [--alert-min critical|warn|info]
                  [--alert-reminder-hours 6] [--test-alert] [--test-heartbeat]
```

`--interval` is in seconds and is raised to at least 60. Without `--submit` the keeper only reports.

`--pool` or `--exposure-usd` turns on market evidence for gated assets: `--pool` reads the exposure from a Blend pool that uses the oracle (a scan of that pool each pass), `--exposure-usd` uses one number for every asset. `--market-horizon` is where order books are read (default `DAMPER_HORIZON_URL`, mainnet), which matters when the oracle is on testnet.

`--merge-from` merges a previously published pool registry before discovering, so pools seen on earlier runs are kept. The scheduled workflow uses it with the registry on the `reports` branch.

`--test-alert` sends one message to the webhook and exits, to check it before relying on it. `--alert-min` (default `warn`) is the least severe alert that is sent; `--alert-reminder-hours` (default 6) is how long an alert that keeps firing waits before it is mentioned again.

`--test-heartbeat` sends one ping to `DAMPER_HEARTBEAT_URL` and exits. The monitor's grace period should exceed `--interval` plus a couple of retries (15 minutes for the default 300 s).

## Published report

[`publish-report.yml`](../.github/workflows/publish-report.yml) scans every 6 hours and force-pushes a single commit to the `reports` branch containing `latest.json` (the scan) and `pools.json` (the registry). The dashboard reads `https://raw.githubusercontent.com/Dampper/damper-backend/reports/latest.json`. The workflow refuses to publish a report with no pools.

## Deploying the keeper

[`render.yaml`](../render.yaml) runs the keeper as a Render Background Worker: no public port, restarted on crash, which fits a process that only ever submits transactions and pings a monitor. In the Render dashboard, "New +" → "Blueprint", point it at this repository, then fill in the env vars it asks for (`DAMPER_ORACLE` at minimum; the rest turn on submitting, evidence, alerts and the heartbeat). The scheduled scan-and-publish workflow is unrelated and keeps running on GitHub Actions.

Start with `DAMPER_SUBMIT=false` (the blueprint's default): the keeper still reports, alerts and pings the heartbeat, so you can watch a new oracle before handing it a funded key.

## Notes

- Public RPC endpoints drop requests under bursts. The scanner limits concurrency and retries transport failures, and on some hosts needs `NODE_OPTIONS=--dns-result-order=ipv4first`.
- Use a throwaway key for testnet. Keep any mainnet keeper key out of the repository and out of shell history.
