<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import Captions from '@lucide/svelte/icons/captions';
  import CaptionsOff from '@lucide/svelte/icons/captions-off';
  import Check from '@lucide/svelte/icons/check';
  import ChevronsLeft from '@lucide/svelte/icons/chevrons-left';
  import ChevronsRight from '@lucide/svelte/icons/chevrons-right';
  import Copy from '@lucide/svelte/icons/copy';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import Link from '@lucide/svelte/icons/link';
  import ListVideo from '@lucide/svelte/icons/list-video';
  import Users from '@lucide/svelte/icons/users';
  import type { PlaybackErrorCode } from './errors';
  import PlayerStates from './PlayerStates.svelte';
  import { playerStates } from './states';
  import AudioMenu from './AudioMenu.svelte';
  import { audioTrackTitle } from './audio-options';
  import { formatSpeed } from './format';
  import MoreMenu from './MoreMenu.svelte';
  import { ShareLink } from './share-link.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Menu from '../ui/Menu.svelte';
  import { menuPresentation } from '../ui/menu';
  import { SUBTITLE_EXTENSIONS } from '../subtitles/parse';
  import { subtitleTrackText } from '../subtitles/tracks';
  import { tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { hideDelay, remainingDelay } from './auto-hide';
  import {
    DOUBLE_TAP_MS,
    formatStreak,
    NO_TAPS,
    onTap,
    SEEK_COALESCE_MS,
    SEEK_STREAK_MS,
    tapZone,
    type SeekSide,
  } from './touch-seek';
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
  import { repeats, seekTarget, shortcutFor, volumeTarget, type ShortcutAction } from './shortcuts';
  import { seekVideo } from './seek';
  import StatsPanel from './StatsPanel.svelte';
  import SubtitleMenu from '../subtitles/SubtitleMenu.svelte';
  import FileList from '../torrent/FileList.svelte';
  import { isTorrentFile } from '../torrent/files';
  import { helpDialog } from '../help/help-dialog.svelte';
  import { historyDialog } from '../history/history-dialog.svelte';

  let {
    controller,
    video = $bindable(),
    onretry,
  }: {
    controller: PlayerController;
    video?: HTMLVideoElement;
    /** Retry after a fatal error: the page loads the same torrent and file again. */
    onretry: () => void;
  } = $props();

  const PHASE_TEXT: Record<Phase, string> = {
    idle: '',
    connecting: 'Looking for peers…',
    metadata: 'Got the torrent info, opening the video…',
    buffering: 'Buffering…',
    playing: 'Playing',
    paused: 'Paused',
    error: 'Stopped',
  };

  const phaseText = $derived(
    controller.phase === 'connecting' && controller.viaRelay
      ? 'Relay is finding peers…'
      : PHASE_TEXT[controller.phase],
  );
  /** Screen readers hear "<phase> · <file name>" (the picture shows the spinner and title). */
  const statusText = $derived([phaseText, controller.fileName].filter((part) => part).join(' · '));
  let dragging = $state(false);
  const MENU_TESTIDS: Record<MenuId, string> = {
    subtitles: 'subtitles-menu',
    audio: 'audio-menu',
    files: 'files-panel',
    stats: 'stats-panel',
    share: 'share-panel',
    more: 'more-menu',
  };

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
  // shown = !playing || menuOpen || pointerOnControls || activity. A mouse move, a key press or a
  // touch is activity for `hideDelay` (auto-hide.ts: 5 s windowed; 1 s in fullscreen, 3 s after a
  // touch); the pointer leaving the player or the window ends it at once. On touch a tap on the
  // picture toggles the controls (never play/pause); a double-tap on its sides seeks
  // (touch-seek.ts). Focus doesn't keep them.
  let activity = $state(false);
  /** The last activity (for a fullscreen change while it runs): when, and whether a touch. */
  let wokeAt = 0;
  let wokeByTouch = false;
  let pointerOnControls = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const playing = $derived(!media.paused && !media.ended);
  // Menus of the control bar (docs/decisions/0008 §4): one open at a time, and it keeps the
  // controls shown. A panel inside the screen when there is room (or fullscreen), else a sheet.
  type MenuId = 'subtitles' | 'audio' | 'files' | 'stats' | 'share' | 'more';
  /** `fromMore`: opened from the compact bar's More menu (a Back row returns there). */
  let menu = $state<{ id: MenuId; fromMore: boolean } | null>(null);
  const menuOpen = $derived(menu !== null);
  let screenWidth = $state(0);
  let screenHeight = $state(0);
  const controlsShown = $derived(!playing || menuOpen || pointerOnControls || activity);

  const presentation = $derived(menuPresentation({ screenHeight, fullscreen }));
  const remPx =
    typeof getComputedStyle === 'function'
      ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      : 16;
  /** Compact bar (screen < 40rem, §3.6): stats, audio, files and share move into More. */
  const compact = $derived(screenWidth > 0 && screenWidth < 40 * remPx);
  /** A pointerdown outside just closed a menu: that press's click on the picture doesn't play/pause. */
  let menuClosedAt = 0;

  const share = new ShareLink(() => ({
    magnet: controller.magnet,
    fileIndex: controller.fileIndex,
  }));
  $effect(() => () => share.dispose());

  const showAudio = $derived(
    controller.audioTracks.length > 1 ||
      (controller.audioTracks.length > 0 && controller.audioTrackId === null),
  );
  const showFiles = $derived(controller.files.length > 1);
  const showStats = $derived(controller.phase !== 'error');
  const selectedAudio = $derived(
    controller.audioTracks.find((t) => t.id === controller.audioTrackId),
  );
  const audioLabel = $derived(selectedAudio?.label ?? 'Muted');
  const filePosition = $derived(
    `${controller.files.findIndex((f) => f.index === controller.fileIndex) + 1} of ${controller.files.length}`,
  );
  const selectedSubtitle = $derived(
    controller.subtitles.tracks.find((t) => t.key === controller.subtitles.selected),
  );
  const speedText = $derived(formatSpeed(controller.stats.downloadSpeed));
  const statsText = $derived(`${controller.stats.numPeers} peers · ${speedText}`);
  const silent = $derived(media.muted || media.volume === 0);

  const MENU_TITLES: Record<MenuId, string> = {
    subtitles: 'Subtitles',
    audio: 'Audio',
    files: 'Files',
    stats: 'Download stats',
    share: 'Share link',
    more: 'More',
  };

  /** The bar button a menu hangs from (More for menus opened from it). */
  function triggerFor(id: MenuId): HTMLElement | null {
    return screen?.querySelector<HTMLElement>(`[data-menu-trigger="${id}"]`) ?? null;
  }

  function anchorFor(m: { id: MenuId }) {
    return triggerFor(m.id) ?? triggerFor('more');
  }

  function toggleMenu(id: MenuId) {
    menu = menu?.id === id ? null : { id, fromMore: false };
  }

  function closeMenu(refocus: boolean) {
    const m = menu;
    if (!m) return;
    menu = null;
    // After the menu is gone: closing the sheet's modal <dialog> moves the focus itself.
    if (refocus) void tick().then(() => anchorFor(m)?.focus());
    else menuClosedAt = performance.now();
  }

  /** ↓ on a trigger opens its menu (Enter and Space click it). */
  function onTriggerKey(id: MenuId) {
    return (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      if (menu?.id !== id) menu = { id, fromMore: false };
    };
  }

  const triggerProps = (id: MenuId, popup: 'listbox' | 'dialog' | 'menu' = 'dialog') => ({
    'data-menu-trigger': id,
    'aria-haspopup': popup,
    'aria-expanded': menu?.id === id,
    onkeydown: onTriggerKey(id),
  });

  function toggleMute() {
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
  }

  async function copyShareLink() {
    if (!(await share.copy())) menu = { id: 'share', fromMore: menu?.id === 'more' };
  }

  let subtitleInput = $state<HTMLInputElement>();

  function onSubtitleUpload(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Clear it, so picking the same file again still fires `change`.
    input.value = '';
    if (file) void controller.subtitles.addFile(file);
  }

  function selectFile(index: number) {
    closeMenu(true);
    if (index !== controller.fileIndex) void controller.selectFile(index);
  }

  // Nothing to choose from once stopped; a fullscreen change moves everything around.
  $effect(() => {
    if (controller.phase === 'error' || controller.phase === 'idle') untrack(() => (menu = null));
  });
  $effect(() => {
    void fullscreen;
    untrack(() => (menu = null));
  });
  provideControlsShown(() => controlsShown);

  /** Touch input: decided by the last pointer, starting from the primary pointer's kind. */
  let touch = $state(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  /** Kind of the last pointerdown on the screen: a touch's click must not play/pause. */
  let lastPointerType = 'mouse';
  /** Touch and pen: taps (pointerdown) toggle the controls and double-taps seek; no click play/pause. */
  const touchLike = (pointerType: string) => pointerType === 'touch' || pointerType === 'pen';
  /** The last play/pause toggle, flashed in the centre once: cleared when its animation ends. */
  let flash = $state<Flash | null>(null);
  let flashCount = 0;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Matches the `.flash` animation in PlayerCentre.svelte. */
  const FLASH_MS = 400;

  const onControls = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('[data-player-controls], [data-player-menu]');
  const inMenu = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('[data-player-menu]');

  function wake(byTouch = false) {
    activity = true;
    wokeAt = performance.now();
    wokeByTouch = byTouch;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (activity = false), hideDelay({ fullscreen, touch: byTouch }));
  }

  // Entering or leaving fullscreen: the running timer gets that mode's delay, from the activity.
  $effect(() => {
    const fs = fullscreen;
    untrack(() => {
      if (!activity) return;
      const delay = hideDelay({ fullscreen: fs, touch: wokeByTouch });
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => (activity = false),
        remainingDelay(delay, performance.now() - wokeAt),
      );
    });
  });

  function hideControls() {
    pointerOnControls = false;
    clearTimeout(idleTimer);
    activity = false;
  }

  function onScreenPointerMove(event: PointerEvent) {
    if (touchLike(event.pointerType)) {
      // A drag on the seek bar keeps the controls; a finger moving over the picture doesn't.
      if (onControls(event.target)) wake(true);
      return;
    }
    touch = false;
    pointerOnControls = onControls(event.target);
    wake();
  }

  // Double-tap seeking (touch-seek.ts): a first tap on a side waits `DOUBLE_TAP_MS` before it acts
  // as a plain tap, so a double-tap never flickers the controls. Seeks are summed and sent to the
  // player `SEEK_COALESCE_MS` after the last tap (one seek, not one per tap); the overlay shows the
  // streak until it ends.
  let taps = NO_TAPS;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let streakTimer: ReturnType<typeof setTimeout> | undefined;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSeek = 0;
  /** The running streak, for the overlay (`n` restarts its pulse on every tap). */
  let streak = $state<{ side: SeekSide; total: number; n: number } | null>(null);

  /** A tap that may be a seek tap: on the picture (no control, menu, card or toast), file open. */
  function seekTapTarget(target: EventTarget | null) {
    if (!(target instanceof Element) || !media.hasMetadata || states.card !== null) return false;
    if (performance.now() - menuClosedAt < 500) return false;
    return !target.closest(
      'button, a, input, select, textarea, [role="alert"], [role="status"], [data-player-controls], [data-player-menu]',
    );
  }

  /** A plain tap on the picture shows or hides the controls. */
  function tapPicture() {
    if (controlsShown && activity && playing && !menuOpen) hideControls();
    else wake(true);
  }

  function queueSeek(by: number) {
    pendingSeek += by;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      const total = pendingSeek;
      pendingSeek = 0;
      if (total) seekBy(total);
    }, SEEK_COALESCE_MS);
  }

  function onPictureTap(event: PointerEvent) {
    const rect =
      event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null;
    const zone = rect ? tapZone(event.clientX - rect.left, rect.width) : 'middle';
    const next = onTap(taps, zone, performance.now());
    taps = next.state;
    clearTimeout(tapTimer);
    const action = next.action;
    if (action.type === 'tap') {
      clearTimeout(streakTimer);
      streak = null;
      tapPicture();
    } else if (action.type === 'wait') {
      tapTimer = setTimeout(() => {
        // No second tap: a plain one.
        taps = NO_TAPS;
        tapPicture();
      }, DOUBLE_TAP_MS);
    } else {
      queueSeek(action.by);
      streak = { side: action.side, total: action.total, n: (streak?.n ?? 0) + 1 };
      clearTimeout(streakTimer);
      streakTimer = setTimeout(() => {
        taps = NO_TAPS;
        streak = null;
      }, SEEK_STREAK_MS);
    }
  }

  function onScreenPointerDown(event: PointerEvent) {
    lastPointerType = event.pointerType;
    if (!touchLike(event.pointerType)) {
      touch = false;
      pointerOnControls = onControls(event.target);
      wake();
      return;
    }
    touch = true;
    pointerOnControls = false;
    // A tap on a control keeps them; a tap on the picture shows or hides them, or seeks.
    if (seekTapTarget(event.target)) return onPictureTap(event);
    // Anything else ends a waiting first tap (it must not hide the controls after this one).
    clearTimeout(tapTimer);
    taps = NO_TAPS;
    if (onControls(event.target)) wake(true);
    else tapPicture();
  }

  function onScreenPointerLeave(event: PointerEvent) {
    // Touch pointers "leave" after every tap.
    if (!touchLike(event.pointerType)) hideControls();
  }

  $effect(() => {
    // The pointer left the window.
    const root = document.documentElement;
    root.addEventListener('mouseleave', hideControls);
    return () => root.removeEventListener('mouseleave', hideControls);
  });

  // Errors and notices (docs/decisions/0008 §5): a card or toasts. A dismissed toast stays away
  // until the file changes.
  let dismissed = $state(new Set<PlaybackErrorCode>());
  $effect(() => {
    void controller.fileIndex;
    void controller.magnet;
    untrack(() => (dismissed = new Set()));
  });
  const subtitleNotice = $derived(controller.subtitles.notice);
  const states = $derived(
    playerStates({
      phase: controller.phase,
      error: controller.error?.code ?? null,
      notices: controller.notices,
      subtitleNotice: subtitleNotice
        ? { code: subtitleNotice.code, detail: subtitleNotice.detail }
        : null,
      dismissed,
    }),
  );

  // A new notice or error wakes the controls, like a move does.
  $effect(() => {
    if (controller.notices.length || controller.error || subtitleNotice || controller.resumedAt) {
      untrack(() => wake());
    }
  });

  $effect(() => () => {
    clearTimeout(idleTimer);
    clearTimeout(flashTimer);
    clearTimeout(tapTimer);
    clearTimeout(streakTimer);
    clearTimeout(seekTimer);
  });

  function togglePlay() {
    const v = video;
    if (!v) return;
    const willPlay = v.paused;
    if (willPlay) v.play().catch(() => {});
    else v.pause();
    // Cleared after the animation, so a later spinner or pause that hands the centre back to
    // `none` doesn't remount and replay it.
    flash = { playing: willPlay, n: ++flashCount };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), FLASH_MS);
  }

  function seekBy(by: number) {
    const v = video;
    if (v) seekVideo(v, seekTarget(v.currentTime, by, v.duration));
  }

  /** A mouse click on the picture plays/pauses; a tap only toggles the controls (pointerdown). */
  function onVideoClick() {
    if (touchLike(lastPointerType) || performance.now() - menuClosedAt < 500) return;
    togglePlay();
  }

  /** A double-click anywhere on the picture (not on the bar) toggles fullscreen. */
  function onScreenDblClick(event: MouseEvent) {
    // A double-tap on a side seeks (a touch double-tap can fire `dblclick` too).
    if (touchLike(lastPointerType) && taps.side !== null) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-player-bar], [data-player-menu]')
    )
      return;
    toggleFullscreen();
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function dragOver(event: DragEvent) {
    if (!carriesFiles(event) || controller.phase === 'error') return;
    event.preventDefault();
    dragging = true;
  }

  /** A Space keydown we handled: its keyup must not also activate a focused (native) control. */
  let spaceHandled = false;

  function onKeyDown(event: KeyboardEvent) {
    // Esc closes the open menu and gives the focus back to its trigger; only the next Esc leaves
    // fullscreen (where the browser lets the page keep it).
    if (event.key === 'Escape' && menu) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    const v = video;
    if (!v || event.defaultPrevented) return;
    // A key typed in a dialog (relay settings, help) is not meant for the player.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('dialog')) return;
    const stopped = controller.phase === 'idle' || controller.phase === 'error';
    if (!stopped) wake();
    // A menu's keys are its own (arrows move, Enter/Space pick); so are a trigger's Enter, Space
    // and ↓, which open its menu.
    if (inMenu(target)) return;
    if (
      target?.hasAttribute('aria-haspopup') &&
      [' ', 'Spacebar', 'Enter', 'ArrowDown'].includes(event.key)
    )
      return;
    const action = shortcutFor({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      targetTag: target?.tagName,
      targetEditable: target?.isContentEditable,
      inPlayerControls: onControls(target),
    });
    // Only `?` (help) and `H` (history) work without a file open.
    if (!action || (stopped && action.type !== 'help' && action.type !== 'history')) return;
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
        seekVideo(v, seekTarget(v.currentTime, action.by, v.duration));
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
      case 'help':
        helpDialog.show('shortcuts');
        break;
      case 'history':
        historyDialog.show(document.activeElement);
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

{#snippet statsChip()}
  <button
    type="button"
    class="stats-chip"
    data-testid="stats-button"
    aria-label="Download stats"
    {...triggerProps('stats')}
    onclick={() => toggleMenu('stats')}
  >
    <Users size={16} aria-hidden="true" />
    <span>{controller.stats.numPeers}</span>
    <ArrowDown size={16} aria-hidden="true" />
    <span>{speedText}</span>
  </button>
{/snippet}

{#snippet barButtons()}
  {#if controller.phase !== 'error'}
    <span class="trigger-wrap">
      <IconButton
        testid="subtitles"
        icon={controller.subtitles.selected === null ? CaptionsOff : Captions}
        class={controller.subtitles.selected === null ? '' : 'on'}
        label={selectedSubtitle
          ? `Subtitles: ${subtitleTrackText(selectedSubtitle)}`
          : 'Subtitles: off'}
        shortcut="C"
        data-value={controller.subtitles.selected ?? ''}
        {...triggerProps('subtitles', 'listbox')}
        onclick={() => toggleMenu('subtitles')}
      />
      {#if controller.subtitles.loading}<span class="badge spin" aria-hidden="true"></span>{/if}
    </span>
  {/if}
  {#if !compact}
    {#if showAudio}
      <span class="trigger-wrap">
        <IconButton
          testid="audio-track"
          icon={AudioLines}
          label={selectedAudio ? `Audio: ${audioTrackTitle(selectedAudio)}` : 'Audio: muted'}
          data-value={controller.audioTrackId ?? ''}
          {...triggerProps('audio', 'listbox')}
          onclick={() => toggleMenu('audio')}
        />
        {#if controller.audioTrackId === null}<span class="badge warn" aria-hidden="true"
          ></span>{/if}
      </span>
    {/if}
    {#if showFiles}
      <IconButton
        testid="files-button"
        icon={ListVideo}
        label="Files ({filePosition})"
        {...triggerProps('files')}
        onclick={() => toggleMenu('files')}
      />
    {/if}
    {#if controller.magnet}
      <IconButton
        testid="share-link"
        icon={share.state === 'copied' ? Check : Link}
        class={share.state === 'copied' ? 'copied' : ''}
        label={share.state === 'copied' ? 'Link copied' : 'Copy share link'}
        data-state={share.state}
        data-menu-trigger="share"
        onclick={() => void copyShareLink()}
      />
    {/if}
  {:else}
    <IconButton
      testid="more-button"
      icon={EllipsisVertical}
      label="More"
      {...triggerProps('more', 'menu')}
      onclick={() => toggleMenu('more')}
    />
  {/if}
{/snippet}

<section
  class="player"
  data-player-drop
  data-phase={controller.phase}
  hidden={controller.phase === 'idle'}
  ondragover={dragOver}
  ondragleave={(e) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
      dragging = false;
  }}
  ondrop={drop}
  aria-label="Player (drop a subtitle or .torrent file here)"
>
  <div
    class="screen"
    class:fullscreen
    class:idle={!controlsShown}
    class:carded={states.card !== null}
    class:lift={controlsShown}
    bind:this={screen}
    bind:clientWidth={screenWidth}
    bind:clientHeight={screenHeight}
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
      data-quota-hits={controller.buffer?.quotaHits ?? 0}
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
      status={showStats && !compact ? statsChip : undefined}
      buttons={barButtons}
    />
    <PlayerCentre
      {media}
      {touch}
      {flash}
      phase={controller.phase}
      viaRelay={controller.viaRelay}
      shown={controlsShown}
      covered={states.card !== null}
      ontoggleplay={togglePlay}
      onseek={seekBy}
    />
    <PlayerStates
      card={states.card}
      toasts={states.toasts}
      message={controller.error?.message ?? ''}
      viaRelay={controller.viaRelay}
      shown={controlsShown}
      {onretry}
      ondismiss={(code) => (dismissed = new Set([...dismissed, code]))}
      resumedAt={controller.resumedAt}
      onstartover={() => controller.startOver()}
      ondismissresume={() => controller.dismissResume()}
    />
    {#if streak}
      {@const s = streak}
      <div
        class="seek-streak {s.side}"
        data-testid="seek-streak"
        data-side={s.side}
        data-total={s.total}
        aria-hidden="true"
        out:fade={{ duration: 300 }}
      >
        {#key s.n}
          <span class="seek-streak-label">
            {#if s.side === 'back'}<ChevronsLeft size={28} aria-hidden="true" />{/if}
            <span>{formatStreak(s.total)}</span>
            {#if s.side === 'forward'}<ChevronsRight size={28} aria-hidden="true" />{/if}
          </span>
        {/key}
      </div>
    {/if}
    {#if dragging}
      <div class="drop-overlay" data-testid="drop-overlay" aria-hidden="true">
        <div class="drop-label">
          <Captions size={32} aria-hidden="true" />
          <span>Drop subtitles or a .torrent</span>
        </div>
      </div>
    {/if}
    <input
      bind:this={subtitleInput}
      class="sr-only"
      type="file"
      tabindex="-1"
      aria-hidden="true"
      accept={SUBTITLE_EXTENSIONS.join(',')}
      data-testid="subtitle-upload"
      onchange={onSubtitleUpload}
    />
    {#if menu && screen}
      {@const m = menu}
      {#key m.id}
        <Menu
          title={m.id === 'files' ? `Files · ${filePosition}` : MENU_TITLES[m.id]}
          testid={MENU_TESTIDS[m.id]}
          {presentation}
          drawer={m.id === 'files'}
          {screen}
          anchor={anchorFor(m)}
          onclose={closeMenu}
          onback={m.fromMore ? () => (menu = { id: 'more', fromMore: false }) : undefined}
        >
          {#if m.id === 'subtitles'}
            <SubtitleMenu
              subtitles={controller.subtitles}
              onpicked={() => closeMenu(true)}
              onupload={() => subtitleInput?.click()}
            />
          {:else if m.id === 'audio'}
            <AudioMenu
              tracks={controller.audioTracks}
              selected={controller.audioTrackId}
              onselect={(id) => {
                closeMenu(true);
                void controller.selectAudioTrack(id);
              }}
            />
          {:else if m.id === 'files'}
            <FileList
              files={controller.files}
              selected={controller.fileIndex}
              onselect={selectFile}
            />
          {:else if m.id === 'stats'}
            <StatsPanel
              stats={controller.stats}
              buffer={controller.buffer}
              hdr={controller.hdr}
              toneMapped={controller.notices.includes('hdr-sdr-display')}
            />
          {:else if m.id === 'share'}
            <div class="share-panel">
              <p>Couldn’t copy. Copy the link from here:</p>
              <div class="share-row">
                <input
                  type="text"
                  readonly
                  value={share.url}
                  data-menu-item
                  data-testid="share-url"
                  aria-label="Share link (copy it from here)"
                  onfocus={(e) => e.currentTarget.select()}
                  {@attach (el) => el.select()}
                />
                <IconButton
                  icon={share.state === 'copied' ? Check : Copy}
                  label={share.state === 'copied' ? 'Link copied' : 'Copy link'}
                  onclick={() => void share.copy()}
                />
              </div>
            </div>
          {:else if m.id === 'more'}
            <MoreMenu
              {silent}
              ontogglemute={toggleMute}
              rows={[
                ...(showAudio ? [{ id: 'audio' as const, value: audioLabel }] : []),
                ...(showFiles ? [{ id: 'files' as const, value: filePosition }] : []),
                ...(showStats ? [{ id: 'stats' as const, value: statsText }] : []),
              ]}
              share={controller.magnet ? share : null}
              onopen={(id) => (menu = { id, fromMore: true })}
              onshare={() => void copyShareLink()}
            />
          {/if}
        </Menu>
      {/key}
    {/if}
  </div>

  <p class="sr-only" data-testid="status" data-phase={controller.phase} aria-live="polite">
    {statusText}
  </p>
</section>

<style>
  /* Phone: the player is full-bleed (ADR 0008 §1). */
  @media (max-width: 40rem) {
    .screen:not(.fullscreen) {
      border-radius: 0;
    }
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
    /* No double-tap zoom (iPad Safari): a double-tap on the picture seeks. */
    touch-action: manipulation;
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
  /* Bar additions: the stats chip, trigger badges, active toggles. */
  .stats-chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    height: 2rem;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
  }
  .stats-chip span + :global(svg) {
    margin-left: var(--space-2);
  }
  @media (hover: hover) {
    .stats-chip:hover {
      background: rgb(255 255 255 / 0.12);
      color: var(--text);
    }
  }
  .stats-chip[aria-expanded='true'] {
    background: rgb(255 255 255 / 0.16);
    color: var(--text);
  }
  .stats-chip:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px rgb(0 0 0 / 0.5);
  }
  .screen :global(.icon-button.on) {
    color: var(--accent-fg);
  }
  .screen :global(.icon-button.copied) {
    color: var(--success);
  }
  .trigger-wrap {
    position: relative;
    display: inline-flex;
  }
  .badge {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    pointer-events: none;
  }
  .badge.warn {
    background: var(--warning);
  }
  .badge.spin {
    border: 2px solid var(--text-muted);
    border-top-color: transparent;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .share-panel {
    padding: 0 var(--space-4);
  }
  .share-panel p {
    margin: 0 0 var(--space-2);
    color: var(--text-muted);
  }
  .share-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .share-row input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
  }
  /* Room for a state card when the picture is small (phone, 16:9 placeholder). */
  .screen.carded:not(.fullscreen) {
    display: flex;
    align-items: center;
    min-height: min(30rem, 90vh);
  }
  /* Double-tap seek streak: a soft half-disc on that side with the amount (YouTube-like). */
  .seek-streak {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: var(--z-state);
    display: grid;
    place-items: center;
    width: 36%;
    background: rgb(255 255 255 / 0.12);
    color: var(--text);
    pointer-events: none;
  }
  .seek-streak.back {
    left: 0;
    border-radius: 0 50% 50% 0 / 0 50% 50% 0;
  }
  .seek-streak.forward {
    right: 0;
    border-radius: 50% 0 0 50% / 50% 0 0 50%;
  }
  .seek-streak-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-weight: var(--weight-medium);
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
  }
  @media (prefers-reduced-motion: no-preference) {
    .seek-streak-label {
      animation: streak-pulse var(--dur-base) var(--ease-out);
    }
  }
  @keyframes streak-pulse {
    from {
      transform: scale(0.85);
    }
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--z-drop);
    display: grid;
    place-items: center;
    background: var(--scrim);
    pointer-events: none;
  }
  .drop-overlay::before {
    position: absolute;
    inset: 12px;
    border: 2px dashed var(--accent-fg);
    border-radius: var(--radius-lg);
    content: '';
  }
  .drop-label {
    display: grid;
    gap: var(--space-2);
    justify-items: center;
    padding: var(--space-4);
    color: var(--text);
    font-weight: var(--weight-medium);
    text-align: center;
  }
  @media (max-width: 40rem) and (orientation: portrait) {
    video {
      max-height: none;
    }
  }
</style>
