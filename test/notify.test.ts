import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  Notifier,
  NotifyError,
  alertsFromReport,
  buildPayload,
  deliver,
  formatText,
  parseWebhookUrl,
  planNotifications,
  recordDelivery,
  forgetQuiet,
  type ActiveAlert,
  type Notification,
  type NotifyState,
} from '../src/keeper/notify.js';
import type { TickReport } from '../src/keeper/run.js';

const NOW = 1_800_000_000;
const ASSET = 'Stellar:CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const alert = (code: string, severity: ActiveAlert['severity'] = 'critical', asset = ASSET): ActiveAlert => ({
  key: `${asset}|${code}`, asset, code, severity, message: `${code} message`,
});
const ctx = { network: 'testnet', oracle: 'CCBCV5NCMEDCW4WPWF45P36JXZ7VV3QJR5T4X3CICJPGRYRDXKH636GQ' };

/** Plan, "deliver" every notification successfully, and record it. */
function pass(state: NotifyState, current: ActiveAlert[], now: number, ok = true): Notification[] {
  const plan = planNotifications(state, current, now);
  forgetQuiet(state, current);
  for (const n of plan) recordDelivery(state, n, ok, now);
  return plan;
}

describe('planNotifications', () => {
  it('sends a new alert once, then stays quiet while it keeps firing', () => {
    const s: NotifyState = new Map();
    expect(pass(s, [alert('suspicious-move')], NOW).map((n) => n.kind)).toEqual(['new']);
    expect(pass(s, [alert('suspicious-move')], NOW + 300)).toEqual([]);
    expect(pass(s, [alert('suspicious-move')], NOW + 3600)).toEqual([]);
  });

  it('reminds after the reminder interval, and restarts the clock', () => {
    const s: NotifyState = new Map();
    pass(s, [alert('suspicious-move')], NOW);
    const r = pass(s, [alert('suspicious-move')], NOW + 6 * 3600);
    expect(r.map((n) => n.kind)).toEqual(['reminder']);
    expect(r[0]!.firedFor).toBe(6 * 3600);
    expect(pass(s, [alert('suspicious-move')], NOW + 6 * 3600 + 300)).toEqual([]);
  });

  it('says when an alert has cleared, once', () => {
    const s: NotifyState = new Map();
    pass(s, [alert('no-quote')], NOW);
    const r = pass(s, [], NOW + 1800);
    expect(r.map((n) => n.kind)).toEqual(['resolved']);
    expect(r[0]!.firedFor).toBe(1800);
    expect(pass(s, [], NOW + 2100)).toEqual([]);
  });

  it('does not announce the end of something nobody was told about', () => {
    const s: NotifyState = new Map();
    pass(s, [alert('no-quote')], NOW, false); // delivery failed
    expect(pass(s, [], NOW + 300)).toEqual([]);
    expect(s.size).toBe(0);
  });

  it('retries a failed delivery on the next pass instead of losing it', () => {
    const s: NotifyState = new Map();
    expect(pass(s, [alert('unseeded')], NOW, false).map((n) => n.kind)).toEqual(['new']);
    expect(pass(s, [alert('unseeded')], NOW + 300, false).map((n) => n.kind)).toEqual(['new']);
    expect(pass(s, [alert('unseeded')], NOW + 600).map((n) => n.kind)).toEqual(['new']);
    expect(pass(s, [alert('unseeded')], NOW + 900)).toEqual([]);
  });

  it('keeps a failed reminder due, and a failed resolution pending', () => {
    const s: NotifyState = new Map();
    pass(s, [alert('x')], NOW);
    expect(pass(s, [alert('x')], NOW + 6 * 3600, false).map((n) => n.kind)).toEqual(['reminder']);
    expect(pass(s, [alert('x')], NOW + 6 * 3600 + 300).map((n) => n.kind)).toEqual(['reminder']);
    pass(s, [], NOW + 7 * 3600, false);
    expect(pass(s, [], NOW + 7 * 3600 + 300).map((n) => n.kind)).toEqual(['resolved']);
  });

  it('tracks each asset and kind separately', () => {
    const s: NotifyState = new Map();
    const other = 'Stellar:COTHER';
    expect(pass(s, [alert('a'), alert('b'), alert('a', 'critical', other)], NOW)).toHaveLength(3);
    expect(pass(s, [alert('a'), alert('a', 'critical', other)], NOW + 300).map((n) => `${n.kind}:${n.alert.code}`)).toEqual(['resolved:b']);
  });

  it('never sends alerts below the minimum severity', () => {
    const s: NotifyState = new Map();
    const plan = planNotifications(s, [alert('i', 'info'), alert('w', 'warn'), alert('c', 'critical')], NOW);
    expect(plan.map((n) => n.alert.code).sort()).toEqual(['c', 'w']);
    const onlyCritical = planNotifications(s, [alert('w', 'warn'), alert('c', 'critical')], NOW, { minSeverity: 'critical', reminderSecs: 1 });
    expect(onlyCritical.map((n) => n.alert.code)).toEqual(['c']);
  });

  it('after a restart, tells people again about whatever is still firing', () => {
    expect(pass(new Map(), [alert('suspicious-move')], NOW + 99_999).map((n) => n.kind)).toEqual(['new']);
  });
});

describe('alertsFromReport', () => {
  const report = (rows: Partial<TickReport['rows'][number]>[]): TickReport => ({
    at: NOW,
    rows: rows.map((r) => ({ asset: ASSET, action: 'wait', detail: '', alerts: [], ...r })),
  });

  it('collects every alert and failed action from a pass', () => {
    const a = alertsFromReport(report([{ alerts: [{ severity: 'critical', code: 'no-quote', message: 'm' }], error: 'evidence: boom' }]), 0);
    expect(a.map((x) => x.code).sort()).toEqual(['action-failed', 'no-quote']);
    expect(a.find((x) => x.code === 'action-failed')!.severity).toBe('warn');
  });

  it('reports a keeper that keeps failing, but not the first failures', () => {
    expect(alertsFromReport(undefined, 2, 'rpc down')).toEqual([]);
    const a = alertsFromReport(undefined, 3, 'rpc down');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ code: 'tick-failing', severity: 'critical' });
    expect(a[0]!.message).toMatch(/3 keeper passes in a row failed.*rpc down/);
  });
});

describe('messages', () => {
  const n = (kind: Notification['kind']): Notification => ({ kind, alert: alert('suspicious-move'), firedFor: 7200 });

  it('says what happened, where, and for how long', () => {
    expect(formatText(n('new'), ctx)).toBe(
      'Damper keeper: CRITICAL: suspicious-move on Stellar:CDLZFC…CYSC (oracle CCBCV5…36GQ, testnet)\nsuspicious-move message',
    );
    expect(formatText(n('reminder'), ctx)).toMatch(/STILL FIRING after 2\.0 h \[critical\]: suspicious-move/);
    expect(formatText(n('resolved'), ctx)).toMatch(/RESOLVED after 2\.0 h: suspicious-move/);
  });

  it('builds the payload each service expects', () => {
    expect(Object.keys(buildPayload('slack', n('new'), ctx, NOW))).toEqual(['text']);
    expect(Object.keys(buildPayload('discord', n('new'), ctx, NOW))).toEqual(['content']);
    const j = buildPayload('json', n('new'), ctx, NOW);
    expect(j).toMatchObject({ source: 'damper-keeper', kind: 'new', severity: 'critical', code: 'suspicious-move', network: 'testnet', firedForSecs: 7200 });
    expect(j.at).toBe(new Date(NOW * 1000).toISOString());
  });

  it('keeps a Discord message under its 2000-character limit', () => {
    const long: Notification = { kind: 'new', alert: { ...alert('x'), message: 'y'.repeat(5000) }, firedFor: 0 };
    expect((buildPayload('discord', long, ctx, NOW).content as string).length).toBeLessThanOrEqual(1900);
  });
});

describe('parseWebhookUrl', () => {
  it('accepts https, and http only for this machine', () => {
    expect(parseWebhookUrl('https://hooks.example.com/services/T000/B000/secret').host).toBe('hooks.example.com');
    expect(parseWebhookUrl('http://localhost:8080/x').host).toBe('localhost:8080');
    expect(parseWebhookUrl('http://127.0.0.1:9/x').hostname).toBe('127.0.0.1');
  });
  it('rejects plain http elsewhere, other schemes and junk', () => {
    for (const bad of ['http://hooks.example.com/x', 'ftp://x.example/y', 'file:///etc/passwd', 'not a url', '']) {
      expect(() => parseWebhookUrl(bad)).toThrow(NotifyError);
    }
  });
});

describe('deliver', () => {
  const url = new URL('https://hooks.example.com/services/T000/B000/SECRET-TOKEN');
  const res = (status: number, headers: Record<string, string> = {}) => new Response('', { status, headers });
  const noWait = async () => {};

  it('retries server errors and rate limits, then succeeds', async () => {
    const seq = [res(503), res(429, { 'retry-after': '2' }), res(200)];
    const waits: number[] = [];
    await deliver(url, {}, { fetchImpl: (async () => seq.shift()!) as unknown as typeof fetch, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1000, 2000]);
  });

  it('retries a network error', async () => {
    let calls = 0;
    await deliver(url, {}, { sleep: noWait, fetchImpl: (async () => { if (++calls < 3) throw new TypeError('fetch failed'); return res(200); }) as unknown as typeof fetch });
    expect(calls).toBe(3);
  });

  it('does not retry a client error, which means the URL or payload is wrong', async () => {
    let calls = 0;
    await expect(deliver(url, {}, { sleep: noWait, fetchImpl: (async () => (calls++, res(404))) as unknown as typeof fetch })).rejects.toThrow(/answered 404/);
    expect(calls).toBe(1);
  });

  it('gives up after the attempts, and an error names only the host, never the secret', async () => {
    const err = await deliver(url, {}, { sleep: noWait, attempts: 2, fetchImpl: (async () => res(500)) as unknown as typeof fetch }).catch((e: Error) => e);
    expect((err as Error).message).toBe('hooks.example.com answered 500 after 2 attempts');
    const net = await deliver(url, {}, { sleep: noWait, attempts: 1, fetchImpl: (async () => { throw new TypeError('boom https://hooks.example.com/services/T000/B000/SECRET-TOKEN'); }) as unknown as typeof fetch }).catch((e: Error) => e);
    expect((net as Error).message).not.toMatch(/SECRET-TOKEN/);
    expect((net as Error).message).toMatch(/could not reach hooks\.example\.com/);
  });
});

describe('Notifier against a real HTTP receiver', () => {
  async function receiver(status = 200) {
    const got: { path: string; body: any }[] = [];
    let respond = status;
    const server = createServer((req: IncomingMessage, out) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        if (respond < 400) got.push({ path: req.url!, body: JSON.parse(data) });
        out.statusCode = respond;
        out.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { got, url: parseWebhookUrl(`http://127.0.0.1:${port}/hook/SECRET`), setStatus: (s: number) => (respond = s), close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const report = (codes: string[]): TickReport => ({
    at: NOW,
    rows: [{ asset: ASSET, action: 'hold', detail: '', alerts: codes.map((code) => ({ severity: 'critical' as const, code, message: `${code}!` })) }],
  });

  it('sends a new alert, stays quiet, then reports it resolved', async () => {
    const rx = await receiver();
    const logs: string[] = [];
    const n = new Notifier(rx.url, 'json', ctx, undefined, { sleep: async () => {} }, (l) => logs.push(l));
    await n.afterPass(report(['suspicious-move']), undefined, NOW);
    await n.afterPass(report(['suspicious-move']), undefined, NOW + 300);
    await n.afterPass(report([]), undefined, NOW + 600);
    expect(rx.got.map((g) => g.body.kind)).toEqual(['new', 'resolved']);
    expect(rx.got[0]!.path).toBe('/hook/SECRET');
    expect(rx.got[0]!.body.text).toMatch(/CRITICAL: suspicious-move/);
    expect(logs).toEqual([]);
    await rx.close();
  });

  it('survives an outage of the receiver and delivers once it is back', async () => {
    const rx = await receiver(500);
    const logs: string[] = [];
    const n = new Notifier(rx.url, 'slack', ctx, undefined, { sleep: async () => {}, attempts: 1 }, (l) => logs.push(l));
    await n.afterPass(report(['no-quote']), undefined, NOW); // fails, must not throw
    expect(rx.got).toHaveLength(0);
    expect(logs[0]).toMatch(/alert not delivered \(new no-quote/);
    rx.setStatus(200);
    await n.afterPass(report(['no-quote']), undefined, NOW + 300);
    expect(rx.got).toHaveLength(1);
    expect(Object.keys(rx.got[0]!.body)).toEqual(['text']);
    await rx.close();
  });

  it('reports a keeper that cannot run, without calling anything resolved during the outage', async () => {
    const rx = await receiver();
    const n = new Notifier(rx.url, 'json', ctx, undefined, { sleep: async () => {} }, () => {});
    await n.afterPass(report(['no-quote']), undefined, NOW);
    for (let i = 1; i <= 3; i++) await n.afterPass(undefined, 'rpc down', NOW + i * 300);
    expect(rx.got.map((g) => g.body.code)).toEqual(['no-quote', 'tick-failing']);
    await n.afterPass(report(['no-quote']), undefined, NOW + 1500);
    expect(rx.got.map((g) => `${g.body.kind}:${g.body.code}`)).toEqual(['new:no-quote', 'new:tick-failing', 'resolved:tick-failing']);
    await rx.close();
  });

  it('sends a test alert', async () => {
    const rx = await receiver();
    await new Notifier(rx.url, 'json', ctx).test(NOW);
    expect(rx.got[0]!.body.code).toBe('test');
    await rx.close();
  });
});
