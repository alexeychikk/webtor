/**
 * The `<video>` element's state as runes, for the control layer and the centre state. One instance
 * per player; `attach(video)` follows the element's media events until the returned cleanup runs.
 */
const MEDIA_EVENTS = [
  'play',
  'pause',
  'playing',
  'waiting',
  'timeupdate',
  'durationchange',
  'loadedmetadata',
  'volumechange',
  'progress',
  'seeking',
  'seeked',
  'emptied',
  'ended',
] as const;

export class MediaState {
  paused = $state(true);
  ended = $state(false);
  current = $state(0);
  duration = $state(NaN);
  muted = $state(false);
  volume = $state(1);
  /** The picture's size is known (`loadedmetadata`): until then the screen keeps a 16:9 box. */
  hasMetadata = $state(false);
  /** `video.buffered`, copied (TimeRanges is live) on every media event. */
  buffered = $state<readonly (readonly [number, number])[]>([]);

  attach(video: HTMLVideoElement): () => void {
    const ac = new AbortController();
    const sync = () => {
      this.paused = video.paused;
      this.ended = video.ended;
      this.current = video.currentTime;
      this.duration = video.duration;
      this.muted = video.muted;
      this.volume = video.volume;
      this.hasMetadata = video.readyState >= 1 && video.videoWidth > 0;
      const b = video.buffered;
      const ranges: [number, number][] = [];
      for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)]);
      this.buffered = ranges;
    };
    for (const type of MEDIA_EVENTS) video.addEventListener(type, sync, { signal: ac.signal });
    sync();
    return () => ac.abort();
  }

  /** Same shape as `TimeRanges`, for the pure helpers in buffer.ts / seek.ts. */
  get bufferedRanges() {
    const r = this.buffered;
    return { length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] };
  }
}
