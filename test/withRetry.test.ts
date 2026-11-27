import { describe, expect, it, vi } from 'vitest';
import { MAX_RETRY_AFTER_MS, withRetry, type RetryableError } from '../src/scan.js';

function trackSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { calls, sleep };
}

function retryable(message: string, retryAfterMs?: number): RetryableError {
  const e = new Error(message) as RetryableError;
  if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
  return e;
}

describe('withRetry', () => {
  it('returns the result without retrying when fn succeeds', async () => {
    const { calls, sleep } = trackSleep();
    await expect(withRetry(async () => 'ok', 5, sleep)).resolves.toBe('ok');
    expect(calls).toEqual([]);
  });

  it('gives up immediately on a non-transient error', async () => {
    const { sleep } = trackSleep();
    const fn = vi.fn(async () => {
      throw new Error('not found');
    });
    await expect(withRetry(fn, 5, sleep)).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error with exponential backoff when it carries no Retry-After', async () => {
    const { calls, sleep } = trackSleep();
    let n = 0;
    const result = await withRetry(
      async () => {
        n += 1;
        if (n < 4) throw retryable('fetch failed');
        return 'done';
      },
      5,
      sleep,
    );
    expect(result).toBe('done');
    expect(calls).toEqual([1000, 2000, 4000]);
  });

  it('stops after the given number of attempts and throws the last error', async () => {
    const { sleep } = trackSleep();
    const fn = vi.fn(async () => {
      throw new Error('503 Service Unavailable');
    });
    await expect(withRetry(fn, 3, sleep)).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('waits exactly the Retry-After given on a 429 instead of the exponential backoff', async () => {
    const { calls, sleep } = trackSleep();
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n === 1) throw retryable('horizon /order_book 429', 5_000);
        return 'ok';
      },
      5,
      sleep,
    );
    expect(calls).toEqual([5_000]);
  });

  it('caps a very long Retry-After at MAX_RETRY_AFTER_MS', async () => {
    const { calls, sleep } = trackSleep();
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n === 1) throw retryable('horizon /order_book 429', 10 * MAX_RETRY_AFTER_MS);
        return 'ok';
      },
      5,
      sleep,
    );
    expect(calls).toEqual([MAX_RETRY_AFTER_MS]);
  });

  it('falls back to exponential backoff again on the next attempt if it has no Retry-After', async () => {
    const { calls, sleep } = trackSleep();
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n === 1) throw retryable('429', 500); // honoured: 500ms
        if (n === 2) throw retryable('fetch failed'); // no Retry-After: back to exponential backoff
        return 'ok';
      },
      5,
      sleep,
    );
    // attempt 2's backoff is 1000 * 2**(2-1) = 2000, independent of attempt 1's Retry-After.
    expect(calls).toEqual([500, 2_000]);
  });
});
