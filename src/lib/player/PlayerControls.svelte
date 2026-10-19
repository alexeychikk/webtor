<script lang="ts">
  /**
   * The player's own control bar, used where the player container can go fullscreen
   * (`controlsFor` in fullscreen.ts, docs/decisions/0004): play/pause, seek, time, volume and the
   * one fullscreen button, which fullscreens the container so the ASS overlay stays visible.
   */
  import { bufferedAhead } from './buffer';
  import { formatTime } from './format';

  let {
    video,
    fullscreen,
    shown,
    ontogglefullscreen,
  }: {
    video: HTMLVideoElement | undefined;
    /** The player container is fullscreen. */
    fullscreen: boolean;
    /** Visible; only applies in fullscreen, where the bar overlays the picture. */
    shown: boolean;
    ontogglefullscreen: () => void;
  } = $props();

  let paused = $state(true);
  let current = $state(0);
  let duration = $state(NaN);
  let bufferedEnd = $state(0);
  let muted = $state(false);
  let volume = $state(1);
  /** The seek slider's value while it is dragged, until the seek it ends in is done. */
  let scrubbing = $state<number | null>(null);

  const MEDIA_EVENTS = [
    'play',
    'pause',
    'playing',
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'volumechange',
    'progress',
    'seeked',
    'emptied',
    'ended',
  ];

  $effect(() => {
    const v = video;
    if (!v) return;
    const ac = new AbortController();
    const sync = (event?: Event) => {
      paused = v.paused;
      current = v.currentTime;
      duration = v.duration;
      muted = v.muted;
      volume = v.volume;
      bufferedEnd = current + bufferedAhead(v.buffered, current);
      if (event?.type === 'seeked' || event?.type === 'emptied') scrubbing = null;
    };
    for (const type of MEDIA_EVENTS) v.addEventListener(type, sync, { signal: ac.signal });
    sync();
    return () => ac.abort();
  });

  const known = $derived(Number.isFinite(duration) && duration > 0);
  const shownTime = $derived(scrubbing ?? current);
  const percent = (t: number) => (known ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);

  function togglePlay() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function onSeekInput(event: Event) {
    scrubbing = Number((event.currentTarget as HTMLInputElement).value);
  }

  function onSeekChange(event: Event) {
    const t = Number((event.currentTarget as HTMLInputElement).value);
    scrubbing = t;
    if (video) video.currentTime = t;
  }

  function toggleMute() {
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
  }

  function onVolumeInput(event: Event) {
    if (!video) return;
    video.volume = Number((event.currentTarget as HTMLInputElement).value);
    video.muted = video.volume === 0;
  }

  const silent = $derived(muted || volume === 0);
</script>

<div
  class="controls"
  class:overlay={fullscreen}
  class:shown={!fullscreen || shown}
  data-testid="controls"
  data-player-controls
  role="group"
  aria-label="Player controls"
>
  <input
    class="seek"
    type="range"
    data-testid="seek"
    aria-label="Seek"
    aria-valuetext={`${formatTime(shownTime)} of ${formatTime(duration)}`}
    min="0"
    max={known ? duration : 0}
    step="any"
    value={known ? shownTime : 0}
    disabled={!known}
    style:--played="{percent(shownTime)}%"
    style:--buffered="{percent(Math.max(bufferedEnd, shownTime))}%"
    oninput={onSeekInput}
    onchange={onSeekChange}
  />
  <div class="row">
    <button
      type="button"
      class="icon"
      data-testid="play-pause"
      aria-label={paused ? 'Play video' : 'Pause video'}
      title={paused ? 'Play (Space)' : 'Pause (Space)'}
      onclick={togglePlay}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {#if paused}
          <path d="M8 5.5v13l10.5-6.5z" />
        {:else}
          <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
        {/if}
      </svg>
    </button>
    <button
      type="button"
      class="icon"
      data-testid="mute"
      aria-label={silent ? 'Unmute' : 'Mute'}
      aria-pressed={silent}
      title={silent ? 'Unmute (M)' : 'Mute (M)'}
      onclick={toggleMute}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
        {#if silent}
          <path d="M15 9.5l5 5M20 9.5l-5 5" class="stroke" />
        {:else}
          <path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" class="stroke" />
        {/if}
      </svg>
    </button>
    <input
      class="volume"
      type="range"
      data-testid="volume"
      aria-label="Volume"
      min="0"
      max="1"
      step="0.05"
      value={silent ? 0 : volume}
      style:--played="{(silent ? 0 : volume) * 100}%"
      style:--buffered="{(silent ? 0 : volume) * 100}%"
      oninput={onVolumeInput}
    />
    <span class="time" data-testid="time">{formatTime(shownTime)}{' / '}{formatTime(duration)}</span
    >
    <button
      type="button"
      class="icon fullscreen"
      data-testid="fullscreen"
      aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      aria-pressed={fullscreen}
      title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
      onclick={ontogglefullscreen}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {#if fullscreen}
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" class="stroke" />
        {:else}
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" class="stroke" />
        {/if}
      </svg>
    </button>
  </div>
</div>

<style>
  /* Below the picture (never over subtitles); over it in fullscreen, fading out while playing. */
  .controls {
    position: relative;
    z-index: 2;
    padding: 0.25rem 0.5rem;
    background: #000;
    color: #fff;
    opacity: 0;
    transition: opacity 0.25s;
  }
  .controls.overlay {
    position: absolute;
    inset: auto 0 0 0;
    padding-top: 1.5rem;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.7));
  }
  .controls.shown,
  .controls:has(:focus-visible) {
    opacity: 1;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    border: 0;
    border-radius: 0.25rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .icon:hover {
    background: rgb(255 255 255 / 0.15);
  }
  .icon:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
  svg {
    width: 1.5rem;
    height: 1.5rem;
    fill: currentColor;
  }
  .stroke {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .fullscreen {
    margin-left: auto;
  }
  .time {
    padding: 0 0.5rem;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Sliders: a thin track showing played (white) and buffered (grey) parts, and a round thumb. */
  input[type='range'] {
    --track: linear-gradient(
      to right,
      #fff var(--played),
      rgb(255 255 255 / 0.5) var(--played) var(--buffered),
      rgb(255 255 255 / 0.2) var(--buffered)
    );
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    height: 1rem;
    background: transparent;
    cursor: pointer;
  }
  input[type='range']:disabled {
    cursor: default;
  }
  input[type='range']:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .seek {
    display: block;
    width: 100%;
  }
  .volume {
    width: 5rem;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 0.25rem;
    border-radius: 0.125rem;
    background: var(--track);
  }
  input[type='range']::-moz-range-track {
    height: 0.25rem;
    border-radius: 0.125rem;
    background: var(--track);
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 0.8rem;
    height: 0.8rem;
    margin-top: -0.275rem;
    border: 0;
    border-radius: 50%;
    background: #fff;
  }
  input[type='range']::-moz-range-thumb {
    width: 0.8rem;
    height: 0.8rem;
    border: 0;
    border-radius: 50%;
    background: #fff;
  }
  @media (max-width: 40rem) {
    .volume {
      display: none;
    }
  }
</style>
