import { describe, expect, it } from 'vitest';
import { depth, midPrice, usdcToPushDown, usdcToPushUp, type OrderBook } from '../src/market.js';
import { parseSacName } from '../src/assets.js';

// Shape of the USTRY/USDC book read from Horizon on 2026-11-17: a market maker
// quotes tight around $1.08 and one stale offer from the night of the YieldBlox
// exploit still rests at $106.74.
const ustry: OrderBook = {
  asks: [
    { price: 1.0809492, amount: 4601.92 },
    { price: 1.0812084, amount: 47765.66 },
    { price: 1.0822353, amount: 195609.01 },
    { price: 1.105, amount: 18.1 },
    { price: 1.1061911, amount: 54.24 },
    { price: 1.1292374, amount: 100 },
    { price: 106.7372828, amount: 1.1684309 },
  ],
  bids: [
    { price: 1.080409, amount: 20.74 },
    { price: 1.0804088, amount: 4489.81 },
    { price: 1.0801277, amount: 52408.55 },
    { price: 1.0791014, amount: 215616.37 },
    { price: 0.0236, amount: 19 },
  ],
};

describe('order book depth', () => {
  it('mid is the average of best bid and ask', () => {
    expect(midPrice(ustry)).toBeCloseTo(1.08068, 4);
  });

  it('cost to push up counts only asks below the target', () => {
    const toDouble = usdcToPushUp(ustry, 2 * midPrice(ustry)!);
    expect(toDouble).toBeGreaterThan(268_000);
    expect(toDouble).toBeLessThan(269_000);
    // nothing rests between 2x and 10x, so they cost the same
    expect(usdcToPushUp(ustry, 10 * midPrice(ustry)!)).toBe(toDouble);
    // 100x (~$108) lies above the stale $106.74 offer, so it has to be bought too
    expect(usdcToPushUp(ustry, 100 * midPrice(ustry)!)).toBeCloseTo(toDouble + 106.7372828 * 1.1684309, 6);
  });

  it('cost to push down sells into bids above the target', () => {
    const mid = midPrice(ustry)!;
    const v = usdcToPushDown(ustry, mid / 2, mid);
    // bids above $0.54 hold ~272.5k USDC, i.e. ~252.3k USTRY at their prices
    expect(v / mid).toBeGreaterThan(252_000);
    expect(v / mid).toBeLessThan(253_000);
  });

  it('empty book has no cost and no mid', () => {
    const d = depth({ asks: [], bids: [] });
    expect(d.mid).toBeUndefined();
    expect(d.up10x).toBe(0);
  });

  it('one-sided book uses the side that exists', () => {
    expect(midPrice({ asks: [{ price: 2, amount: 1 }], bids: [] })).toBe(2);
  });
});

describe('SAC names', () => {
  it('parses classic assets and native', () => {
    expect(parseSacName('native')).toEqual({ code: 'XLM', issuer: undefined });
    expect(parseSacName('USTRY:GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC')).toEqual({
      code: 'USTRY',
      issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
    });
  });
  it('rejects custom token names', () => {
    expect(parseSacName('Blend Token')).toBeUndefined();
    expect(parseSacName('')).toBeUndefined();
  });
});
