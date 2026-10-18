<script lang="ts">
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import { PLAYBACK_ERROR_MESSAGES, type PlaybackErrorCode } from './errors';
  import { formatPercent, formatSpeed } from './format';
  import type { PlayerController, Phase } from './controller.svelte';
  import SubtitleMenu from '../subtitles/SubtitleMenu.svelte';

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

  const isRelayError = (code: PlaybackErrorCode) => code.startsWith('relay-');
  const phaseText = $derived(
    controller.phase === 'connecting' && controller.viaRelay
      ? 'Relay is finding peers…'
      : PHASE_TEXT[controller.phase],
  );
  const busy = $derived(['connecting', 'metadata', 'buffering'].includes(controller.phase));
  let dragging = $state(false);

  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function dragOver(event: DragEvent) {
    if (!carriesFiles(event) || controller.phase === 'error') return;
    event.preventDefault();
    dragging = true;
  }

  function drop(event: DragEvent) {
    dragging = false;
    const file = event.dataTransfer?.files[0];
    if (!file || controller.phase === 'error') return;
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
  aria-label="Player (drop a subtitle file here)"
>
  <!-- svelte-ignore a11y_media_has_caption (cues are added as text tracks at runtime) -->
  <video bind:this={video} data-testid="video" controls playsinline></video>

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

  {#if controller.phase !== 'error'}
    <SubtitleMenu subtitles={controller.subtitles} />
  {/if}
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
  .dragging video {
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
