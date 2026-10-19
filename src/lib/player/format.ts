/** Human-readable byte rates for the status line. */
export function formatSpeed(bytesPerSecond: number): string {
  return formatUnits(bytesPerSecond, ['B/s', 'kB/s', 'MB/s', 'GB/s']);
}

/** Human-readable file sizes (decimal units, like the speeds). */
export function formatBytes(bytes: number): string {
  return formatUnits(bytes, ['B', 'kB', 'MB', 'GB', 'TB']);
}

function formatUnits(value: number, units: readonly string[]): string {
  let v = Math.max(0, value);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** Media time for the control bar: `m:ss`, or `h:mm:ss` from an hour on; unknown → `0:00`. */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const ss = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
