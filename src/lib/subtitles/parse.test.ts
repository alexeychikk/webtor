import { describe, expect, it } from 'vitest';
import {
  isAssFormat,
  parseSubtitleFile,
  readSubtitleFile,
  sniffFormat,
  subtitleFormatOf,
} from './parse';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('subtitle formats', () => {
  it('maps extensions', () => {
    expect(subtitleFormatOf('a.SRT')).toBe('srt');
    expect(subtitleFormatOf('a.ssa')).toBe('ssa');
    expect(subtitleFormatOf('a.txt')).toBeNull();
  });
  it('sniffs content', () => {
    expect(sniffFormat('WEBVTT\n')).toBe('vtt');
    expect(sniffFormat('[Script Info]\n')).toBe('ass');
    expect(sniffFormat('1\n00:00:01,000 --> 00:00:02,000\nx')).toBe('srt');
    expect(sniffFormat('hello')).toBeNull();
  });
});

describe('parseSubtitleFile', () => {
  it('lets the content win over the extension', () => {
    const cues = parseSubtitleFile(utf8('WEBVTT\n\n00:01.000 --> 00:02.000\nHi'), 'x.srt');
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Hi' }]);
  });
  it('throws when nothing could be parsed', () => {
    expect(() => parseSubtitleFile(utf8('hello'), 'x.srt')).toThrow(/no cues/);
    expect(() => parseSubtitleFile(utf8('hello'), 'x.txt')).toThrow(/unrecognised/);
  });
});

describe('readSubtitleFile', () => {
  it('keeps the decoded ASS script for the styled renderer, with text cues as fallback', () => {
    const script =
      '\uFEFF[Script Info]\nScriptType: v4.00+\n\n[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\b1}Hi\n';
    const file = readSubtitleFile(utf8(script), 'x.ssa');
    expect(file.format).toBe('ass');
    expect(isAssFormat(file.format)).toBe(true);
    expect(file.text).toContain('{\\b1}Hi');
    expect(file.cues).toEqual([{ start: 1, end: 2.5, text: 'Hi' }]);
  });
  it('reports text formats as not ASS', () => {
    const file = readSubtitleFile(utf8('1\n00:00:01,000 --> 00:00:02,000\nx\n'), 'x.srt');
    expect(isAssFormat(file.format)).toBe(false);
  });
});
