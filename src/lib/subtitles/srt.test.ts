import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSrt } from './srt';

describe('parseSrt', () => {
  it('parses the e2e sidecar fixture', () => {
    const text = readFileSync(
      new URL('../../../e2e/fixtures/sidecar.en.srt', import.meta.url),
      'utf8',
    );
    expect(parseSrt(text)).toEqual([
      { start: 1, end: 3, text: 'Hello from English SRT' },
      { start: 5, end: 8, text: 'Second english cue' },
    ]);
  });

  it('handles CRLF, a BOM, multi-line text, hours and dot milliseconds', () => {
    const text =
      '\uFEFF1\r\n01:02:03.5 --> 01:02:04,250 X1:10 X2:20\r\nline one\r\nline two\r\n\r\n';
    expect(parseSrt(text)).toEqual([{ start: 3723.5, end: 3724.25, text: 'line one\nline two' }]);
  });

  it('tolerates missing indices and missing blank lines', () => {
    const text = '00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB';
    expect(parseSrt(text).map((c) => c.text)).toEqual(['A', 'B']);
  });

  it('keeps <i>/<b>/<u>, drops <font> and ASS overrides, keeps entities', () => {
    const text =
      '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="#ff0">Hi</font> <I>there</I> &amp; you\n';
    expect(parseSrt(text)[0]?.text).toBe('Hi <i>there</i> &amp; you');
  });

  it('escapes stray <, > and & so VTTCue renders them as text', () => {
    const text = [
      '1\n00:00:01,000 --> 00:00:02,000\nI <3 you & me > them',
      '2\n00:00:03,000 --> 00:00:04,000\n&lt;whispers&gt; <i>quiet</i> &#60;',
    ].join('\n\n');
    expect(parseSrt(text).map((c) => c.text)).toEqual([
      'I &lt;3 you &amp; me &gt; them',
      '&lt;whispers&gt; <i>quiet</i> &#60;',
    ]);
  });

  it('drops empty and zero-length cues and sorts by start', () => {
    const text = [
      '1\n00:00:05,000 --> 00:00:06,000\nlater',
      '2\n00:00:01,000 --> 00:00:01,000\nzero',
      '3\n00:00:02,000 --> 00:00:03,000\n',
      '4\n00:00:01,000 --> 00:00:02,000\nfirst',
    ].join('\n\n');
    expect(parseSrt(text).map((c) => c.text)).toEqual(['first', 'later']);
  });

  it('returns no cues for something that is not SRT', () => {
    expect(parseSrt('hello\nworld')).toEqual([]);
  });
});
