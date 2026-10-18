/** Human-readable byte rates for the status line. */
export function formatSpeed(bytesPerSecond: number): string {
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
  let v = Math.max(0, bytesPerSecond);
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
