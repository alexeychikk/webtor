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
