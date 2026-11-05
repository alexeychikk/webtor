/**
 * The bounded piece store (docs/decisions/0012): which held pieces to drop, and how much memory
 * the window may take.
 */

/** Window budget without `navigator.deviceMemory` (Safari, Firefox). */
export const DEFAULT_WINDOW_BYTES = 256 * 1024 * 1024;
export const MIN_WINDOW_BYTES = 128 * 1024 * 1024;
export const MAX_WINDOW_BYTES = 768 * 1024 * 1024;

/** Store budget from the device's memory in GiB (`navigator.deviceMemory`, capped at 8 by browsers). */
export function windowBudget(deviceMemoryGiB?: number): number {
  if (!deviceMemoryGiB || !Number.isFinite(deviceMemoryGiB)) return DEFAULT_WINDOW_BYTES;
  const share = (deviceMemoryGiB * 1024 * 1024 * 1024) / 16;
  return Math.min(MAX_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, share));
}

/** Seconds of media fetched ahead are never cut below this by the budget. */
export const MIN_AHEAD_S = 20;

/**
 * Seconds to buffer ahead so the window (ahead, plus the behind part and the read slack, ~a third
 * more) fits `budget` at `bytesPerSecond` (the file's mean rate); `target` when it fits anyway.
 */
export function aheadWithin(target: number, budget: number, bytesPerSecond: number): number {
  if (!(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return target;
  const fits = (budget * 0.75) / bytesPerSecond;
  return Math.max(Math.min(target, MIN_AHEAD_S), Math.min(target, Math.floor(fits)));
}

export interface PieceRange {
  /** First piece index. */
  from: number;
  /** Last piece index (inclusive). */
  to: number;
}

export interface EvictionInput {
  /** Indices of the verified pieces in the store. */
  held: Iterable<number>;
  pieceLength: number;
  /** Torrent bytes `[start, end)` playback needs; null = keep everything. */
  keep: { start: number; end: number } | null;
  /** Pieces a reader or a download is on right now (WebTorrent's selections): never dropped. */
  pinned: readonly PieceRange[];
}

/** Held pieces outside the kept bytes and outside every pinned range, ascending. */
export function piecesToEvict({ held, pieceLength, keep, pinned }: EvictionInput): number[] {
  if (!keep) return [];
  const first = Math.floor(keep.start / pieceLength);
  const last = keep.end > keep.start ? Math.ceil(keep.end / pieceLength) - 1 : first - 1;
  const out: number[] = [];
  for (const i of held) {
    if (i >= first && i <= last) continue;
    if (pinned.some((r) => i >= r.from && i <= r.to)) continue;
    out.push(i);
  }
  return out.sort((a, b) => a - b);
}
