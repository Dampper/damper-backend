import { describe, expect, it } from 'vitest';
import { Heartbeat, unhealthyReason } from '../src/keeper/heartbeat.js';
import { NotifyError } from '../src/keeper/notify.js';
import type { TickReport } from '../src/keeper/run.js';

const row = (over: Partial<TickReport['rows'][number]> = {}): TickReport['rows'][number] => ({
  asset: 'Stellar:CABC', action: 'wait', detail: '', alerts: [], ...over,
});
const report = (...rows: TickReport['rows']): TickReport => ({ at: 1_800_000_000, rows });
const SECRET = 'https://hc-ping.example.com/0b7d8c1e-SECRET-UUID';

/** A monitor that records what it was asked for. */
function monitor(status = 200) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (u: URL, init: RequestInit) => {
    calls.push({ url: String(u), method: String(init.method), body: init.body });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const noWait = async () => {};

describe('unhealthyReason', () => {
  it('is healthy when every asset was handled, even if the news is bad', () => {
    expect(unhealthyReason(report(row(), row({ alerts: [{ code: 'no-quote', severity: 'critical', message: 'x' }] })), undefined)).toBeUndefined();
  });
  it('is unhealthy when the pass threw', () => {
    expect(unhealthyReason(undefined, 'rpc down')).toMatch(/rpc down/);
    expect(unhealthyReason(report(row()), 'rpc down')).toMatch(/rpc down/);
  });
  it('is unhealthy when an action failed on any asset', () => {
    expect(unhealthyReason(report(row(), row({ error: 'poke rejected' })), undefined)).toMatch(/1 of 2/);
  });
  it('treats an oracle with no assets as healthy', () => {
    expect(unhealthyReason(report(), undefined)).toBeUndefined();
  });
});

describe('Heartbeat', () => {
  it('requests the URL with GET and no body after a healthy pass', async () => {
    const m = monitor();
    const hb = Heartbeat.fromUrl(SECRET, { fetchImpl: m.fetchImpl, sleep: noWait }, () => {});
    expect(await hb.afterPass(report(row()), undefined)).toBe('sent');
    expect(m.calls).toEqual([{ url: SECRET, method: 'GET', body: undefined }]);
  });

  it('stays silent after an unhealthy pass, which is the signal', async () => {
    const m = monitor();
    const hb = Heartbeat.fromUrl(SECRET, { fetchImpl: m.fetchImpl, sleep: noWait }, () => {});
    expect(await hb.afterPass(undefined, 'rpc down')).toBe('withheld');
    expect(await hb.afterPass(report(row({ error: 'x' })), undefined)).toBe('withheld');
    expect(m.calls).toHaveLength(0);
  });

  it('never throws when the monitor is down, and says so once', async () => {
    const lines: string[] = [];
    const hb = Heartbeat.fromUrl(SECRET, { fetchImpl: monitor(500).fetchImpl, sleep: noWait, attempts: 2 }, (l) => lines.push(l));
    expect(await hb.afterPass(report(row()), undefined)).toBe('failed');
    expect(await hb.afterPass(report(row()), undefined)).toBe('failed');
    expect(lines.filter((l) => l.includes('not delivered'))).toHaveLength(1);
  });

  it('logs when it withholds and when it resumes, not on every pass', async () => {
    const lines: string[] = [];
    const m = monitor();
    const hb = Heartbeat.fromUrl(SECRET, { fetchImpl: m.fetchImpl, sleep: noWait }, (l) => lines.push(l));
    await hb.afterPass(report(row()), undefined);
    await hb.afterPass(undefined, 'boom');
    await hb.afterPass(undefined, 'boom');
    await hb.afterPass(report(row()), undefined);
    await hb.afterPass(report(row()), undefined);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/withheld/);
    expect(lines[1]).toMatch(/resumed/);
  });

  it('never prints the secret part of the URL', async () => {
    const lines: string[] = [];
    const hb = Heartbeat.fromUrl(SECRET, { fetchImpl: monitor(404).fetchImpl, sleep: noWait }, (l) => lines.push(l));
    await hb.afterPass(report(row()), undefined);
    await hb.afterPass(undefined, 'error');
    await expect(hb.ping()).rejects.toThrow(/hc-ping\.example\.com/);
    const all = [...lines, String(await hb.ping().catch((e: Error) => e.message))].join('\n');
    expect(all).not.toContain('SECRET');
    expect(hb.host).toBe('hc-ping.example.com');
  });

  it('refuses a plain-http or malformed URL', () => {
    expect(() => Heartbeat.fromUrl('http://hc.example.com/x')).toThrow(NotifyError);
    expect(() => Heartbeat.fromUrl('not a url')).toThrow(NotifyError);
    expect(() => Heartbeat.fromUrl('http://localhost:8080/x')).not.toThrow();
  });
});
