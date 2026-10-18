<script lang="ts">
  import { onMount } from 'svelte';
  import { PlayerController } from './lib/player/controller.svelte';
  import Player from './lib/player/Player.svelte';
  import { isTorrentId } from './lib/torrent/trackers';
  import { magnetHash, readMagnetFromHash } from './lib/url-hash';

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

  function playFromHash() {
    const torrentId = readMagnetFromHash(location.hash);
    if (!torrentId || torrentId === current) return;
    input = torrentId;
    play(torrentId);
  }

  onMount(() => {
    playFromHash();
    window.addEventListener('hashchange', playFromHash);
    return () => {
      window.removeEventListener('hashchange', playFromHash);
      void controller.stop();
    };
  });
</script>

<main>
  <h1>webtor</h1>
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
</main>

<style>
  main {
    max-width: 60rem;
    margin: 2rem auto;
    padding: 0 1rem;
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
