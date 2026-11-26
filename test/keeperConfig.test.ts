import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/cli/keeperConfig.js';

const DEFAULTS = {
  oracle: undefined,
  network: 'mainnet',
  rpc: undefined,
  once: false,
  interval: '300',
  submit: false,
  pool: undefined,
  'exposure-usd': undefined,
  'market-horizon': undefined,
  'webhook-format': 'json',
  'alert-min': 'warn',
  'alert-reminder-hours': '6',
  'test-alert': false,
  'test-heartbeat': false,
  state: undefined,
  'status-file': undefined,
};

describe('resolveConfig defaults', () => {
  it('uses the documented default for every setting when neither a flag nor an env var is given', () => {
    expect(resolveConfig([], {})).toEqual(DEFAULTS);
  });

  it('ignores unrelated environment variables', () => {
    expect(resolveConfig([], { PATH: '/usr/bin', HOME: '/root' })).toEqual(DEFAULTS);
  });
});

// Every [flag, value, env, config key] triple below is tried three ways: flag only, env
// only, and both together (where the flag must win) — the exact precedence the issue asks for.
const STRING_CASES: [string, string, string, keyof typeof DEFAULTS][] = [
  ['--oracle', 'CORACLE', 'DAMPER_ORACLE', 'oracle'],
  ['--network', 'testnet', 'DAMPER_NETWORK', 'network'],
  ['--interval', '120', 'DAMPER_INTERVAL', 'interval'],
  ['--pool', 'CPOOL', 'DAMPER_POOL', 'pool'],
  ['--exposure-usd', '50000', 'DAMPER_EXPOSURE_USD', 'exposure-usd'],
  ['--market-horizon', 'https://horizon.example', 'DAMPER_MARKET_HORIZON', 'market-horizon'],
  ['--webhook-format', 'slack', 'DAMPER_WEBHOOK_FORMAT', 'webhook-format'],
  ['--alert-min', 'critical', 'DAMPER_ALERT_MIN', 'alert-min'],
  ['--alert-reminder-hours', '12', 'DAMPER_ALERT_REMINDER_HOURS', 'alert-reminder-hours'],
  ['--state', 'data/state.json', 'DAMPER_STATE_FILE', 'state'],
  ['--status-file', 'data/status.json', 'DAMPER_STATUS_FILE', 'status-file'],
];

describe.each(STRING_CASES)('%s / %s', (flag, flagValue, envVar, key) => {
  it('is read from the flag', () => {
    expect(resolveConfig([flag, flagValue], {})[key]).toBe(flagValue);
  });

  it('is read from the environment when the flag is absent', () => {
    expect(resolveConfig([], { [envVar]: flagValue })[key]).toBe(flagValue);
  });

  it('prefers the flag over the environment variable', () => {
    const config = resolveConfig([flag, flagValue], { [envVar]: 'from-env-should-be-ignored' });
    expect(config[key]).toBe(flagValue);
  });

  it('falls back to the documented default when neither is given', () => {
    expect(resolveConfig([], {})[key]).toBe(DEFAULTS[key]);
  });
});

describe('--rpc', () => {
  // --rpc has no environment-variable form: it overrides the network's RPC endpoint for a
  // single run, so there is nothing to fall back to.
  it('is read only from the flag, with no default', () => {
    expect(resolveConfig(['--rpc', 'https://rpc.example'], {}).rpc).toBe('https://rpc.example');
    expect(resolveConfig([], { DAMPER_RPC: 'https://rpc.example' }).rpc).toBeUndefined();
  });
});

describe('boolean flags: --once, --test-alert, --test-heartbeat', () => {
  // None of these three has an environment-variable form.
  it.each(['once', 'test-alert', 'test-heartbeat'] as const)('%s defaults to false and is set by the flag alone', (name) => {
    expect(resolveConfig([], {})[name]).toBe(false);
    expect(resolveConfig([`--${name}`], {})[name]).toBe(true);
  });
});

describe('--submit / DAMPER_SUBMIT', () => {
  it('is false by default and true when the flag is given', () => {
    expect(resolveConfig([], {}).submit).toBe(false);
    expect(resolveConfig(['--submit'], {}).submit).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'TRUE', 'Yes'])('treats %s from the environment as true', (value) => {
    expect(resolveConfig([], { DAMPER_SUBMIT: value }).submit).toBe(true);
  });

  it.each(['0', 'false', 'no', '', 'nope'])('treats %s from the environment as false', (value) => {
    expect(resolveConfig([], { DAMPER_SUBMIT: value }).submit).toBe(false);
  });

  it('cannot be turned off by the environment once the flag is given (flag wins, booleans only OR together)', () => {
    expect(resolveConfig(['--submit'], { DAMPER_SUBMIT: 'false' }).submit).toBe(true);
  });

  it('is true when only the environment variable asks for it', () => {
    expect(resolveConfig([], { DAMPER_SUBMIT: 'true' }).submit).toBe(true);
  });
});

describe('precedence does not leak between settings', () => {
  it('resolves every setting independently in the same call', () => {
    const config = resolveConfig(['--oracle', 'CFLAG'], {
      DAMPER_ORACLE: 'CENV',
      DAMPER_NETWORK: 'testnet',
      DAMPER_ALERT_MIN: 'info',
    });
    expect(config.oracle).toBe('CFLAG'); // flag wins
    expect(config.network).toBe('testnet'); // env, no flag given
    expect(config['alert-min']).toBe('info'); // env, no flag given
    expect(config['webhook-format']).toBe('json'); // default, neither given
  });
});
