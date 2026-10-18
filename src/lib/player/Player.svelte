<script lang="ts">
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import { channelsLabel, codecLabel } from './codecs';
  import { PLAYBACK_ERROR_MESSAGES, type PlaybackErrorCode } from './errors';
  import { formatPercent, formatSpeed } from './format';
  import {
    detectDisplayCapabilities,
    enterFullscreen,
    enterVideoFullscreen,
    exitFullscreen,
    fullscreenElement,
    fullscreenMethod,
  } from './fullscreen';
  import type { PlayerController, Phase } from './controller.svelte';
  import type { AudioTrackInfo } from './types';
  import SubtitleMenu from '../subtitles/SubtitleMenu.svelte';
  import FileList from '../torrent/FileList.svelte';
  import { isTorrentFile } from '../torrent/files';

  let {
    controller,
    video = $bindable(),
  }: { controller: PlayerController; video?: HTMLVideoElement } = $props();

  const PHASE_TEXT: Record<Phase, string> = {
    idle: '',
    connecting: 'Looking for peers…',
    metadata: 'Got the torrent info, opening the video…',
    buffering: 'Buffering…',
    playing: 'Playing',
    paused: 'Paused',
    error: 'Stopped',
  };

  /** e.g. `Russian AC3 · rus · AC-3 5.1 → Opus`, or `… — unavailable: codec not supported`. */
  function audioOptionText(t: AudioTrackInfo): string {
    const parts = [t.label];
    if (t.language !== 'und' && t.language !== t.label) parts.push(t.language);
    parts.push([codecLabel(t.codec), channelsLabel(t.channels)].filter(Boolean).join(' '));
    let text = parts.join(' · ');
    if (t.playback === 'transcode') text += ` → ${codecLabel(t.outputCodec)}`;
    if (t.playback === 'unsupported') text += ` — unavailable: ${t.reason ?? 'not supported'}`;
    return text;
  }

  function onAudioChange(event: Event) {
    const id = Number((event.currentTarget as HTMLSelectElement).value);
    void controller.selectAudioTrack(id);
  }

  const isRelayError = (code: PlaybackErrorCode) => code.startsWith('relay-');
  const phaseText = $derived(
    controller.phase === 'connecting' && controller.viaRelay
      ? 'Relay is finding peers…'
      : PHASE_TEXT[controller.phase],
  );
  const busy = $derived(['connecting', 'metadata', 'buffering'].includes(controller.phase));
  let dragging = $state(false);

  // Our button fullscreens the container, so the ASS overlay canvas stays over the picture
  // (docs/decisions/0004). The native one would fullscreen the bare video: hidden where ours works.
  const fsMethod = fullscreenMethod(detectDisplayCapabilities());
  let screen = $state<HTMLDivElement>();
  let fullscreen = $state(false);

  $effect(() => {
    const update = () => (fullscreen = !!screen && fullscreenElement() === screen);
    const events = ['fullscreenchange', 'webkitfullscreenchange'];
    for (const type of events) document.addEventListener(type, update);
    return () => {
      for (const type of events) document.removeEventListener(type, update);
    };
  });

  function toggleFullscreen() {
    if (fsMethod === 'video') {
      if (video) enterVideoFullscreen(video);
      return;
    }
    const done = fullscreen ? exitFullscreen() : screen ? enterFullscreen(screen) : undefined;
    done?.catch((err: unknown) => console.warn('fullscreen:', err));
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function dragOver(event: DragEvent) {
    if (!carriesFiles(event) || controller.phase === 'error') return;
    event.preventDefault();
    dragging = true;
  }

  function drop(event: DragEvent) {
    dragging = false;
    const file = event.dataTransfer?.files[0];
    // A .torrent bubbles up to the page, which opens it.
    if (!file || controller.phase === 'error' || isTorrentFile(file)) return;
    event.preventDefault();
    void controller.subtitles.addFile(file);
  }
</script>

<section
  class="player"
  class:dragging
  data-phase={controller.phase}
  hidden={controller.phase === 'idle'}
  ondragover={dragOver}
  ondragleave={() => (dragging = false)}
  ondrop={drop}
  aria-label="Player (drop a subtitle or .torrent file here)"
>
  <div class="screen" class:fullscreen bind:this={screen} data-testid="screen">
    {#if fsMethod !== 'none'}
      <button
        type="button"
        class="fullscreen-button"
        data-testid="fullscreen"
        aria-pressed={fullscreen}
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen (keeps styled subtitles)'}
        onclick={toggleFullscreen}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button
      >
    {/if}
    <!-- The ASS overlay canvas is inserted right after the video (subtitles/ass-overlay.ts). -->
    <!-- svelte-ignore a11y_media_has_caption (cues are added as text tracks at runtime) -->
    <video
      bind:this={video}
      data-testid="video"
      data-audio-codec={controller.audioCodec ?? ''}
      data-audio-track={controller.audioTrackId ?? ''}
      controls
      controlslist={fsMethod === 'container' ? 'nofullscreen' : undefined}
      playsinline
    ></video>
  </div>

  {#if controller.audioTracks.length > 0}
    <p class="tracks">
      <label for="audio-track">Audio</label>
      <select
        id="audio-track"
        data-testid="audio-track"
        value={controller.audioTrackId ?? ''}
        onchange={onAudioChange}
        disabled={controller.audioTrackId === null}
      >
        {#if controller.audioTrackId === null}<option value="">Muted</option>{/if}
        {#each controller.audioTracks as t (t.id)}
          <option
            value={t.id}
            disabled={t.playback === 'unsupported'}
            title={t.playback === 'transcode'
              ? `Converted in the browser to ${codecLabel(t.outputCodec)}`
              : t.reason}>{audioOptionText(t)}</option
          >
        {/each}
      </select>
    </p>
  {/if}

  <p class="status" data-testid="status" data-phase={controller.phase} aria-live="polite">
    {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
    <span>{phaseText}</span>
    {#if controller.fileName}<span class="file" title={controller.fileName}
        >{controller.fileName}</span
      >{/if}
    {#if controller.phase !== 'error'}
      <span class="stats" data-testid="stats">
        {controller.stats.numPeers}
        {controller.stats.numPeers === 1 ? 'peer' : 'peers'} · ↓ {formatSpeed(
          controller.stats.downloadSpeed,
        )} · {formatPercent(controller.stats.progress)}
        {#if controller.stats.relayPeers !== undefined}
          <span data-testid="relay-peers">· {controller.stats.relayPeers} via relay</span>
        {/if}
      </span>
    {/if}
  </p>

  {#if controller.error}
    <p class="error" role="alert" data-testid="error" data-code={controller.error.code}>
      {controller.error.message}
      {#if isRelayError(controller.error.code)}
        <button type="button" onclick={() => relaySettings.openDialog()}>Relay settings</button>
      {/if}
    </p>
  {/if}
  {#each controller.notices as code (code)}
    <p class="notice" data-testid="notice" data-code={code}>
      {PLAYBACK_ERROR_MESSAGES[code]}
      {#if code === 'no-peers' && !controller.viaRelay}
        <button type="button" onclick={() => relaySettings.openDialog()}>Connect a relay</button>
      {/if}
    </p>
  {/each}

  <FileList
    files={controller.files}
    selected={controller.fileIndex}
    onselect={(index) => void controller.selectFile(index)}
  />

  {#if controller.phase !== 'error'}
    <SubtitleMenu subtitles={controller.subtitles} />
  {/if}
</section>

<style>
  .player {
    margin-top: 1rem;
  }
  .screen {
    position: relative;
  }
  video {
    display: block;
    width: 100%;
    max-height: 70vh;
    background: #000;
  }
  .screen.fullscreen {
    display: flex;
    align-items: center;
    background: #000;
  }
  .screen.fullscreen video {
    height: 100%;
    max-height: none;
  }
  .screen :global(.ass-overlay) {
    position: absolute;
    pointer-events: none;
  }
  .fullscreen-button {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 1;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: 0.25rem;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.2s;
  }
  .fullscreen-button:hover,
  .fullscreen-button:focus-visible {
    opacity: 1;
  }
  .tracks {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .tracks select {
    max-width: 100%;
  }
  .dragging .screen {
    outline: 3px dashed currentColor;
    outline-offset: -3px;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
  .file {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 30rem;
  }
  .stats {
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
  .error,
  .notice {
    padding: 0.5rem 0.75rem;
    border-radius: 0.25rem;
  }
  .error {
    background: color-mix(in srgb, crimson 20%, transparent);
  }
  .error button,
  .notice button {
    margin-left: 0.5rem;
  }
  .notice {
    background: color-mix(in srgb, orange 18%, transparent);
  }
  .spinner {
    width: 1em;
    height: 1em;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
