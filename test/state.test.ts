import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyState, loadState, saveState, toMap } from '../src/keeper/state.js';

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
