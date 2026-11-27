import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  depth,
  fetchOrderBook,
  midPrice,
  ORDER_BOOK_PAGE_LIMIT,
  usdcToPushDown,
  usdcToPushUp,
  type OrderBook,
} from '../src/market.js';
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

describe('order book truncation at Horizon\'s 200-level limit (#20)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function levels(n: number, step = 0.01, from = 1): { price: string; amount: string }[] {
    return Array.from({ length: n }, (_, i) => ({ price: (from + i * step).toFixed(6), amount: '100' }));
  }

  const asset = { code: 'USTRY', issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC' };
  const quote = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' };

  function mockHorizon(asks: { price: string; amount: string }[], bids: { price: string; amount: string }[]) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ asks, bids }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('flags a side as truncated only when Horizon returns exactly the page limit', async () => {
    mockHorizon(levels(ORDER_BOOK_PAGE_LIMIT), levels(ORDER_BOOK_PAGE_LIMIT, -0.01));
    const full = await fetchOrderBook('https://horizon.example', asset, quote);
    expect(full.asksTruncated).toBe(true);
    expect(full.bidsTruncated).toBe(true);

    mockHorizon(levels(ORDER_BOOK_PAGE_LIMIT - 1), levels(3, -0.01));
    const partial = await fetchOrderBook('https://horizon.example', asset, quote);
    expect(partial.asksTruncated).toBe(false);
    expect(partial.bidsTruncated).toBe(false);
  });

  it('requests exactly the page limit from Horizon', async () => {
    const fetchMock = mockHorizon([], []);
    await fetchOrderBook('https://horizon.example', asset, quote);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('limit')).toBe(String(ORDER_BOOK_PAGE_LIMIT));
  });

  it('is not a lower bound when the book is small enough to be read in full', () => {
    const small: OrderBook = { asks: [{ price: 2, amount: 1 }], bids: [{ price: 1, amount: 1 }] };
    const d = depth(small);
    expect(d.upIsLowerBound).toBe(false);
    expect(d.downIsLowerBound).toBe(false);
  });

  it('is a lower bound when the truncated side runs out before reaching the 100x/0.1x target', () => {
    // mid = 1.5; 100x target = 150, 0.1x target = 0.15. These 200-level pages never get near either.
    const truncated: OrderBook = {
      asks: levels(ORDER_BOOK_PAGE_LIMIT, 0.001, 1).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })),
      bids: levels(ORDER_BOOK_PAGE_LIMIT, -0.001, 1).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })),
      asksTruncated: true,
      bidsTruncated: true,
    };
    const d = depth(truncated);
    expect(d.mid).toBeCloseTo(1, 3);
    expect(d.upIsLowerBound).toBe(true);
    expect(d.downIsLowerBound).toBe(true);
  });

  it('is not a lower bound when the truncated side already clears past the target', () => {
    // Asks run from 1 up to 1 + 199*2 = 399, far past the 100x target of 150; the 429-level
    // cutoff cannot be hiding anything that would change up100x.
    const wide: OrderBook = {
      asks: levels(ORDER_BOOK_PAGE_LIMIT, 2, 1).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })),
      bids: [{ price: 1, amount: 1 }],
      asksTruncated: true,
    };
    const d = depth(wide);
    expect(d.upIsLowerBound).toBe(false);
  });

  it('flags only the side that is actually truncated', () => {
    const asksOnly: OrderBook = {
      asks: levels(ORDER_BOOK_PAGE_LIMIT, 0.001, 1).map((l) => ({ price: Number(l.price), amount: Number(l.amount) })),
      bids: [{ price: 1, amount: 1 }],
      asksTruncated: true,
      bidsTruncated: false,
    };
    const d = depth(asksOnly);
    expect(d.upIsLowerBound).toBe(true);
    expect(d.downIsLowerBound).toBe(false);
  });
});
