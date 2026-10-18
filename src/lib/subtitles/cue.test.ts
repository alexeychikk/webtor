import { describe, expect, it } from 'vitest';
import { formatSubtitleDelay, shiftCues, type SubtitleCue } from './cue';

const cues: SubtitleCue[] = [
  { start: 0.2, end: 0.4, text: 'gone' },
  { start: 0.5, end: 2, text: 'clipped' },
  { start: 3, end: 4, text: 'moved', settings: { align: 'left' } },
];

describe('shiftCues', () => {
  it('moves cues later', () => {
    expect(shiftCues(cues, 1.5).map((c) => [c.start, c.end])).toEqual([
      [1.7, 1.9],
      [2, 3.5],
      [4.5, 5.5],
    ]);
  });
  it('moves cues earlier, dropping what ends before 0 and clamping starts', () => {
    const shifted = shiftCues(cues, -1);
    expect(shifted.map((c) => [c.text, c.start, c.end])).toEqual([
      ['clipped', 0, 1],
      ['moved', 2, 3],
    ]);
    expect(shifted[1]!.settings).toEqual({ align: 'left' });
  });
  it('leaves the input untouched', () => {
    shiftCues(cues, 2);
    expect(cues[0]!.start).toBe(0.2);
    expect(shiftCues(cues, 0)).toEqual(cues);
  });
});

describe('formatSubtitleDelay', () => {
  it('shows the sign and one decimal', () => {
    expect(formatSubtitleDelay(0)).toBe('0.0 s');
    expect(formatSubtitleDelay(0.5)).toBe('+0.5 s');
    expect(formatSubtitleDelay(-1.5)).toBe('−1.5 s');
  });
});
