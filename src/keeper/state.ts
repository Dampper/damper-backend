/**
 * The keeper's "how long has this asset looked suspicious" clock, persisted across runs.
 *
 * `decide()` holds a poke back for up to `maxHoldSecs` while a raw price sits far from the
 * anchor, then lets a move that has genuinely lasted that long through (ADR 0003 in
 * damper-backend) — a real crash must still reach the pool. That only works if "how long"
 * survives between passes. A keeper that is one long-running process keeps it in memory for
 * free; a keeper that restarts every pass (a scheduled job, a crash, a redeploy) has no
 * memory of its own, and without this file every pass would see any held move as having
 * "just started", so a hold could never expire. This is that memory: read at the start of a
 * pass, written at the end.
 *
 * It is small and disposable. Losing it only resets the clock on whatever is currently held,
 * which is the same thing a crash already does today — never unsafe, just occasionally more
 * cautious than it needed to be.
 */
import { readFile, writeFile } from 'node:fs/promises';

export interface KeeperState {
  updatedAt: string;
  /** asset key -> unix seconds the move was first seen suspicious. */
  suspicious: Record<string, number>;
}

export function emptyState(): KeeperState {
  return { updatedAt: new Date(0).toISOString(), suspicious: {} };
}

/** Never throws: a missing, unreadable or malformed file is just an empty one. */
export async function loadState(path: string): Promise<KeeperState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const out = emptyState();
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      if (typeof p.updatedAt === 'string') out.updatedAt = p.updatedAt;
      if (p.suspicious && typeof p.suspicious === 'object') {
        for (const [k, v] of Object.entries(p.suspicious as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v)) out.suspicious[k] = v;
        }
      }
    }
    return out;
  } catch {
    return emptyState();
  }
}

export function toMap(state: KeeperState): Map<string, number> {
  return new Map(Object.entries(state.suspicious));
}

export async function saveState(path: string, suspicious: ReadonlyMap<string, number>): Promise<void> {
  const sorted = Object.fromEntries([...suspicious.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const state: KeeperState = { updatedAt: new Date().toISOString(), suspicious: sorted };
  await writeFile(path, JSON.stringify(state, null, 2) + '\n');
}
