<script lang="ts">
  import { onMount } from 'svelte';
  import { PlayerController } from './lib/player/controller.svelte';
  import Player from './lib/player/Player.svelte';
  import RelayDialog from './lib/torrent/RelayDialog.svelte';
  import { checkRelayUrl } from './lib/torrent/relay';
  import { relaySettings } from './lib/torrent/relay-settings.svelte';
  import { isTorrentId } from './lib/torrent/trackers';
  import { magnetHash, readMagnetFromHash, takeRelayFromHash } from './lib/url-hash';

  const controller = new PlayerController();
  let input = $state('');
  let video = $state<HTMLVideoElement>();
  let current: string | null = null;
  const valid = $derived(isTorrentId(input));

  function play(torrentId: string) {
    current = torrentId;
    if (video) void controller.load(torrentId, video);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid) return;
    const torrentId = input.trim();
    // Shareable: the same URL autoplays this torrent (pushState does not fire hashchange).
    history.pushState(null, '', magnetHash(torrentId));
    play(torrentId);
  }

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
      play(current);
    }
  }

  function onHashChange() {
    importRelayFromHash();
    playFromHash();
  }

  function playFromHash() {
    const torrentId = readMagnetFromHash(location.hash);
    if (!torrentId || torrentId === current) return;
    input = torrentId;
    play(torrentId);
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

<main>
  <header>
    <h1>webtor</h1>
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
  </form>
  <Player {controller} bind:video />
  <RelayDialog onchange={relayChanged} />
</main>

<style>
  main {
    max-width: 60rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
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
  input {
    flex: 1 1 30rem;
    padding: 0.5rem;
  }
</style>
