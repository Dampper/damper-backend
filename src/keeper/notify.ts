/**
 * Getting the keeper's alerts to a person.
 *
 * The planner is pure: given what is firing now and what it has already told people, it says
 * what to send. Delivery is separate and never throws into the keeper loop. The webhook URL is
 * a secret (anyone holding a Slack or Discord URL can post to the channel), so it is read from
 * the environment, validated, and only ever printed as a host name.
 */
import type { Alert, Severity } from './decide.js';
import type { TickReport } from './run.js';

const RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

export interface ActiveAlert {
  /** `${asset}|${code}`: one alert per asset and kind. */
  key: string;
  asset: string;
  code: string;
  severity: Severity;
  message: string;
}

export interface NotifyOptions {
  /** Alerts less severe than this are never sent. */
  minSeverity: Severity;
  /** How long an alert that keeps firing waits before it is mentioned again. */
  reminderSecs: number;
}

export const NOTIFY_DEFAULTS: NotifyOptions = { minSeverity: 'warn', reminderSecs: 6 * 3600 };

export interface Tracked {
  alert: ActiveAlert;
  firstSeen: number;
  /** When a person was last told; undefined until a delivery succeeds. */
  lastSent: number | undefined;
}
export type NotifyState = Map<string, Tracked>;

export type NotificationKind = 'new' | 'reminder' | 'resolved';
export interface Notification {
  kind: NotificationKind;
  alert: ActiveAlert;
  /** For a reminder or a resolution: how long it has been firing, in seconds. */
  firedFor: number;
}

/** What to send now. Does not change `state`; call `recordDelivery` for each result. */
export function planNotifications(
  state: NotifyState,
  current: ActiveAlert[],
  now: number,
  opts: NotifyOptions = NOTIFY_DEFAULTS,
): Notification[] {
  const out: Notification[] = [];
  const firing = new Map(current.filter((a) => RANK[a.severity] <= RANK[opts.minSeverity]).map((a) => [a.key, a]));

  for (const [key, alert] of firing) {
    const t = state.get(key);
    if (!t || t.lastSent === undefined) {
      // never delivered: a first notice, or a retry of one that failed
      out.push({ kind: 'new', alert, firedFor: t ? now - t.firstSeen : 0 });
    } else if (now - t.lastSent >= opts.reminderSecs) {
      out.push({ kind: 'reminder', alert, firedFor: now - t.firstSeen });
    }
  }
  for (const [key, t] of state) {
    // only tell people something is over if they were told it started
    if (!firing.has(key) && t.lastSent !== undefined) out.push({ kind: 'resolved', alert: t.alert, firedFor: now - t.firstSeen });
  }
  return out;
}

/**
 * Update the state after trying to deliver `n`. A failed delivery leaves things so that the
 * next pass plans it again.
 */
export function recordDelivery(state: NotifyState, n: Notification, delivered: boolean, now: number): void {
  const key = n.alert.key;
  const t = state.get(key);
  switch (n.kind) {
    case 'new':
      state.set(key, { alert: n.alert, firstSeen: t?.firstSeen ?? now, lastSent: delivered ? now : undefined });
      break;
    case 'reminder':
      if (t) state.set(key, { ...t, alert: n.alert, lastSent: delivered ? now : t.lastSent });
      break;
    case 'resolved':
      if (delivered) state.delete(key);
      break;
  }
}

/**
 * Forget alerts that were never delivered and have stopped firing: nobody was told they
 * started, so nobody needs to be told they ended.
 */
export function forgetQuiet(state: NotifyState, current: ActiveAlert[]): void {
  const firing = new Set(current.map((a) => a.key));
  for (const [key, t] of state) if (!firing.has(key) && t.lastSent === undefined) state.delete(key);
}

// ------------------------------------------------------------------ from a keeper pass

export function toActive(asset: string, a: Alert): ActiveAlert {
  return { key: `${asset}|${a.code}`, asset, code: a.code, severity: a.severity, message: a.message };
}

/** Consecutive failed passes before the keeper reports that it cannot do its job. */
export const TICK_FAILURES_BEFORE_ALERT = 3;

/** Everything a pass says that a person should hear, including actions that failed. */
export function alertsFromReport(report: TickReport | undefined, consecutiveFailures: number, lastFailure?: string): ActiveAlert[] {
  const out: ActiveAlert[] = [];
  if (consecutiveFailures >= TICK_FAILURES_BEFORE_ALERT) {
    out.push({
      key: 'keeper|tick-failing',
      asset: 'keeper',
      code: 'tick-failing',
      severity: 'critical',
      message: `${consecutiveFailures} keeper passes in a row failed, so anchors are not being kept and nothing is watching: ${lastFailure ?? 'unknown error'}`,
    });
  }
  for (const row of report?.rows ?? []) {
    for (const a of row.alerts) out.push(toActive(row.asset, a));
    if (row.error) {
      out.push({
        key: `${row.asset}|action-failed`,
        asset: row.asset,
        code: 'action-failed',
        severity: 'warn',
        message: row.error.slice(0, 300),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ messages

export type WebhookFormat = 'json' | 'slack' | 'discord';

export interface Context {
  network: string;
  oracle: string;
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const assetName = (asset: string) => {
  const [kind, id] = asset.split(':');
  return kind && id ? `${kind}:${short(id)}` : asset;
};

export function formatText(n: Notification, ctx: Context): string {
  const hours = (n.firedFor / 3600).toFixed(n.firedFor >= 36000 ? 0 : 1);
  const where = `oracle ${short(ctx.oracle)}, ${ctx.network}`;
  const head =
    n.kind === 'resolved'
      ? `RESOLVED after ${hours} h`
      : n.kind === 'reminder'
        ? `STILL FIRING after ${hours} h [${n.alert.severity}]`
        : `${n.alert.severity.toUpperCase()}`;
  return `Damper keeper: ${head}: ${n.alert.code} on ${assetName(n.alert.asset)} (${where})\n${n.alert.message}`;
}

export function buildPayload(format: WebhookFormat, n: Notification, ctx: Context, now: number): Record<string, unknown> {
  const text = formatText(n, ctx);
  if (format === 'slack') return { text };
  // Discord rejects messages over 2000 characters
  if (format === 'discord') return { content: text.slice(0, 1900) };
  return {
    source: 'damper-keeper',
    kind: n.kind,
    severity: n.alert.severity,
    code: n.alert.code,
    asset: n.alert.asset,
    oracle: ctx.oracle,
    network: ctx.network,
    firedForSecs: n.firedFor,
    message: n.alert.message,
    text,
    at: new Date(now * 1000).toISOString(),
  };
}

// ------------------------------------------------------------------ delivery

export class NotifyError extends Error {}

/** https, or http only to this machine (for testing a receiver). Throws on anything else. */
export function parseWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NotifyError('the webhook URL is not a valid URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new NotifyError('the webhook URL must use https (http is only accepted for localhost)');
  }
  return u;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  /** `GET` sends no body (for a heartbeat ping). Default `POST`. */
  method?: 'GET' | 'POST';
  /** Test hook: replaces the real wait between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * POST the payload (or, with `method: 'GET'`, just request the URL). Retries network errors, 429 (honouring Retry-After, at most 30 s) and 5xx;
 * a 4xx that is not 429 means the URL or payload is wrong, so it fails at once. Errors name
 * only the host: the rest of a webhook URL is the secret.
 */
export async function deliver(url: URL, payload: unknown, opts: DeliverOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 'no attempt made';
  for (let i = 1; i <= attempts; i++) {
    let wait = 1000 * 2 ** (i - 1);
    try {
      const res = await fetchImpl(url, {
        method: opts.method ?? 'POST',
        ...((opts.method ?? 'POST') === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
          : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (res.ok) return;
      last = `${url.host} answered ${res.status}`;
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra, 30) * 1000;
      } else if (res.status < 500) {
        throw new NotifyError(last);
      }
    } catch (e) {
      if (e instanceof NotifyError) throw e;
      last = `could not reach ${url.host}`;
    }
    if (i < attempts) await sleep(wait);
  }
  throw new NotifyError(`${last} after ${attempts} attempts`);
}

// ------------------------------------------------------------------ the notifier

export class Notifier {
  readonly state: NotifyState = new Map();
  private failures = 0;
  private lastFailure: string | undefined;

  constructor(
    private readonly url: URL,
    private readonly format: WebhookFormat,
    private readonly ctx: Context,
    private readonly opts: NotifyOptions = NOTIFY_DEFAULTS,
    private readonly dep: DeliverOptions = {},
    private readonly log: (line: string) => void = console.log,
  ) {}

  /** Call after every keeper pass. `report` is undefined when the pass itself failed. */
  async afterPass(report: TickReport | undefined, error: string | undefined, now: number): Promise<void> {
    if (error) {
      this.failures += 1;
      this.lastFailure = error;
    } else {
      this.failures = 0;
    }
    // A failed pass tells us nothing new about the assets: keep what is already firing.
    const current = alertsFromReport(report, this.failures, this.lastFailure);
    const effective = report ? current : [...[...this.state.values()].map((t) => t.alert).filter((a) => a.key !== 'keeper|tick-failing'), ...current];
    forgetQuiet(this.state, effective);
    for (const n of planNotifications(this.state, effective, now, this.opts)) {
      let ok = false;
      try {
        await deliver(this.url, buildPayload(this.format, n, this.ctx, now), this.dep);
        ok = true;
      } catch (e) {
        this.log(`alert not delivered (${n.kind} ${n.alert.code} on ${n.alert.asset}): ${(e as Error).message}`);
      }
      recordDelivery(this.state, n, ok, now);
    }
  }

  /** Send one message to prove the webhook works. */
  async test(now: number): Promise<void> {
    const alert: ActiveAlert = { key: 'keeper|test', asset: 'keeper', code: 'test', severity: 'info', message: 'This is a test alert from the Damper keeper. If you can read it, alert delivery works.' };
    await deliver(this.url, buildPayload(this.format, { kind: 'new', alert, firedFor: 0 }, this.ctx, now), this.dep);
  }
}
