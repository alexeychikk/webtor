<script lang="ts">
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import { channelsLabel, codecLabel } from './codecs';
  import { PLAYBACK_ERROR_MESSAGES, type PlaybackErrorCode } from './errors';
  import { untrack } from 'svelte';
  import { provideControlsShown } from '../ui/tooltip-context';
  import type { Flash } from './centre';
  import { MediaState } from './media-state.svelte';
  import PlayerCentre from './PlayerCentre.svelte';
  import {
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
  import {
    repeats,
    seekTarget,
    shortcutFor,
    SHORTCUTS,
    volumeTarget,
    type ShortcutAction,
  } from './shortcuts';
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
  /** Screen readers hear "<phase> · <file name>" (the picture shows the spinner and title). */
  const statusText = $derived([phaseText, controller.fileName].filter((part) => part).join(' · '));
  let dragging = $state(false);

  // Our control layer everywhere (docs/decisions/0008). Its fullscreen icon fullscreens the
  // container where it can, so the ASS overlay canvas stays over the picture (0004); on iPhone the
  // bare video (`webkitEnterFullscreen`); where neither exists there is no fullscreen icon.
  const fsMethod = fullscreenMethod(detectDisplayCapabilities());
  let screen = $state<HTMLDivElement>();
  let fullscreen = $state(false);
  const media = new MediaState();

  $effect(() => {
    if (video) return media.attach(video);
  });

  $effect(() => {
    const update = () => (fullscreen = !!screen && fullscreenElement() === screen);
    const events = ['fullscreenchange', 'webkitfullscreenchange'];
    for (const type of events) document.addEventListener(type, update);
    return () => {
      for (const type of events) document.removeEventListener(type, update);
    };
  });

  /** The fullscreen button, the `f` shortcut and a double-click on the picture. */
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

  // Visibility of the control layer (docs/decisions/0008 §3.1):
  // shown = !playing || menuOpen || pointerOnControls || activity. A mouse move is activity for 1 s,
  // a key press too; the pointer leaving the player or the window ends it at once. On touch a tap
  // on the picture toggles the controls (never play/pause), and they hide 3 s after the last touch.
  // Focus doesn't keep them.
  const IDLE_MS = 1000;
  const IDLE_TOUCH_MS = 3000;
  let activity = $state(false);
  let pointerOnControls = $state(false);
  /** A menu of the control bar is open (redesign ticket 2): keeps the controls. */
  let menuOpen = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const playing = $derived(!media.paused && !media.ended);
  const controlsShown = $derived(!playing || menuOpen || pointerOnControls || activity);
  provideControlsShown(() => controlsShown);

  /** Touch input: decided by the last pointer, starting from the primary pointer's kind. */
  let touch = $state(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  /** Kind of the last pointerdown on the screen: a touch's click must not play/pause. */
  let lastPointerType = 'mouse';
  /** The last play/pause toggle, flashed in the centre. */
  let flash = $state<Flash | null>(null);

  const onControls = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('[data-player-controls]');

  function wake(ms = IDLE_MS) {
    activity = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (activity = false), ms);
  }

  function hideControls() {
    pointerOnControls = false;
    clearTimeout(idleTimer);
    activity = false;
  }

  function onScreenPointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      // A drag on the seek bar keeps the controls; a finger moving over the picture doesn't.
      if (onControls(event.target)) wake(IDLE_TOUCH_MS);
      return;
    }
    touch = false;
    pointerOnControls = onControls(event.target);
    wake(IDLE_MS);
  }

  function onScreenPointerDown(event: PointerEvent) {
    lastPointerType = event.pointerType;
    if (event.pointerType !== 'touch') {
      touch = false;
      pointerOnControls = onControls(event.target);
      wake(IDLE_MS);
      return;
    }
    touch = true;
    pointerOnControls = false;
    // A tap on a control keeps them; a tap on the picture shows or hides them.
    if (onControls(event.target)) wake(IDLE_TOUCH_MS);
    else if (controlsShown && activity && playing && !menuOpen) hideControls();
    else wake(IDLE_TOUCH_MS);
  }

  function onScreenPointerLeave(event: PointerEvent) {
    // Touch pointers "leave" after every tap.
    if (event.pointerType !== 'touch') hideControls();
  }

  $effect(() => {
    // The pointer left the window.
    const root = document.documentElement;
    root.addEventListener('mouseleave', hideControls);
    return () => root.removeEventListener('mouseleave', hideControls);
  });

  // A new notice or error wakes the controls, like a move does.
  $effect(() => {
    if (controller.notices.length || controller.error) untrack(() => wake());
  });

  $effect(() => () => clearTimeout(idleTimer));

  function togglePlay() {
    const v = video;
    if (!v) return;
    const willPlay = v.paused;
    if (willPlay) v.play().catch(() => {});
    else v.pause();
    flash = { playing: willPlay, n: (flash?.n ?? 0) + 1 };
  }

  function seekBy(by: number) {
    const v = video;
    if (v) v.currentTime = seekTarget(v.currentTime, by, v.duration);
  }

  /** A mouse click on the picture plays/pauses; a tap only toggles the controls (pointerdown). */
  function onVideoClick() {
    if (lastPointerType === 'touch') return;
    togglePlay();
  }

  /** A double-click anywhere on the picture (not on the bar) toggles fullscreen. */
  function onScreenDblClick(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest('[data-player-bar]')) return;
    toggleFullscreen();
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
    wake();
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
        togglePlay();
        break;
      case 'seek':
        v.currentTime = seekTarget(v.currentTime, action.by, v.duration);
        break;
      case 'volume':
        v.volume = volumeTarget(v.muted ? 0 : v.volume, action.by);
        v.muted = v.volume === 0;
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
    class:idle={!controlsShown}
    class:lift={controlsShown}
    bind:this={screen}
    data-testid="screen"
    data-tooltip-bounds
    onpointermove={onScreenPointerMove}
    onpointerdown={onScreenPointerDown}
    onpointerleave={onScreenPointerLeave}
    ondblclick={onScreenDblClick}
    role="presentation"
  >
    <!-- The ASS overlay canvas is inserted right after the video (subtitles/ass-overlay.ts). -->
    <!-- Click = play/pause and double-click = fullscreen; keys: shortcuts.ts. -->
    <!-- svelte-ignore a11y_media_has_caption, a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <video
      bind:this={video}
      class:placeholder={!media.hasMetadata}
      data-testid="video"
      data-audio-codec={controller.audioCodec ?? ''}
      data-audio-track={controller.audioTrackId ?? ''}
      playsinline
      onclick={onVideoClick}
    ></video>
    <PlayerControls
      {video}
      {media}
      {fullscreen}
      {touch}
      title={controller.fileName}
      downloaded={controller.downloaded}
      canFullscreen={fsMethod !== 'none'}
      shown={controlsShown}
      ontoggleplay={togglePlay}
      ontogglefullscreen={toggleFullscreen}
    />
    <PlayerCentre
      {media}
      {touch}
      {flash}
      phase={controller.phase}
      viaRelay={controller.viaRelay}
      shown={controlsShown}
      ontoggleplay={togglePlay}
      onseek={seekBy}
    />
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

  <p class="sr-only" data-testid="status" data-phase={controller.phase} aria-live="polite">
    {statusText}
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
  /*
   * The screen is the fullscreen element and holds everything about playback: video, ASS canvas,
   * scrims, centre state and controls (docs/decisions/0008). Windowed: rounded, a black 16:9 box
   * until the picture's size is known.
   */
  .screen {
    position: relative;
    container: screen / inline-size;
    overflow: hidden;
    border-radius: var(--radius-lg);
    background: #000;
    -webkit-tap-highlight-color: transparent;
  }
  video {
    display: block;
    width: 100%;
    max-height: min(75vh, calc(100vh - 96px));
    background: #000;
    object-fit: contain;
  }
  video.placeholder {
    aspect-ratio: 16 / 9;
  }
  .screen.fullscreen {
    display: flex;
    align-items: center;
    border-radius: 0;
  }
  .screen.fullscreen video {
    height: 100%;
    max-height: none;
  }
  .screen :global(.ass-overlay) {
    position: absolute;
    z-index: var(--z-ass);
    pointer-events: none;
  }
  .screen.idle {
    cursor: none;
  }
  /* Text cues above the control bar while it shows (Chromium, WebKit; Firefox can't move them). */
  .screen.lift video::-webkit-media-text-track-container {
    transform: translateY(-3.5rem);
  }
  @media (prefers-reduced-motion: no-preference) {
    video::-webkit-media-text-track-container {
      transition: transform var(--dur-base) var(--ease-out);
    }
  }
  .tracks {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .tracks select {
    min-width: 0;
    max-width: 100%;
  }
  .dragging .screen {
    outline: 2px dashed var(--accent-fg);
    outline-offset: -12px;
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
  @media (max-width: 40rem) and (orientation: portrait) {
    video {
      max-height: none;
    }
  }
  @media (max-width: 40rem) {
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
</style>
