import { describe, expect, it } from 'vitest';
import { mergeRegistry, type PoolRegistry } from '../src/discovery.js';

const A = 'C' + 'A'.repeat(55);
const B = 'C' + 'B'.repeat(55);
const C = 'C' + 'C'.repeat(55);
const entry = (firstSeen: string, source = 'x') => ({ deployment: 'v2', source, firstSeen });

const base: PoolRegistry = {
  updatedAt: '2026-11-18T00:00:00.000Z',
  pools: { [A]: entry('2026-11-17T00:00:00.000Z', 'seed'), [B]: entry('2026-11-18T00:00:00.000Z') },
};

describe('mergeRegistry', () => {
  it('adds pools the base has not seen', () => {
    const merged = mergeRegistry(base, { pools: { [C]: entry('2026-11-10T00:00:00.000Z') } });
    expect(Object.keys(merged.pools).sort()).toEqual([A, B, C].sort());
  });

  it('keeps the earliest firstSeen and the base entry otherwise', () => {
    const merged = mergeRegistry(base, { pools: { [B]: entry('2026-11-01T00:00:00.000Z', 'other'), [A]: entry('2026-12-01T00:00:00.000Z') } });
    expect(merged.pools[B]).toEqual({ deployment: 'v2', source: 'x', firstSeen: '2026-11-01T00:00:00.000Z' });
    expect(merged.pools[A]!.firstSeen).toBe('2026-11-17T00:00:00.000Z');
  });

  it('ignores junk: bad ids, non-objects, missing pools', () => {
    expect(mergeRegistry(base, null)).toEqual(base);
    expect(mergeRegistry(base, { pools: 'x' })).toEqual(base);
    expect(mergeRegistry(base, { pools: { notanid: entry('2026-01-01T00:00:00.000Z'), [C]: 5 } })).toEqual(base);
  });

  it('does not change the base it was given', () => {
    const copy = structuredClone(base);
    mergeRegistry(base, { pools: { [C]: entry('2026-11-10T00:00:00.000Z') } });
    expect(base).toEqual(copy);
  });
});
