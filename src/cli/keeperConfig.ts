/**
 * The keeper's flag and environment parsing, pulled out of `keeper.ts` so the precedence
 * rules (a flag always beats its environment variable, then the default) can be tested
 * without touching `process.argv` or `process.env` (#17).
 */
import { parseArgs } from 'node:util';

const PARSE_ARGS_OPTIONS = {
  oracle: { type: 'string' },
  network: { type: 'string' },
  rpc: { type: 'string' },
  once: { type: 'boolean', default: false },
  interval: { type: 'string' },
  submit: { type: 'boolean', default: false },
  pool: { type: 'string' },
  'exposure-usd': { type: 'string' },
  'market-horizon': { type: 'string' },
  'webhook-format': { type: 'string' },
  'alert-min': { type: 'string' },
  'alert-reminder-hours': { type: 'string' },
  'test-alert': { type: 'boolean', default: false },
  'test-heartbeat': { type: 'boolean', default: false },
  state: { type: 'string' },
  'status-file': { type: 'string' },
} as const;

export interface KeeperConfig {
  oracle: string | undefined;
  network: string;
  rpc: string | undefined;
  once: boolean;
  interval: string;
  submit: boolean;
  pool: string | undefined;
  'exposure-usd': string | undefined;
  'market-horizon': string | undefined;
  'webhook-format': string;
  'alert-min': string;
  'alert-reminder-hours': string;
  'test-alert': boolean;
  'test-heartbeat': boolean;
  state: string | undefined;
  'status-file': string | undefined;
}

/** A thin, env-only view so callers can pass `process.env` or a plain test object. */
export type Env = Partial<Record<string, string | undefined>>;

/**
 * Every setting below a CLI flag can also come from an environment variable, so a host that
 * only offers an env var editor (Render, and similar container platforms) needs no
 * constructed argument string. A flag given on the command line always wins; the variable is
 * used only when the flag is absent, and a default applies only when neither is given.
 *
 * `argv` is the argument list after the program and script name (what `parseArgs` expects by
 * default, i.e. `process.argv.slice(2)`).
 */
export function resolveConfig(argv: string[], env: Env): KeeperConfig {
  const { values: flags } = parseArgs({ args: argv, options: PARSE_ARGS_OPTIONS });
  const str = (name: string) => env[name] || undefined;
  const truthy = (name: string) => ['1', 'true', 'yes'].includes((env[name] ?? '').toLowerCase());

  return {
    ...flags,
    oracle: flags.oracle ?? str('DAMPER_ORACLE'),
    network: flags.network ?? str('DAMPER_NETWORK') ?? 'mainnet',
    interval: flags.interval ?? str('DAMPER_INTERVAL') ?? '300',
    submit: flags.submit || truthy('DAMPER_SUBMIT'),
    pool: flags.pool ?? str('DAMPER_POOL'),
    'exposure-usd': flags['exposure-usd'] ?? str('DAMPER_EXPOSURE_USD'),
    'market-horizon': flags['market-horizon'] ?? str('DAMPER_MARKET_HORIZON'),
    'webhook-format': flags['webhook-format'] ?? str('DAMPER_WEBHOOK_FORMAT') ?? 'json',
    'alert-min': flags['alert-min'] ?? str('DAMPER_ALERT_MIN') ?? 'warn',
    'alert-reminder-hours': flags['alert-reminder-hours'] ?? str('DAMPER_ALERT_REMINDER_HOURS') ?? '6',
    state: flags.state ?? str('DAMPER_STATE_FILE'),
    'status-file': flags['status-file'] ?? str('DAMPER_STATUS_FILE'),
  };
}
