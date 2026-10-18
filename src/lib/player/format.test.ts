import { describe, expect, it } from 'vitest';
import { formatBytes, formatPercent, formatSpeed } from './format';

describe('format', () => {
  it('formats speeds', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(999)).toBe('999 B/s');
    expect(formatSpeed(1500)).toBe('1.5 kB/s');
    expect(formatSpeed(2_500_000)).toBe('2.5 MB/s');
    expect(formatSpeed(25_000_000)).toBe('25 MB/s');
  });
  it('formats sizes', () => {
    expect(formatBytes(107)).toBe('107 B');
    expect(formatBytes(708_197)).toBe('708 kB');
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB');
  });
  it('formats progress', () => {
    expect(formatPercent(0.999)).toBe('99%');
    expect(formatPercent(1)).toBe('100%');
  });
});
