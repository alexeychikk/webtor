<script lang="ts">
  import { isTorrentId } from './lib/torrent/trackers';

  let input = $state('');
  let submitted = $state<string | null>(null);
  const valid = $derived(isTorrentId(input));

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (valid) submitted = input.trim();
  }
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
  {#if submitted}
    <p data-testid="status">Playback is not implemented yet.</p>
  {/if}
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
