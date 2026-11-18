# 0003. The keeper holds pokes on suspicious moves

Status: accepted, 2026-11-18

## Context

Each poke moves the oracle's anchor to the current clamped quote, so a keeper that always pokes walks the anchor towards whatever the upstreams say, at the policy's rate. Under a held pump that compounds: with a 5% per hour rate, poking every five minutes reaches about 3.3x in a day, against 2.2x if nobody pokes. The keeper must keep tracking real moves, and must not be the thing that drags the anchor to a manipulated price.

## Decision

When the raw upstream price is more than 1.5x the anchor in a direction the policy bounds, the keeper holds its pokes and raises a critical alert. After six hours it treats the move as real and resumes, with another alert. The hold clock is kept in memory per asset and clears when the raw price returns to range.

## Consequences

- A pump is not tracked for at least six hours, and a person is told.
- A real revaluation is tracked six hours late. That is the price of the rule.
- Held state is in memory, so a keeper restart restarts the hold clock. That delays resuming, which is the safe direction.
- The rule only matters while the keeper is the only thing poking, which the contract guarantees by making `poke` keeper-only.
- The thresholds are defaults and should be fitted to each asset's real volatility.
