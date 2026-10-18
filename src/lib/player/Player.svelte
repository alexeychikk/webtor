<script lang="ts">
  import { PLAYBACK_ERROR_MESSAGES } from './errors';
  import { formatPercent, formatSpeed } from './format';
  import type { PlayerController, Phase } from './controller.svelte';

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

  const busy = $derived(['connecting', 'metadata', 'buffering'].includes(controller.phase));
</script>

<section class="player" data-phase={controller.phase} hidden={controller.phase === 'idle'}>
  <!-- svelte-ignore a11y_media_has_caption (subtitles are a separate feature) -->
  <video bind:this={video} data-testid="video" controls playsinline></video>

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
