import { describe, expect, it } from 'vitest';
import { toRanges } from './buffer';
import { REMOTE_WARMUP_MS, remoteResumePoint, transcodeSlow } from './remote-video';

describe('transcodeSlow', () => {
  const base = {
    videoBuffered: toRanges([[0, 10.2]]),
    currentTime: 10,
    seeking: false,
    done: false,
    sinceStartMs: REMOTE_WARMUP_MS + 1,
  };
  it('flags a drained video buffer while the relay converts', () => {
    expect(transcodeSlow(base)).toBe(true);
    expect(transcodeSlow({ ...base, videoBuffered: toRanges([]) })).toBe(true);
  });
  it('ignores seeks, warm-up, the end of the video and a buffer that still has media', () => {
    expect(transcodeSlow({ ...base, seeking: true })).toBe(false);
    expect(transcodeSlow({ ...base, sinceStartMs: 1000 })).toBe(false);
    // The relay hasn't answered yet: ffmpeg still waits for the swarm, however long that takes.
    expect(transcodeSlow({ ...base, sinceStartMs: null })).toBe(false);
    expect(transcodeSlow({ ...base, done: true })).toBe(false);
    expect(transcodeSlow({ ...base, videoBuffered: toRanges([[0, 14]]) })).toBe(false);
  });
});

describe('remoteResumePoint', () => {
  it('resumes at the end of what is buffered at the playhead', () => {
    expect(remoteResumePoint(toRanges([[0, 30]]), 12)).toBe(30);
    expect(
      remoteResumePoint(
        toRanges([
          [0, 5],
          [40, 50],
        ]),
        12,
      ),
    ).toBe(12);
  });
});
