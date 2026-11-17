/**
 * Stellar DEX (SDEX) market depth for assets priced by the Reflector DEX feed.
 *
 * Reflector's DEX feed derives prices from trades. To print a trade at price P, an
 * attacker has to buy through every resting ask below P first (then can trade with
 * themselves at P). The USDC needed to clear the book up to P is therefore the capital
 * needed to make the feed see P. Most of it is not lost, since the attacker receives the
 * asset, but it bounds who can do it. Pushing the price *down* is the mirror image on
 * the bid side.
 */

export interface Level {
  price: number;
  amount: number;
}

export interface OrderBook {
  /** Offers selling the asset for USDC, best (lowest) first. amount is in the asset. */
  asks: Level[];
  /** Offers buying the asset with USDC, best (highest) first. amount is in USDC. */
  bids: Level[];
}

export function midPrice(book: OrderBook): number | undefined {
  const ask = book.asks[0]?.price;
  const bid = book.bids[0]?.price;
  if (ask !== undefined && bid !== undefined) return (ask + bid) / 2;
  return ask ?? bid;
}

/** USDC needed to buy every ask priced strictly below `target`. */
export function usdcToPushUp(book: OrderBook, target: number): number {
  let usdc = 0;
  for (const { price, amount } of book.asks) {
    if (price >= target) break;
    usdc += price * amount;
  }
  return usdc;
}

/** Units of the asset that must be sold into every bid priced strictly above `target`, valued at the reference price. */
export function usdcToPushDown(book: OrderBook, target: number, reference: number): number {
  let units = 0;
  for (const { price, amount } of book.bids) {
    if (price <= target) break;
    units += amount / price;
  }
  return units * reference;
}

export interface Depth {
  mid: number | undefined;
  /** USDC to make the feed see 2x, 10x and 100x the mid price. */
  up2x: number;
  up10x: number;
  up100x: number;
  /** Value sold to make the feed see 0.5x and 0.1x the mid price. */
  down2x: number;
  down10x: number;
}

export function depth(book: OrderBook): Depth {
  const mid = midPrice(book);
  if (mid === undefined) return { mid, up2x: 0, up10x: 0, up100x: 0, down2x: 0, down10x: 0 };
  return {
    mid,
    up2x: usdcToPushUp(book, mid * 2),
    up10x: usdcToPushUp(book, mid * 10),
    up100x: usdcToPushUp(book, mid * 100),
    down2x: usdcToPushDown(book, mid / 2, mid),
    down10x: usdcToPushDown(book, mid / 10, mid),
  };
}

// ------------------------------------------------------------------ Horizon

export interface ClassicAsset {
  code: string;
  issuer: string | undefined; // undefined for native XLM
}

function assetParams(prefix: 'selling' | 'buying' | 'base' | 'counter', a: ClassicAsset) {
  if (!a.issuer) return { [`${prefix}_asset_type`]: 'native' };
  return {
    [`${prefix}_asset_type`]: a.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    [`${prefix}_asset_code`]: a.code,
    [`${prefix}_asset_issuer`]: a.issuer,
  };
}

async function horizon<T>(base: string, path: string, params: Record<string, string>): Promise<T> {
  const url = `${base}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`horizon ${path} ${res.status}`);
  return (await res.json()) as T;
}

/** SDEX order book for `asset` quoted in `quote`. */
export async function fetchOrderBook(horizonUrl: string, asset: ClassicAsset, quote: ClassicAsset): Promise<OrderBook> {
  const raw = await horizon<{ asks: { price: string; amount: string }[]; bids: { price: string; amount: string }[] }>(
    horizonUrl,
    '/order_book',
    { ...assetParams('selling', asset), ...assetParams('buying', quote), limit: '200' },
  );
  return {
    asks: raw.asks.map((l) => ({ price: Number(l.price), amount: Number(l.amount) })),
    bids: raw.bids.map((l) => ({ price: Number(l.price), amount: Number(l.amount) })),
  };
}

/** Quote-asset volume traded on SDEX (order book and classic AMM) over the last `hours`. */
export async function fetchVolume(
  horizonUrl: string,
  asset: ClassicAsset,
  quote: ClassicAsset,
  hours = 24,
): Promise<number> {
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const raw = await horizon<{ _embedded: { records: { counter_volume: string }[] } }>(
    horizonUrl,
    '/trade_aggregations',
    {
      ...assetParams('base', asset),
      ...assetParams('counter', quote),
      start_time: String(start),
      end_time: String(end),
      resolution: '3600000',
      limit: String(hours + 1),
    },
  );
  return raw._embedded.records.reduce((s, r) => s + Number(r.counter_volume), 0);
}
