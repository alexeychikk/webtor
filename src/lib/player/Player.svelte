<script lang="ts">
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import { channelsLabel, codecLabel } from './codecs';
  import { PLAYBACK_ERROR_MESSAGES, type PlaybackErrorCode } from './errors';
  import {
    controlsFor,
    detectDisplayCapabilities,
    enterFullscreen,
    enterVideoFullscreen,
    exitFullscreen,
    fullscreenElement,
    fullscreenMethod,
  } from './fullscreen';
  import type { PlayerController, Phase } from './controller.svelte';
  import PlayerControls from './PlayerControls.svelte';
  import ShareButton from './ShareButton.svelte';
  import { repeats, seekTarget, shortcutFor, SHORTCUTS, type ShortcutAction } from './shortcuts';
  import StatsPanel from './StatsPanel.svelte';
  import type { AudioTrackInfo } from './types';
  import SubtitleMenu from '../subtitles/SubtitleMenu.svelte';
  import FileList from '../torrent/FileList.svelte';
  import { isTorrentFile } from '../torrent/files';
  import { helpDialog } from '../help/help-dialog.svelte';

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

  // Where the container can go fullscreen, our control bar replaces the native one: its fullscreen
  // button fullscreens the container, so the ASS overlay canvas stays over the picture. A native
  // control would fullscreen the bare video (docs/decisions/0004). iOS keeps the native controls.
  const fsMethod = fullscreenMethod(detectDisplayCapabilities());
  const ownControls = controlsFor(fsMethod) === 'own';
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

  /** The fullscreen button, the `f` shortcut and a double-click on the video. */
  function toggleFullscreen() {
    if (fsMethod === 'none') return;
    if (fsMethod === 'video') {
      if (video) enterVideoFullscreen(video);
      return;
    }
    // Leaves any fullscreen (also the bare video's, e.g. after a double-click on it).
    const done = fullscreenElement()
      ? exitFullscreen()
      : screen
        ? enterFullscreen(screen)
        : undefined;
    done?.catch((err: unknown) => console.warn('fullscreen:', err));
  }

  // While the video plays, our control bar and the cursor hide 1 s after the pointer stops (3 s
  // after a touch), or at once when the pointer leaves the player or the window. A pointer move,
  // touch or key press shows them again; they stay while paused or while the pointer is on the bar.
  const IDLE_MS = 1000;
  const IDLE_TOUCH_MS = 3000;
  let awake = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The mouse is on the control bar. */
  let overControls = false;
  const controlsShown = $derived(awake || controller.phase !== 'playing');
  /** A touch on the video while the bar is hidden only reveals it (no play/pause). */
  let tapReveals = false;

  const onControls = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('[data-player-controls]');

  function wake(ms = IDLE_MS) {
    awake = true;
    clearTimeout(idleTimer);
    if (!overControls) idleTimer = setTimeout(() => (awake = false), ms);
  }

  function hideControls() {
    overControls = false;
    clearTimeout(idleTimer);
    awake = false;
  }

  function onScreenPointer(event: PointerEvent) {
    const mouse = event.pointerType === 'mouse';
    overControls = mouse && onControls(event.target);
    if (event.type === 'pointerdown') tapReveals = !mouse && !controlsShown;
    wake(mouse ? IDLE_MS : IDLE_TOUCH_MS);
  }

  function onScreenPointerLeave(event: PointerEvent) {
    // Touch pointers "leave" after every tap.
    if (event.pointerType === 'mouse') hideControls();
  }

  $effect(() => {
    if (!ownControls) return;
    // The pointer left the window.
    const root = document.documentElement;
    root.addEventListener('mouseleave', hideControls);
    return () => root.removeEventListener('mouseleave', hideControls);
  });

  $effect(() => () => clearTimeout(idleTimer));

  function onVideoClick() {
    if (tapReveals) return;
    const v = video;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function dragOver(event: DragEvent) {
    if (!carriesFiles(event) || controller.phase === 'error') return;
    event.preventDefault();
    dragging = true;
  }

  /** Notices the "Why won't my torrent play?" help explains. */
  const PEER_NOTICES: readonly PlaybackErrorCode[] = ['no-peers', 'stalled'];

  /** A Space keydown we handled: its keyup must not also activate a focused (native) control. */
  let spaceHandled = false;

  function onKeyDown(event: KeyboardEvent) {
    const v = video;
    if (!v || event.defaultPrevented || controller.phase === 'idle' || controller.phase === 'error')
      return;
    if (ownControls) wake();
    // A key typed in a dialog (relay settings, help) is not meant for the player.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('dialog')) return;
    const action = shortcutFor({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      targetTag: target?.tagName,
      targetEditable: target?.isContentEditable,
      inPlayerControls: onControls(target),
    });
    if (!action) return;
    // Handled here only: the window's capture phase runs before the focused element's own
    // listeners (a native controls' play button, our bar's buttons), which would toggle again.
    event.preventDefault();
    event.stopPropagation();
    if (action.type === 'toggle-play') spaceHandled = true;
    if (event.repeat && !repeats(action)) return;
    run(action, v);
  }

  function onKeyUp(event: KeyboardEvent) {
    if (!spaceHandled || (event.key !== ' ' && event.key !== 'Spacebar')) return;
    spaceHandled = false;
    // A focused button (ours, or the native controls' play button) acts on Space's keyup.
    event.preventDefault();
    event.stopPropagation();
  }

  function run(action: ShortcutAction, v: HTMLVideoElement) {
    switch (action.type) {
      case 'toggle-play':
        if (v.paused) v.play().catch(() => {});
        else v.pause();
        break;
      case 'seek':
        v.currentTime = seekTarget(v.currentTime, action.by, v.duration);
        break;
      case 'mute':
        v.muted = !v.muted;
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'cycle-subtitles':
        void controller.subtitles.cycle();
        break;
    }
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

<svelte:window onkeydowncapture={onKeyDown} onkeyupcapture={onKeyUp} />

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
  <div
    class="screen"
    class:fullscreen
    class:idle={ownControls && !controlsShown}
    class:lift={ownControls && fullscreen && controlsShown}
    bind:this={screen}
    data-testid="screen"
    onpointermove={ownControls ? onScreenPointer : undefined}
    onpointerdown={ownControls ? onScreenPointer : undefined}
    onpointerleave={ownControls ? onScreenPointerLeave : undefined}
    role="presentation"
  >
    <!-- The ASS overlay canvas is inserted right after the video (subtitles/ass-overlay.ts). -->
    <!-- Click = play/pause and double-click = fullscreen, as with native controls; keys: shortcuts.ts. -->
    <!-- svelte-ignore a11y_media_has_caption, a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <video
      bind:this={video}
      data-testid="video"
      data-audio-codec={controller.audioCodec ?? ''}
      data-audio-track={controller.audioTrackId ?? ''}
      controls={!ownControls}
      playsinline
      onclick={ownControls ? onVideoClick : undefined}
      ondblclick={ownControls ? toggleFullscreen : undefined}
    ></video>
    {#if ownControls}
      <PlayerControls
        {video}
        {fullscreen}
        shown={controlsShown}
        ontogglefullscreen={toggleFullscreen}
      />
    {/if}
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
  </p>

  {#if controller.phase !== 'error'}
    <StatsPanel stats={controller.stats} />
  {/if}

  <div class="actions">
    {#if controller.magnet}
      <ShareButton magnet={controller.magnet} fileIndex={controller.fileIndex} />
    {/if}
    <details class="shortcuts" data-testid="shortcuts-help">
      <summary>Keyboard shortcuts</summary>
      <dl>
        {#each SHORTCUTS as s (s.keys)}
          <div>
            <dt><kbd>{s.keys}</kbd></dt>
            <dd>{s.action}</dd>
          </div>
        {/each}
      </dl>
    </details>
  </div>

  {#if controller.error}
    <p class="error" role="alert" data-testid="error" data-code={controller.error.code}>
      {controller.error.message}
      {#if isRelayError(controller.error.code)}
        <button type="button" onclick={() => relaySettings.openDialog()}>Relay settings</button>
      {:else if controller.error.code === 'video-needs-relay'}
        <button type="button" onclick={() => relaySettings.openDialog()}>Set up a relay</button>
      {/if}
    </p>
  {/if}
  {#each controller.notices as code (code)}
    <p class="notice" data-testid="notice" data-code={code}>
      {PLAYBACK_ERROR_MESSAGES[code]}
      {#if PEER_NOTICES.includes(code)}
        <button type="button" data-testid="why-link" onclick={() => (helpDialog.open = true)}
          >Why won’t it play?</button
        >
      {/if}
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
  .screen.idle {
    cursor: none;
  }
  /* Text cues above the control bar while it overlays the picture (Chromium, WebKit). */
  .screen.lift video::-webkit-media-text-track-container {
    transform: translateY(-3.5rem);
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
    max-width: min(30rem, 100%);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: flex-start;
    margin: 0.5rem 0;
  }
  .shortcuts {
    position: relative;
  }
  .shortcuts summary {
    cursor: pointer;
    opacity: 0.85;
  }
  .shortcuts dl {
    position: absolute;
    z-index: 1;
    margin: 0.25rem 0 0;
    padding: 0.5rem 0.75rem;
    min-width: 16rem;
    border-radius: 0.25rem;
    background: Canvas;
    color: CanvasText;
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
  }
  .shortcuts dl div {
    display: flex;
    gap: 0.75rem;
  }
  .shortcuts dt {
    min-width: 4.5rem;
  }
  .shortcuts dd {
    margin: 0;
  }
  kbd {
    font-family: inherit;
    padding: 0 0.3em;
    border: 1px solid currentColor;
    border-radius: 0.2em;
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
  @media (max-width: 40rem) {
    video {
      max-height: 50vh;
    }
    .error button,
    .notice button {
      margin: 0.5rem 0.5rem 0 0;
    }
    .shortcuts dl {
      position: static;
      min-width: 0;
    }
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
