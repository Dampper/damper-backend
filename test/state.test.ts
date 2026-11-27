import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyState, loadState, saveState, toMap, toNotifyState } from '../src/keeper/state.js';
import { planNotifications, recordDelivery, type ActiveAlert, type NotifyState } from '../src/keeper/notify.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'damper-state-'));
  path = join(dir, 'keeper-state.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadState', () => {
  it('is empty when the file does not exist', async () => {
    expect(await loadState(path)).toEqual(emptyState());
  });

  it('round-trips through saveState', async () => {
    const m = new Map([['Stellar:CABC', 1_800_000_000], ['Stellar:CXYZ', 1_800_000_300]]);
    await saveState(path, m);
    const loaded = await loadState(path);
    expect(toMap(loaded)).toEqual(m);
  });

  it('ignores a malformed file instead of throwing', async () => {
    await writeFile(path, 'not json at all {{{');
    expect(await loadState(path)).toEqual(emptyState());
  });

  it('drops entries whose value is not a finite number, and keeps the rest', async () => {
    await writeFile(path, JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', suspicious: { good: 5, bad: 'nope', nan: NaN, nested: {} } }));
    const loaded = await loadState(path);
    expect(loaded.suspicious).toEqual({ good: 5 });
    expect(loaded.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('tolerates a file that is valid JSON but not an object shaped like state', async () => {
    await writeFile(path, JSON.stringify([1, 2, 3]));
    expect(await loadState(path)).toEqual(emptyState());
  });
});

describe('saveState', () => {
  it('writes keys sorted, for stable diffs', async () => {
    await saveState(path, new Map([['b', 2], ['a', 1]]));
    const text = await readFile(path, 'utf8');
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('an empty map still produces a valid, loadable file', async () => {
    await saveState(path, new Map());
    expect(toMap(await loadState(path))).toEqual(new Map());
  });
});

describe('NotifyState persistence (#10)', () => {
  const alert: ActiveAlert = {
    key: 'Stellar:CABC|suspicious-move',
    asset: 'Stellar:CABC',
    code: 'suspicious-move',
    severity: 'critical',
    message: 'suspicious-move message',
  };

  it('round-trips a notify map through saveState/loadState alongside the hold clock', async () => {
    const suspicious = new Map([['Stellar:CABC', 1_800_000_000]]);
    const notify: NotifyState = new Map([[alert.key, { alert, firstSeen: 1_800_000_000, lastSent: 1_800_000_050 }]]);

    await saveState(path, suspicious, notify);
    const loaded = await loadState(path);

    expect(toMap(loaded)).toEqual(suspicious);
    expect(toNotifyState(loaded)).toEqual(notify);
  });

  it('round-trips a tracked alert that was never delivered (lastSent undefined)', async () => {
    const notify: NotifyState = new Map([[alert.key, { alert, firstSeen: 1_800_000_000, lastSent: undefined }]]);

    await saveState(path, new Map(), notify);

    expect(toNotifyState(await loadState(path))).toEqual(notify);
  });

  it('writing with no notify state at all still produces a loadable, empty notify map', async () => {
    await saveState(path, new Map([['a', 1]]));
    expect(toNotifyState(await loadState(path))).toEqual(new Map());
  });

  it('drops a notify entry with a missing field or an unknown severity, keeping the rest', async () => {
    await writeFile(
      path,
      JSON.stringify({
        updatedAt: '2026-01-01T00:00:00.000Z',
        suspicious: {},
        notify: {
          good: { alert, firstSeen: 1, lastSent: undefined },
          'missing-firstSeen': { alert, lastSent: 1 },
          'bad-severity': { alert: { ...alert, severity: 'severe' }, firstSeen: 1, lastSent: undefined },
          'not-an-object': 42,
        },
      }),
    );

    const loaded = await loadState(path);

    expect(Object.keys(loaded.notify)).toEqual(['good']);
    expect(loaded.notify.good).toEqual({ alert, firstSeen: 1, lastSent: undefined });
  });

  it('a reloaded notify state does not resend an alert that was already delivered', async () => {
    const now = 1_800_000_000;
    const state: NotifyState = new Map();
    const current: ActiveAlert[] = [alert];

    // First pass: the alert is new and gets delivered.
    const firstPlan = planNotifications(state, current, now);
    expect(firstPlan.map((n) => n.kind)).toEqual(['new']);
    recordDelivery(state, firstPlan[0]!, true, now);

    // Persist and reload, as a scheduled `--once` run would between passes.
    await saveState(path, new Map(), state);
    const reloaded = toNotifyState(await loadState(path));

    // Second pass, shortly after: the same alert is still firing, but it was already
    // delivered and the reminder interval has not elapsed, so nothing is sent again.
    const secondPlan = planNotifications(reloaded, current, now + 60);
    expect(secondPlan).toEqual([]);

    // Long after, once the reminder interval has elapsed, it is sent as a reminder — not
    // mistaken for new, because the reloaded state remembers firstSeen and lastSent.
    const reminderPlan = planNotifications(reloaded, current, now + 7 * 3600);
    expect(reminderPlan).toEqual([{ kind: 'reminder', alert, firedFor: 7 * 3600 }]);
  });
});
