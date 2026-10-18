import { describe, expect, it } from 'vitest';
import { parseVtt } from './vtt';

describe('parseVtt', () => {
  it('parses cues with and without identifiers and hours', () => {
    const text = [
      'WEBVTT - a title',
      'cue-1\n00:01.000 --> 00:02.500\nHello',
      '01:00:00.000 --> 01:00:01.000\nTwo\nlines',
    ].join('\n\n');
    expect(parseVtt(text)).toEqual([
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3600, end: 3601, text: 'Two\nlines' },
    ]);
  });

  it('skips NOTE, STYLE and REGION blocks', () => {
    const text = [
      'WEBVTT',
      'NOTE a comment\n00:00.000 --> 00:01.000 is not a cue',
      'STYLE\n::cue { color: red }',
      'REGION\nid:fred',
      '00:00:01.000 --> 00:00:02.000\nKept',
    ].join('\n\n');
    expect(parseVtt(text).map((c) => c.text)).toEqual(['Kept']);
  });

  it('keeps known cue settings', () => {
    const text = 'WEBVTT\r\n\r\n00:01.000 --> 00:02.000 align:start line:10% foo:bar\r\nHi\r\n';
    expect(parseVtt(text)[0]?.settings).toEqual({ align: 'start', line: '10%' });
  });

  it('keeps entities and escapes a stray <, dropping timestamp tags', () => {
    const text = 'WEBVTT\n\n00:01.000 --> 00:02.000\na &lt; b <00:01.500>and c < d';
    expect(parseVtt(text)[0]?.text).toBe('a &lt; b and c &lt; d');
  });

  it('treats a whitespace-only line as a block separator', () => {
    const text = 'WEBVTT\n\n00:01.000 --> 00:02.000\nOne\n \t\n00:03.000 --> 00:04.000\nTwo\n';
    expect(parseVtt(text)).toEqual([
      { start: 1, end: 2, text: 'One' },
      { start: 3, end: 4, text: 'Two' },
    ]);
  });

  it('strips voice and class tags but keeps <i>', () => {
    const text = 'WEBVTT\n\n00:01.000 --> 00:02.000\n<v Bob>Hi <c.loud>there</c> <i>you</i>';
    expect(parseVtt(text)[0]?.text).toBe('Hi there <i>you</i>');
  });

  it('accepts a BOM and rejects a file without the WEBVTT header', () => {
    expect(parseVtt('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nA')).toHaveLength(1);
    expect(() => parseVtt('00:01.000 --> 00:02.000\nA')).toThrow();
    expect(() => parseVtt('WEBVTTX\n\n00:01.000 --> 00:02.000\nA')).toThrow();
  });
});
