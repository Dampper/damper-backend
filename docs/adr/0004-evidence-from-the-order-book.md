# 0004. Market evidence from the order book, with a fixed or pool-derived exposure

Status: accepted, 2026-11-18

## Context

The oracle's cost gate ([contracts ADR 0004](https://github.com/Dampper/damper-contracts/blob/main/docs/adr/0004-cost-gate-tightens-never-loosens.md)) needs, per asset, what it costs to push the price and what that would let an attacker borrow. The oracle cannot compute either on-chain, so the keeper publishes them. The contract only lets evidence tighten the clamp, so a wrong estimate costs borrowers speed, not safety, and the keeper's job is to be useful and honest rather than perfect.

## Decision

**Cost** is the capital needed to push the asset's Stellar DEX price up (or down) about 10x, read from the public order book against USDC, the same measure the scanner uses ([0002](0002-score-by-capital-to-clear-the-book.md)). The oracle may be on testnet while the market that matters is mainnet's, so the order book is read from a separate, configurable Horizon.

**Exposure** is what an attacker could borrow once the price is false. From a live pool (`--pool`), it is the liquidity of the other reserves for the up direction and of this reserve for the down direction. Without a pool (`--exposure-usd`), one number is used for every asset, for a pool that is not deployed yet or a demonstration.

The keeper publishes when there is no evidence or a third of its life is used, not on every pass. When it cannot compute evidence (no market, a custom token, an asset the pool does not hold) it publishes nothing and says why. Missing evidence makes the oracle use its tight rate, which is the safe outcome.

## Consequences

- **The model assumes the worst case:** every upstream feed reads this asset's SDEX market. If some read other venues, the real cost is higher and the gate is more cautious than it needs to be.
- **It ignores AMM liquidity.** AMMs cannot print a manipulated trade but can be pulled, so depth may be overstated in an attacker's favour. On the roadmap.
- **Assets with no DEX market stay on the tight rate** until the operator removes their gate or a venue model exists. That is deliberate.
- **Reads must not fail quietly.** A transient RPC error that made a gated asset look ungated would silently drop its alerts, so oracle reads are retried and a failing read fails the pass.
- **Each publish is a transaction**, so the schedule matters. One publish per asset per third of the evidence age is the compromise.
