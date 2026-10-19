import { describe, expect, it } from 'vitest';
import { formatBytes, formatPercent, formatSeconds, formatSpeed, formatTime } from './format';

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
  it('formats media time', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(3.9)).toBe('0:03');
    expect(formatTime(72)).toBe('1:12');
    expect(formatTime(3600 + 5 * 60 + 7)).toBe('1:05:07');
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
    expect(formatTime(-1)).toBe('0:00');
  });
  it('formats buffer lengths', () => {
    expect(formatSeconds(4.24)).toBe('4.2 s');
    expect(formatSeconds(16.4)).toBe('16 s');
    expect(formatSeconds(-1)).toBe('0.0 s');
  });
});
