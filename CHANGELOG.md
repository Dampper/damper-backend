# Changelog

All notable changes to this repository are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Nothing has been released yet.

## [Unreleased]

### Added

- Pool scanner: discovers Blend V2 and V2.1 pools, traces each reserve's price to its upstream feed through Blend's oracle aggregator, reads SDEX depth and volume for DEX-priced assets, and scores collateral-side and debt-side exposure against the capital needed to move the price.
- Notes on aggregator `max_dev` (one round of lookback) and on fixed-price collateral.
- Keeper: pokes anchors when due, holds pokes when the raw price is far from the anchor, and reports unseeded policies, lost quorum and a binding clamp. Dry run by default.
- First mainnet scan results in the README.
