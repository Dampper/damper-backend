/**
 * The keeper's "how long has this asset looked suspicious" clock, and which alerts a person
 * has already been told about, persisted across runs.
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
 * The notifier's own `NotifyState` (ADR 0008 persisted the hold clock this way but missed
 * it) has the same problem: a scheduled `--once` run starts with an empty `Notifier`, so
 * without this it tells a person about the same still-firing alert every run instead of
 * once plus a reminder (#10).
 *
 * Both are small and disposable. Losing either only resets its clock — the hold clock on
 * whatever is currently held, the notify clock on what has already been delivered — which is
 * the same thing a crash already does today. Losing the notify half means a person is told
 * about an already-known alert one extra time; never unsafe, just a little noisier.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { ActiveAlert, NotifyState, Tracked } from './notify.js';

export interface KeeperState {
  updatedAt: string;
  /** asset key -> unix seconds the move was first seen suspicious. */
  suspicious: Record<string, number>;
  /** alert key -> delivery state, mirroring `NotifyState`. */
  notify: Record<string, { alert: ActiveAlert; firstSeen: number; lastSent: number | undefined }>;
}

const SEVERITIES = new Set(['critical', 'warn', 'info']);

export function emptyState(): KeeperState {
  return { updatedAt: new Date(0).toISOString(), suspicious: {}, notify: {} };
}

function parseActiveAlert(v: unknown): ActiveAlert | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Record<string, unknown>;
  if (
    typeof a.key === 'string' &&
    typeof a.asset === 'string' &&
    typeof a.code === 'string' &&
    typeof a.severity === 'string' &&
    SEVERITIES.has(a.severity) &&
    typeof a.message === 'string'
  ) {
    return { key: a.key, asset: a.asset, code: a.code, severity: a.severity as ActiveAlert['severity'], message: a.message };
  }
  return undefined;
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
      if (p.notify && typeof p.notify === 'object') {
        for (const [k, v] of Object.entries(p.notify as Record<string, unknown>)) {
          if (!v || typeof v !== 'object') continue;
          const entry = v as Record<string, unknown>;
          const alert = parseActiveAlert(entry.alert);
          const firstSeen = entry.firstSeen;
          const lastSent = entry.lastSent;
          if (
            alert &&
            typeof firstSeen === 'number' &&
            Number.isFinite(firstSeen) &&
            (lastSent === undefined || (typeof lastSent === 'number' && Number.isFinite(lastSent)))
          ) {
            out.notify[k] = { alert, firstSeen, lastSent };
          }
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

export function toNotifyState(state: KeeperState): NotifyState {
  return new Map(Object.entries(state.notify).map(([k, v]) => [k, { alert: v.alert, firstSeen: v.firstSeen, lastSent: v.lastSent }]));
}

export async function saveState(
  path: string,
  suspicious: ReadonlyMap<string, number>,
  notify: ReadonlyMap<string, Tracked> = new Map(),
): Promise<void> {
  const sorted = Object.fromEntries([...suspicious.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const notifySorted = Object.fromEntries([...notify.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const state: KeeperState = { updatedAt: new Date().toISOString(), suspicious: sorted, notify: notifySorted };
  await writeFile(path, JSON.stringify(state, null, 2) + '\n');
}
