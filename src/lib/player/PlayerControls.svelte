<script lang="ts">
  /**
   * The player's own control layer (docs/decisions/0008), on every platform: top and bottom scrims,
   * the title strip and the bar (seek bar with downloaded/buffered/played layers, play/pause, mute
   * and volume, time, the stats chip and menu triggers Player.svelte passes in, fullscreen). It overlays the picture, windowed and fullscreen, and fades out
   * with the cursor while playing (`shown`, decided by Player.svelte).
   */
  import Maximize from '@lucide/svelte/icons/maximize';
  import Minimize from '@lucide/svelte/icons/minimize';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Volume1 from '@lucide/svelte/icons/volume-1';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import VolumeX from '@lucide/svelte/icons/volume-x';
  import IconButton from '../ui/IconButton.svelte';
  import { formatTime } from './format';
  import type { MediaState } from './media-state.svelte';
  import { pointerFraction, seekVideo, timeFractions, type FractionRanges } from './seek';
  import { SEEK_STEP_S, seekTarget } from './shortcuts';
  import type { Snippet } from 'svelte';

  let {
    video,
    media,
    title,
    downloaded,
    fullscreen,
    canFullscreen,
    shown,
    touch,
    ontoggleplay,
    ontogglefullscreen,
    status,
    buttons,
  }: {
    video: HTMLVideoElement | undefined;
    media: MediaState;
    /** The playing file's name, in the top strip. */
    title: string | null;
    /** Downloaded parts of the file (fractions), from the controller. */
    downloaded: FractionRanges;
    /** The player container is fullscreen. */
    fullscreen: boolean;
    /** Some fullscreen exists (container, or the bare video on iPhone): show the icon. */
    canFullscreen: boolean;
    /** Visible; hidden (faded out) while playing once the pointer rests. */
    shown: boolean;
    /** Touch input: the centre has play/pause, so the bar doesn't. */
    touch: boolean;
    ontoggleplay: () => void;
    ontogglefullscreen: () => void;
    /** After the time: the stats chip. */
    status?: Snippet;
    /** The right cluster before fullscreen: menu triggers, share, More. */
    buttons?: Snippet;
  } = $props();

  /** The seek slider's value while it is dragged, until the seek it ends in is done. */
  let scrubbing = $state<number | null>(null);
  /** Pointer over the seek bar, as a fraction of its width (hover time chip). */
  let hover = $state<number | null>(null);

  $effect(() => {
    const v = video;
    if (!v) return;
    const done = () => (scrubbing = null);
    v.addEventListener('seeked', done);
    v.addEventListener('emptied', done);
    return () => {
      v.removeEventListener('seeked', done);
      v.removeEventListener('emptied', done);
    };
  });

  const duration = $derived(media.duration);
  const known = $derived(Number.isFinite(duration) && duration > 0);
  const shownTime = $derived(scrubbing ?? media.current);
  const fraction = (t: number) => (known ? Math.min(1, Math.max(0, t / duration)) : 0);
  const buffered = $derived(timeFractions(media.bufferedRanges, duration));
  const silent = $derived(media.muted || media.volume === 0);
  const pct = (f: number) => `${f * 100}%`;

  function seekTo(t: number) {
    scrubbing = video && seekVideo(video, t) ? t : null;
  }

  function onSeekInput(event: Event) {
    scrubbing = Number((event.currentTarget as HTMLInputElement).value);
  }

  function onSeekChange(event: Event) {
    seekTo(Number((event.currentTarget as HTMLInputElement).value));
  }

  /** ←/→ (and ↑/↓) ±5 s, Home/End: our steps, not the native slider's. */
  function onSeekKey(event: KeyboardEvent) {
    if (!known || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = scrubbing ?? media.current;
    let t: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        t = seekTarget(now, -SEEK_STEP_S, duration);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        t = seekTarget(now, SEEK_STEP_S, duration);
        break;
      case 'Home':
        t = 0;
        break;
      case 'End':
        t = duration;
        break;
      default:
        return;
    }
    event.preventDefault();
    seekTo(t);
  }

  function onSeekHover(event: PointerEvent) {
    if (event.pointerType === 'touch' || !known) return;
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    hover = pointerFraction(event.clientX, r.left, r.width);
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
</script>

<div class="scrim top" class:shown aria-hidden="true"></div>
<div class="scrim bottom" class:shown aria-hidden="true"></div>

{#if title}
  <div class="top-strip" class:shown>
    <p class="title" data-testid="title">{title}</p>
  </div>
{/if}

<div
  class="controls"
  class:shown
  class:touch
  data-testid="controls"
  data-player-controls
  data-player-bar
  role="group"
  aria-label="Player controls"
>
  <div
    class="seek-bar"
    class:disabled={!known}
    onpointermove={onSeekHover}
    onpointerleave={() => (hover = null)}
    role="presentation"
  >
    <div class="layers" aria-hidden="true">
      <div class="layer track"></div>
      <div class="layer-set" data-testid="seek-downloaded">
        {#each downloaded as [s, e], i (i)}
          <div class="layer downloaded" style:left={pct(s)} style:width={pct(e - s)}></div>
        {/each}
      </div>
      <div class="layer-set" data-testid="seek-buffered">
        {#each buffered as [s, e], i (i)}
          <div class="layer buffered" style:left={pct(s)} style:width={pct(e - s)}></div>
        {/each}
      </div>
      <div class="layer played" style:width={pct(fraction(shownTime))}></div>
      <div class="thumb" style:left={pct(fraction(shownTime))}></div>
    </div>
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
      oninput={onSeekInput}
      onchange={onSeekChange}
      onkeydown={onSeekKey}
    />
    {#if hover !== null}
      <span class="hover-time" data-testid="seek-hover" style:left={pct(hover)}
        >{formatTime(hover * duration)}</span
      >
    {/if}
  </div>

  <div class="row">
    {#if !touch}
      <IconButton
        testid="play-pause"
        icon={media.paused ? (media.ended ? RotateCcw : Play) : Pause}
        label={media.paused ? (media.ended ? 'Replay' : 'Play video') : 'Pause video'}
        shortcut="Space"
        onclick={ontoggleplay}
      />
    {/if}
    <div class="volume-group">
      <IconButton
        testid="mute"
        icon={silent ? VolumeX : media.volume < 0.5 ? Volume1 : Volume2}
        label={silent ? 'Unmute' : 'Mute'}
        shortcut="M"
        pressed={silent}
        onclick={toggleMute}
      />
      <input
        class="volume"
        type="range"
        data-testid="volume"
        aria-label="Volume"
        min="0"
        max="1"
        step="0.05"
        value={silent ? 0 : media.volume}
        style:--level={pct(silent ? 0 : media.volume)}
        oninput={onVolumeInput}
      />
    </div>
    <span class="time" data-testid="time">{formatTime(shownTime)}{' / '}{formatTime(duration)}</span
    >
    {@render status?.()}
    <div class="right">
      {@render buttons?.()}
      {#if canFullscreen}
        <IconButton
          testid="fullscreen"
          icon={fullscreen ? Minimize : Maximize}
          label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          shortcut="F"
          pressed={fullscreen}
          onclick={ontogglefullscreen}
        />
      {/if}
    </div>
  </div>
</div>

<style>
  /*
   * Everything here fades out together (opacity, then `visibility: hidden` so nothing stays drawn
   * or clickable) while playing once the pointer rests; only subtitles remain.
   */
  .scrim,
  .top-strip,
  .controls {
    position: absolute;
    left: 0;
    right: 0;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .shown {
    opacity: 1;
    visibility: visible;
  }
  @media (prefers-reduced-motion: no-preference) {
    .scrim,
    .top-strip,
    .controls {
      transition:
        opacity var(--dur-base) var(--ease-out),
        visibility 0s var(--dur-base);
    }
    .shown {
      transition: opacity var(--dur-base) var(--ease-out);
    }
  }
  .scrim {
    z-index: var(--z-scrim);
  }
  .scrim.top {
    top: 0;
    height: 96px;
    background: linear-gradient(rgb(0 0 0 / 0.6), transparent);
  }
  .scrim.bottom {
    bottom: 0;
    height: 160px;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.6));
  }
  .top-strip {
    top: 0;
    z-index: var(--z-controls);
    padding: var(--space-3) var(--space-4);
  }
  .title {
    margin: 0;
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
  }
  .controls {
    bottom: 0;
    z-index: var(--z-controls);
    padding: 0 var(--space-2) var(--space-1);
    color: var(--text);
  }
  .controls.shown {
    pointer-events: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .right {
    display: flex;
    gap: var(--space-1);
    margin-left: auto;
  }
  .row {
    min-width: 0;
  }
  .time {
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
  }

  /* Volume: the slider grows out of the mute button on hover or focus (fine pointers only). */
  .volume-group {
    display: flex;
    align-items: center;
  }
  .volume {
    --track: linear-gradient(to right, var(--text) var(--level), var(--seek-track) var(--level));
    width: 0;
    opacity: 0;
  }
  .volume-group:hover .volume,
  .volume-group:focus-within .volume {
    width: 5rem;
    margin: 0 var(--space-2);
    opacity: 1;
  }
  @media (prefers-reduced-motion: no-preference) {
    .volume {
      transition:
        width var(--dur-base) var(--ease-out),
        opacity var(--dur-base) var(--ease-out);
    }
  }
  @media (pointer: coarse) {
    .volume {
      display: none;
    }
  }
  /* Compact bar (the screen is narrower than 40rem): no volume slider. */
  @container screen (max-width: 40rem) {
    .volume {
      display: none;
    }
  }

  /* Seek bar: track, downloaded pieces, MSE buffered, played; a transparent range input on top. */
  .seek-bar {
    --bar: 4px;
    position: relative;
    height: 20px;
  }
  .controls.touch .seek-bar {
    height: 32px;
  }
  .seek-bar:hover,
  .seek-bar:focus-within {
    --bar: 6px;
  }
  .layers {
    position: absolute;
    inset: 0 var(--space-2);
    pointer-events: none;
  }
  .layer,
  .layer-set {
    position: absolute;
    top: 50%;
    left: 0;
    height: var(--bar);
    border-radius: var(--bar);
    transform: translateY(-50%);
  }
  .layer-set {
    right: 0;
  }
  .layer-set .layer {
    top: 50%;
  }
  .track {
    right: 0;
    background: var(--seek-track);
  }
  .downloaded {
    background: var(--seek-downloaded);
  }
  .buffered {
    background: var(--seek-buffered);
  }
  .played {
    background: var(--seek-played);
  }
  @media (prefers-reduced-motion: no-preference) {
    .layer,
    .layer-set {
      transition: height var(--dur-fast) var(--ease-out);
    }
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text);
    box-shadow: var(--shadow-1);
    transform: translate(-50%, -50%);
    opacity: 0;
  }
  .seek-bar:hover .thumb,
  .seek-bar:focus-within .thumb,
  .seek-bar:active .thumb,
  .controls.touch .thumb {
    opacity: 1;
  }
  .controls.touch .thumb {
    width: 16px;
    height: 16px;
  }
  .seek-bar.disabled .thumb {
    opacity: 0;
  }
  .hover-time {
    position: absolute;
    bottom: calc(100% + 4px);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: rgb(0 0 0 / 0.85);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    transform: translateX(-50%);
  }

  input[type='range'] {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }
  input[type='range']:disabled {
    cursor: default;
  }
  input[type='range']:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px rgb(0 0 0 / 0.5);
  }
  .seek {
    position: absolute;
    inset: 0 var(--space-2);
    width: calc(100% - 2 * var(--space-2));
    height: 100%;
  }
  /* The seek input only takes the pointer and focus: its layers above draw it. */
  .seek::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }
  .seek::-moz-range-track {
    height: 100%;
    background: transparent;
  }
  .seek::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 1px;
    height: 100%;
    opacity: 0;
  }
  .seek::-moz-range-thumb {
    width: 1px;
    height: 100%;
    border: 0;
    opacity: 0;
  }
  .volume {
    height: 20px;
  }
  .volume::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: var(--track);
  }
  .volume::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: var(--track);
  }
  .volume::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border: 0;
    border-radius: 50%;
    background: var(--text);
  }
  .volume::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: 0;
    border-radius: 50%;
    background: var(--text);
  }
</style>
