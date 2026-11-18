# 0006. A heartbeat so a dead keeper is noticed

Status: accepted, 2026-11-18

## Context

Everything the keeper reports, it reports itself. A process that has crashed, hung on a network call, lost its machine or been killed by the host sends nothing, and silence looks the same as "all is well". If the keeper stops, anchors go stale and the cost gate's evidence expires. That fails safe (quotes get tighter), but a pool then runs on a degraded oracle and nobody knows.

## Decision

After each healthy pass the keeper requests a URL (`DAMPER_HEARTBEAT_URL`) held by an external monitor, such as healthchecks.io, Uptime Kuma or Cronitor. The monitor alerts when its URL has not been requested for a while. Silence becomes the signal, and the decision about how long "a while" is stays outside the process that might be dead.

A pass is healthy when it completed and no asset had a failed action. Two cases are worth stating:

- A pass that threw, or in which a poke or evidence publish failed, does **not** ping. The keeper is up but not doing its job, and the monitor should say so.
- A pass that found something alarming (no quote, a pump held, a stale gate) **does** ping. The keeper did its job and the alert channel carries the news. Mixing the two would turn one outage into two alarms.

The ping is a plain `GET` with no body, retried like an alert delivery, and never throws into the loop: a monitor outage must not stop the keeper. The URL is a secret, because whoever has it can mark the keeper alive. It is read from the environment only, must be https (http only to localhost), and appears in logs only as a host name. A withheld or failed ping is logged once per change, not every pass.

`--test-heartbeat` sends one ping and exits, to check the monitor is wired up.

## Consequences

- A crash, a hang and a lost host all produce the same alert, from outside the keeper.
- A hung pass is caught for free: a pass that never ends never pings. The keeper has no overall pass timeout, so this is the only thing that catches it.
- The monitor's grace period should be longer than the polling interval plus a retry or two (for the default 300 s interval, 15 minutes is reasonable), or a slow pass will page someone.
- The keeper does not check that the monitor itself is alive. Choose one with its own track record.
- The heartbeat says the keeper is working, not that it is right. That is the job of the alerts.
