# Environment

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `DAMPER_RPC_URL` | scanner, keeper | `https://mainnet.sorobanrpc.com` | Soroban RPC endpoint. The keeper's `--network testnet` switches to the testnet RPC; `--rpc` overrides either. |
| `DAMPER_HORIZON_URL` | scanner | `https://horizon.stellar.org` | Horizon endpoint for SDEX order books and trade volume |
| `DAMPER_KEEPER_SECRET` | keeper, with `--submit` | none | The keeper's secret key (`S...`). Read only from the environment, never printed. Must be the oracle's keeper address. |

Node 20 or newer.

## Commands

```sh
npm run scan -- [--registry data/pools.json] [--out reports/latest.json] [--pool C... ...]
npm run keeper -- --oracle C... [--network mainnet|testnet] [--rpc URL] [--once] [--interval 300] [--submit]
```

`--interval` is in seconds and is raised to at least 60. Without `--submit` the keeper only reports.

## Notes

- Public RPC endpoints drop requests under bursts. The scanner limits concurrency and retries transport failures, and on some hosts needs `NODE_OPTIONS=--dns-result-order=ipv4first`.
- Use a throwaway key for testnet. Keep any mainnet keeper key out of the repository and out of shell history.
