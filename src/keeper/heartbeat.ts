/**
 * A heartbeat for the keeper itself.
 *
 * Alerts come from the keeper, so they cannot report that the keeper is dead, hung or
 * unplugged. The way round is to turn silence into the signal: after each healthy pass the
 * keeper requests a URL held by an external monitor (healthchecks.io, Uptime Kuma, Better
 * Stack, Cronitor, a Cloudflare worker: anything that alerts when its URL has not been
 * requested for a while). The monitor, not the keeper, decides when "a while" has passed.
 *
 * What counts as healthy is the part worth getting right. A pass that threw, or in which an
 * action failed, does not ping: the keeper is not doing its job, and the monitor should say
 * so even if the process is up. A pass that found something alarming (an oracle with no
 * quote, a pump held) does ping: the keeper worked, and the alert channel carries the news.
 * The URL is a secret (whoever has it can mark the keeper alive), so it comes from the
 * environment only and is printed only as a host name.
 */
import { deliver, parseWebhookUrl, type DeliverOptions } from './notify.js';
import type { TickReport } from './run.js';

/** Why a pass is not healthy, or undefined when it is. */
export function unhealthyReason(report: TickReport | undefined, error: string | undefined): string | undefined {
  if (error || !report) return `the pass failed: ${error ?? 'no report'}`;
  const bad = report.rows.filter((r) => r.error);
  if (bad.length > 0) return `${bad.length} of ${report.rows.length} assets had a failed action`;
  return undefined;
}

export type PingResult = 'sent' | 'withheld' | 'failed';

export class Heartbeat {
  private last: PingResult | undefined;

  constructor(
    private readonly url: URL,
    private readonly dep: DeliverOptions = {},
    private readonly log: (line: string) => void = console.log,
  ) {}

  /** Same `https` rule as the alert webhook. */
  static fromUrl(raw: string, dep: DeliverOptions = {}, log?: (line: string) => void): Heartbeat {
    return new Heartbeat(parseWebhookUrl(raw), dep, log);
  }

  get host(): string {
    return this.url.host;
  }

  /** Call after every pass. Never throws: a monitor outage must not stop the keeper. */
  async afterPass(report: TickReport | undefined, error: string | undefined): Promise<PingResult> {
    const why = unhealthyReason(report, error);
    let result: PingResult;
    if (why) {
      result = 'withheld';
      // say it once per change, not every five minutes
      if (this.last !== 'withheld') this.log(`heartbeat withheld, ${why}; ${this.host} will alert if this continues`);
    } else {
      try {
        await this.ping();
        result = 'sent';
        if (this.last === 'withheld' || this.last === 'failed') this.log(`heartbeat resumed (${this.host})`);
      } catch (e) {
        result = 'failed';
        if (this.last !== 'failed') this.log(`heartbeat not delivered: ${(e as Error).message}`);
      }
    }
    this.last = result;
    return result;
  }

  /** One ping, to prove the monitor is wired up. Throws if it cannot be delivered. */
  async ping(): Promise<void> {
    await deliver(this.url, undefined, { ...this.dep, method: 'GET' });
  }
}
