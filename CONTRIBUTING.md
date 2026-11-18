# Contributing to Damper Backend

Thanks for helping. This page covers setup, checks and what a pull request needs. For the shared rules (labels, commit messages, code of conduct) see the [organisation guide](https://github.com/UbsOrg/.github/blob/main/CONTRIBUTING.md).

## Finding something to work on

Look for issues labelled `good first issue` or `help wanted`. Each one lists what to do, acceptance criteria and where to look. Comment to get assigned before you start. If none fits, the [roadmap](ROADMAP.md) lists what is next, and a test for a branch of [`decide.ts`](src/keeper/decide.ts) or [`score.ts`](src/score.ts) is always welcome.

## Working on a Stellar Wave issue

Pick an issue marked for the Wave, comment to be assigned, and open your pull request against it. Keep to the issue's acceptance criteria; if the issue is wrong, say so there rather than widening the change.

## Local setup

Node 20 or newer.

```sh
npm install
npm test            # no network needed
npm run typecheck
npm run scan -- --pool C...     # needs network; see docs/ENVIRONMENT.md
```

## Making a change

CI runs `npm run typecheck` and `npm test`. A pull request needs:

- **Tests for decisions.** The scoring in `score.ts`, the order-book maths in `market.ts` and the keeper's choices in `decide.ts` are pure functions on purpose, so every branch can be tested without a network. Add a case for any branch you add or change.
- **Real data in fixtures where you can.** The USTRY order-book test uses the shape of a real Horizon response. Say where a fixture came from.
- **No secrets.** Never commit keys, RPC credentials or `reports/`. The keeper reads its key only from `DAMPER_KEEPER_SECRET`.
- **Docs and decision records.** If a design choice changed, update or add a record in [`docs/adr`](docs/adr/README.md).

## Code guidelines

- Reads go through simulation ([`rpc.ts`](src/rpc.ts)); nothing that only reads should need a funded account.
- Retry transport failures only, never a contract error.
- Keep chain access (`keeper/chain.ts`, `rpc.ts`) separate from decisions, so decisions stay testable.
- Amounts that can exceed 2^53 stay `bigint`; convert to `number` only for ratios.

## Commit messages

Imperative subject under about 70 characters, then a body that says why.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](https://github.com/UbsOrg/.github/blob/main/SECURITY.md).
