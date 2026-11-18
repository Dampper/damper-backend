# 0005. Alert delivery by webhook, planned by a pure function

Status: accepted, 2026-11-18

## Context

The keeper's most important alerts (`no-quote`, `suspicious-move`, `unseeded`) describe states a lending pool cannot see for itself, and they only reached a log. An alert nobody reads protects nothing. Delivery has three ways to go wrong: spamming a channel every five minutes until people mute it, losing an alert because the channel was briefly down, and leaking the webhook URL, which lets anyone post to the channel.

## Decision

Alerts go to one webhook (`DAMPER_ALERT_WEBHOOK`) in `json`, `slack` or `discord` shape. What to send is decided by a pure function from the alerts firing now and what people were already told:

- a new alert is sent once, then not again while it keeps firing;
- one that keeps firing is mentioned again after a reminder interval (6 hours by default);
- one that clears is reported as resolved, but only if people were told it started;
- an alert whose delivery failed stays "not yet told", so the next pass sends it again.

Delivery retries network errors, 5xx and 429 (honouring `Retry-After`, up to 30 s), fails at once on other 4xx, and never throws into the keeper loop. The URL is read only from the environment, must be https (plain http only to localhost, for testing a receiver), and is only ever printed as a host name.

The keeper also reports itself: after three passes in a row fail, it raises a critical `tick-failing`, and it does not call alerts resolved during an outage it could not observe. Failed actions (a poke or evidence publish that did not land) become `action-failed` warnings.

## Consequences

- A channel gets one message per problem, a reminder if it persists, and a closing note, not one per pass.
- A short outage of the receiver loses nothing: alerts are re-sent when it is back.
- State is in memory, so a restart tells people again about whatever is still firing. That is noisy but never silent.
- **A keeper that dies outright cannot announce it.** `tick-failing` covers a keeper that runs but cannot do its job. For a dead process, run it under a supervisor and add an external heartbeat monitor; the keeper does not ping one yet (see the roadmap).
- Severity filtering (`--alert-min`) is the only routing: one channel, one threshold.
