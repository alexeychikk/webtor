<script lang="ts">
  import { onMount } from 'svelte';
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

  function play(torrentId: TorrentInput, fileIndex: number | null = null) {
    current = torrentId;
    if (video) void controller.load(torrentId, video, fileIndex);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid) return;
    const torrentId = input.trim();
    // Shareable: the same URL autoplays this torrent (pushState does not fire hashchange).
    history.pushState(null, '', magnetHash(torrentId));
    play(torrentId);
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
    draggingTorrent = true;
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
    if (torrentId === current || torrentId === controller.magnet) {
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

<main>
  <header>
    <h1>webtor</h1>
    <button
      type="button"
      class="link"
      data-testid="why-button"
      onclick={() => (helpDialog.open = true)}
    >
      Why won’t my torrent play?
    </button>
    <button
      type="button"
      class="relay"
      data-testid="relay-button"
      data-active={relaySettings.base !== null}
      onclick={() => relaySettings.openDialog()}
    >
      {relaySettings.base ? 'Relay: on' : 'Connect a relay'}
    </button>
  </header>
  <p>Stream a torrent in your browser. Peer-to-peer over WebRTC — there is no server.</p>
  <form onsubmit={submit}>
    <label for="torrent-id">Magnet link or info hash</label>
    <input
      id="torrent-id"
      name="torrent-id"
      type="text"
      autocomplete="off"
      placeholder="magnet:?xt=urn:btih:…"
      bind:value={input}
    />
    <button type="submit" disabled={!valid}>Play</button>
    <label class="open-file">
      or open a .torrent file
      <input
        type="file"
        accept=".torrent,application/x-bittorrent"
        data-testid="torrent-file"
        onchange={onTorrentPicked}
      />
    </label>
  </form>
  {#if draggingTorrent}
    <p class="drop-hint" aria-hidden="true">Drop a .torrent file to play it</p>
  {/if}
  <Player {controller} bind:video />
  <RelayDialog onchange={relayChanged} />
  <WhyDialog />
</main>

<style>
  main {
    max-width: 60rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  h1 {
    margin-right: auto;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .relay[data-active='true']::before {
    content: '● ';
    color: seagreen;
  }
  form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  #torrent-id {
    flex: 1 1 30rem;
    min-width: 0;
    padding: 0.5rem;
  }
  .open-file {
    flex-basis: 100%;
    opacity: 0.85;
  }
  .open-file input {
    margin-left: 0.5rem;
  }
  @media (max-width: 40rem) {
    main {
      margin: 1rem auto;
      padding: 0 0.75rem;
    }
    h1 {
      margin: 0;
      font-size: 1.6rem;
    }
    form label[for='torrent-id'] {
      flex-basis: 100%;
    }
    #torrent-id {
      flex-basis: 100%;
    }
    form button[type='submit'] {
      flex: 1;
      padding: 0.5rem;
    }
    .open-file input {
      display: block;
      margin: 0.25rem 0 0;
      max-width: 100%;
    }
  }
  .drop-hint {
    padding: 0.5rem 0.75rem;
    border: 2px dashed currentColor;
    border-radius: 0.25rem;
    text-align: center;
  }
</style>
