<script lang="ts">
  import { channelsLabel, codecLabel } from './codecs';
  import { PLAYBACK_ERROR_MESSAGES } from './errors';
  import { formatPercent, formatSpeed } from './format';
  import type { PlayerController, Phase } from './controller.svelte';
  import type { AudioTrackInfo } from './types';

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

  const busy = $derived(['connecting', 'metadata', 'buffering'].includes(controller.phase));
</script>

<section class="player" data-phase={controller.phase} hidden={controller.phase === 'idle'}>
  <!-- svelte-ignore a11y_media_has_caption (subtitles are a separate feature) -->
  <video
    bind:this={video}
    data-testid="video"
    data-audio-codec={controller.audioCodec ?? ''}
    data-audio-track={controller.audioTrackId ?? ''}
    controls
    playsinline
  ></video>

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
    <span>{PHASE_TEXT[controller.phase]}</span>
    {#if controller.fileName}<span class="file" title={controller.fileName}
        >{controller.fileName}</span
      >{/if}
    {#if controller.phase !== 'error'}
      <span class="stats" data-testid="stats">
        {controller.stats.numPeers}
        {controller.stats.numPeers === 1 ? 'peer' : 'peers'} · ↓ {formatSpeed(
          controller.stats.downloadSpeed,
        )} · {formatPercent(controller.stats.progress)}
      </span>
    {/if}
  </p>

  {#if controller.error}
    <p class="error" role="alert" data-testid="error" data-code={controller.error.code}>
      {controller.error.message}
    </p>
  {/if}
  {#each controller.notices as code (code)}
    <p class="notice" data-testid="notice" data-code={code}>{PLAYBACK_ERROR_MESSAGES[code]}</p>
  {/each}
</section>

<style>
  .player {
    margin-top: 1rem;
  }
  video {
    width: 100%;
    max-height: 70vh;
    background: #000;
  }
  .tracks {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .tracks select {
    max-width: 100%;
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
