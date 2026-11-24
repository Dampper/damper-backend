# Decision records

Short notes on why the backend is built the way it is.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-pool-registry-file.md) | Keep a persisted pool registry | Accepted |
| [0002](0002-score-by-capital-to-clear-the-book.md) | Score exposure against the capital needed to clear the order book | Accepted |
| [0003](0003-keeper-holds-on-suspicious-moves.md) | The keeper holds pokes on suspicious moves | Accepted |
| [0004](0004-evidence-from-the-order-book.md) | Market evidence from the order book, with a fixed or pool-derived exposure | Accepted |
| [0005](0005-alert-delivery.md) | Alert delivery by webhook, planned by a pure function | Accepted |
| [0006](0006-heartbeat.md) | A heartbeat so a dead keeper is noticed | Accepted |
| [0007](0007-render-worker.md) | Run the keeper as a Render Background Worker, configured entirely by environment | Superseded by 0008 |
| [0008](0008-github-actions-keeper.md) | Run the keeper on a GitHub Actions schedule, with its hold-state persisted | Accepted |
| [0009](0009-oracle-status-report.md) | The keeper publishes a per-asset status report | Accepted |
