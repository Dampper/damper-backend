# 0002. Score exposure against the capital needed to clear the order book

Status: accepted, 2026-11-17

## Context

Reflector's DEX feed is derived from Stellar DEX trades. To make it report price P, an attacker has to trade at P, which means first buying every resting ask below P. So the USDC needed to clear the book up to P is the capital needed to make the feed see P. The order book is public, so this can be measured per asset without simulating anything.

## Decision

For each reserve, the scanner computes two things and compares them. The **exposure** is what an attacker could borrow once the price is false: for a collateral asset, the available liquidity of every other reserve; for a debt asset, that reserve's own available liquidity. The **cost** is the USDC to push the price 10x up (collateral side) or the value sold to push it 10x down (debt side). Tiers follow the ratio: critical at 10x or more, or when the market trades under $1,000 a day with over $10,000 exposed; high above 1x; medium from 0.1x; low below.

## Consequences

- The numbers can be checked by hand against the order book.
- Cost is capital, not loss: the attacker keeps what they buy. The tiers say who could try, not what they would lose.
- AMM pools are ignored. They cannot print a manipulated trade but can absorb one, so depth is overstated in the attacker's favour. On the roadmap.
- Assets priced from off-chain venues or an operator feed are reported as `external` and not scored, because a DEX attack does not reach them.
