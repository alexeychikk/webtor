<script lang="ts">
  import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
  import FileUp from '@lucide/svelte/icons/file-up';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Magnet from '@lucide/svelte/icons/magnet';
  import Play from '@lucide/svelte/icons/play';
  import Waypoints from '@lucide/svelte/icons/waypoints';
  import { onMount } from 'svelte';
  import IconButton from './lib/ui/IconButton.svelte';
  import { PlayerController, type TorrentInput } from './lib/player/controller.svelte';
  import Player from './lib/player/Player.svelte';
  import { helpDialog } from './lib/help/help-dialog.svelte';
  import WhyDialog from './lib/help/WhyDialog.svelte';
  import RelayDialog from './lib/torrent/RelayDialog.svelte';
  import { isTorrentFile } from './lib/torrent/files';
  import { checkRelayUrl } from './lib/torrent/relay';
  import { relaySettings } from './lib/torrent/relay-settings.svelte';
  import { isTorrentId } from './lib/torrent/trackers';
  import {
    magnetHash,
    readFileFromHash,
    readMagnetFromHash,
    takeRelayFromHash,
  } from './lib/url-hash';

  const controller = new PlayerController();
  let input = $state('');
  let video = $state<HTMLVideoElement>();
  /** What is loaded: a magnet / info hash, or the bytes of an opened .torrent file. */
  let current: TorrentInput | null = null;
  let draggingTorrent = $state(false);
  const valid = $derived(isTorrentId(input));
  /** An invalid value was submitted: danger border and helper until the field changes. */
  let invalid = $state(false);
  /** The empty page (ADR 0008 §1): wordmark, tagline, input; the player appears once something loads. */
  const hero = $derived(controller.phase === 'idle');

  function play(torrentId: TorrentInput, fileIndex: number | null = null) {
    current = torrentId;
    if (video) void controller.load(torrentId, video, fileIndex);
  }

  function start(value: string) {
    const torrentId = value.trim();
    // Shareable: the same URL autoplays this torrent (pushState does not fire hashchange).
    history.pushState(null, '', magnetHash(torrentId));
    play(torrentId);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid) {
      invalid = true;
      return;
    }
    start(input);
  }

  /** Enter on an invalid value: the disabled Play button blocks the form's implicit submission. */
  function onInputKey(event: KeyboardEvent) {
    if (event.key !== 'Enter' || valid) return;
    event.preventDefault();
    invalid = input.trim() !== '';
  }

  /** Pasting a magnet or info hash into the empty field plays it at once. */
  function onPaste(event: ClipboardEvent) {
    if (input.trim() !== '') return;
    const text = event.clipboardData?.getData('text').trim() ?? '';
    if (!isTorrentId(text)) return;
    event.preventDefault();
    input = text;
    invalid = false;
    start(text);
  }

  /** The header wordmark: back to the empty page (stops what plays). */
  function goHome(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    history.pushState(null, '', `${location.pathname}${location.search}`);
    current = null;
    input = '';
    invalid = false;
    void controller.stop();
  }

  /** A .torrent from the file picker or a drop. Its magnet goes into the hash once it is parsed. */
  async function openTorrentFile(file: File) {
    input = '';
    history.pushState(null, '', `${location.pathname}${location.search}`);
    play(new Uint8Array(await file.arrayBuffer()));
  }

  function onTorrentPicked(event: Event) {
    const el = event.currentTarget as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (file) void openTorrentFile(file);
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function onWindowDragOver(event: DragEvent) {
    if (!carriesFiles(event)) return;
    // Lets the drop happen here instead of the browser opening the file and leaving the page.
    event.preventDefault();
    // Over the player its own overlay shows (subtitles or a .torrent), unless it stopped.
    const overPlayer =
      event.target instanceof Element &&
      !!event.target.closest('[data-player-drop]') &&
      controller.phase !== 'error';
    draggingTorrent = !overPlayer;
  }

  function onWindowDrop(event: DragEvent) {
    draggingTorrent = false;
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    // Subtitle files are handled by the player (drop target); anything else is ignored.
    if (file && isTorrentFile(file)) void openTorrentFile(file);
  }

  // `#magnet=…&file=…` follows what plays: the auto-picked file, a switch, an opened .torrent.
  $effect(() => {
    const magnet = controller.magnet;
    const fileIndex = controller.fileIndex;
    if (magnet === null || fileIndex === null) return;
    const hash = magnetHash(magnet, fileIndex);
    if (hash !== location.hash) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
    }
  });

  /**
   * `#relay=<url>` (webtor-relay's printed Open link) saves the relay and leaves the address bar
   * (and history) at once: the URL is a password. An invalid one opens the dialog to show why.
   */
  function importRelayFromHash() {
    const { relayUrl, hash } = takeRelayFromHash(location.hash);
    if (hash === location.hash) return;
    history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
    if (!relayUrl) return;
    const check = checkRelayUrl(relayUrl, location.protocol);
    if (check.ok) relaySettings.save(check.base);
    else relaySettings.openDialog(relayUrl);
  }

  /** After the relay setting changed: retry a playback that is still looking for peers or failed. */
  function relayChanged() {
    if (current && (controller.phase === 'connecting' || controller.phase === 'error')) {
      play(current, controller.fileIndex);
    }
  }

  function onHashChange() {
    importRelayFromHash();
    playFromHash();
  }

  function playFromHash() {
    const torrentId = readMagnetFromHash(location.hash);
    const fileIndex = readFileFromHash(location.hash);
    if (!torrentId) return;
    const loaded = controller.phase !== 'idle';
    if (loaded && (torrentId === current || torrentId === controller.magnet)) {
      // Same torrent, e.g. the user edited `&file=` or went back: switch files only.
      if (fileIndex !== null && fileIndex !== controller.fileIndex) {
        void controller.selectFile(fileIndex);
      }
      return;
    }
    input = torrentId;
    play(torrentId, fileIndex);
  }

  onMount(() => {
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      void controller.stop();
    };
  });
</script>

<svelte:window
  ondragover={onWindowDragOver}
  ondragleave={(e) => {
    if (!e.relatedTarget) draggingTorrent = false;
  }}
  ondrop={onWindowDrop}
/>

{#snippet mark()}
  <span class="mark" aria-hidden="true"><Play size={16} strokeWidth={2.5} /></span>
{/snippet}

{#snippet torrentForm()}
  <form class="torrent-form" class:invalid onsubmit={submit} novalidate>
    <span class="field-icon" aria-hidden="true"><Magnet size={20} /></span>
    <input
      id="torrent-id"
      name="torrent-id"
      type="text"
      autocomplete="off"
      spellcheck="false"
      aria-label="Magnet link or info hash"
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={invalid ? 'torrent-id-problem' : undefined}
      placeholder="Paste a magnet link or info hash"
      bind:value={input}
      oninput={() => (invalid = false)}
      onkeydown={onInputKey}
      onpaste={onPaste}
    />
    <label class="open-file">
      <FolderOpen size={20} aria-hidden="true" />
      <input
        class="sr-only"
        type="file"
        accept=".torrent,application/x-bittorrent"
        aria-label="Open .torrent file"
        data-testid="torrent-file"
        onchange={onTorrentPicked}
      />
    </label>
    <IconButton class="go" type="submit" icon={Play} label="Play" disabled={!valid} />
  </form>
  {#if invalid}
    <p class="problem" id="torrent-id-problem">Not a magnet link or info hash</p>
  {/if}
{/snippet}

<div class="app" class:hero>
  <header class="top">
    {#if !hero}
      <h1 class="brand">
        <a href="{location.pathname}{location.search}" onclick={goHome}>
          {@render mark()}<span class="wordmark">webtor</span>
        </a>
      </h1>
      <div class="header-form">{@render torrentForm()}</div>
    {/if}
    <div class="actions">
      <span class="relay">
        <IconButton
          testid="relay-button"
          icon={Waypoints}
          class={relaySettings.base ? 'on' : ''}
          label={relaySettings.base ? 'Relay: on' : 'Connect a relay'}
          data-active={relaySettings.base !== null}
          onclick={() => relaySettings.openDialog()}
        />
        {#if relaySettings.base}<span class="dot" aria-hidden="true"></span>{/if}
      </span>
      <IconButton
        testid="why-button"
        icon={CircleQuestionMark}
        label="Why won’t my torrent play?"
        shortcut="?"
        onclick={() => helpDialog.show()}
      />
    </div>
  </header>
  {#if hero}
    <section class="hero-body">
      <h1 class="hero-title">{@render mark()}webtor</h1>
      <p class="tagline">Stream torrents right in your browser.</p>
      <div class="hero-form">{@render torrentForm()}</div>
      <p class="hint">or drop a .torrent anywhere</p>
    </section>
  {/if}
  <main class="watch-body">
    <Player
      {controller}
      bind:video
      onretry={() => {
        if (current) play(current, controller.fileIndex);
      }}
    />
  </main>
  {#if draggingTorrent}
    <div class="page-drop" data-testid="page-drop" aria-hidden="true">
      <div class="drop-label">
        <FileUp size={32} />
        <span>Drop a .torrent to play</span>
      </div>
    </div>
  {/if}
  <RelayDialog onchange={relayChanged} />
  <WhyDialog />
</div>

<style>
  .app {
    box-sizing: border-box;
    max-width: var(--player-max);
    min-height: 100dvh;
    margin: 0 auto;
    padding: 0 var(--space-4) var(--space-5);
  }
  .top {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-height: 4rem;
  }
  .actions {
    display: flex;
    flex: none;
    gap: var(--space-1);
    align-items: center;
    margin-left: auto;
  }
  .actions :global(.icon-button) {
    color: var(--text-muted);
  }
  .actions :global(.icon-button.on) {
    color: var(--text);
  }
  .relay {
    position: relative;
    display: inline-flex;
  }
  .dot {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    pointer-events: none;
  }
  .mark {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
  }
  .brand {
    flex: none;
    margin: 0;
    font-size: var(--text-xl);
  }
  .brand a {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    border-radius: var(--radius-sm);
    color: var(--text);
    font-weight: var(--weight-bold);
    letter-spacing: -0.02em;
    text-decoration: none;
  }
  .header-form {
    flex: 1;
    min-width: 0;
    max-width: 40rem;
  }
  @media (prefers-reduced-motion: no-preference) {
    .header-form {
      animation: rise var(--dur-slow) var(--ease-out);
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(1.5rem);
    }
  }

  /* Hero (phase idle). */
  .app.hero {
    display: flex;
    flex-direction: column;
  }
  .hero-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding-bottom: 12vh;
    text-align: center;
  }
  .hero-title {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    margin: 0;
    font-size: var(--text-hero);
    font-weight: var(--weight-bold);
    letter-spacing: -0.02em;
    line-height: var(--leading-tight);
  }
  .hero-title .mark {
    width: 1em;
    height: 1em;
  }
  .hero-title .mark :global(svg) {
    width: 0.55em;
    height: 0.55em;
  }
  .tagline {
    margin: var(--space-2) 0 var(--space-6);
    color: var(--text-muted);
  }
  .hero-form {
    width: 100%;
    max-width: 40rem;
    text-align: left;
  }
  .hint {
    margin: var(--space-3) 0 0;
    color: var(--text-faint);
    font-size: var(--text-sm);
  }
  @media (pointer: coarse) {
    .hint {
      display: none;
    }
  }
  .app.hero .watch-body {
    display: none;
  }

  /* The magnet field: a pill with the folder and the round Play inside. */
  .torrent-form {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    height: 2.75rem;
    padding: 0 var(--space-1) 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--surface-1);
  }
  .hero-form .torrent-form {
    height: 3.5rem;
    padding: 0 var(--space-2) 0 var(--space-4);
  }
  .torrent-form:focus-within {
    border-color: var(--focus);
  }
  .torrent-form.invalid {
    border-color: var(--danger);
  }
  .field-icon {
    display: inline-grid;
    flex: none;
    color: var(--text-faint);
  }
  #torrent-id {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 var(--space-1);
    border: 0;
    background: transparent;
    color: var(--text);
    outline: none;
  }
  #torrent-id::placeholder {
    color: var(--text-faint);
  }
  .open-file {
    position: relative;
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--hit);
    height: var(--hit);
    border-radius: 50%;
    color: var(--text-muted);
    cursor: pointer;
  }
  @media (hover: hover) {
    .open-file:hover {
      background: rgb(255 255 255 / 0.08);
      color: var(--text);
    }
  }
  .open-file:has(:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .torrent-form :global(.icon-button.go) {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
  }
  .hero-form .torrent-form :global(.icon-button.go) {
    width: var(--hit-touch);
    height: var(--hit-touch);
  }
  .torrent-form :global(.icon-button.go:hover:not(:disabled)) {
    background: var(--accent-hover);
  }
  .torrent-form :global(.icon-button.go:disabled) {
    background: var(--surface-3);
    color: var(--text-faint);
    cursor: default;
  }
  .problem {
    margin: var(--space-2) var(--space-4) 0;
    color: var(--danger);
    font-size: var(--text-sm);
  }

  .page-drop {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    pointer-events: none;
  }
  .page-drop::before {
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
    color: var(--text);
    font-weight: var(--weight-medium);
  }

  /* Phone: mark only in the header, full-bleed player. */
  @media (max-width: 40rem) {
    .app {
      padding: 0 0 var(--space-4);
    }
    .top {
      gap: var(--space-2);
      padding: 0 var(--space-2) 0 var(--space-3);
    }
    .app.hero .hero-body {
      padding: 0 var(--space-4) 12vh;
    }
    .wordmark {
      display: none;
    }
    .actions {
      gap: 0;
    }
  }
</style>
