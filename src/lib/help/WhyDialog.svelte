<script lang="ts">
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import { helpDialog } from './help-dialog.svelte';

  const WEBTORRENT_DESKTOP_URL = 'https://webtorrent.io/desktop/';

  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (helpDialog.open && !dialog.open) dialog.showModal();
    else if (!helpDialog.open && dialog.open) dialog.close();
  });

  function openRelay() {
    helpDialog.open = false;
    relaySettings.openDialog();
  }
</script>

<dialog
  bind:this={dialog}
  data-testid="why-dialog"
  aria-labelledby="why-title"
  onclose={() => (helpDialog.open = false)}
>
  <h2 id="why-title">Why won’t my torrent play?</h2>
  <p>
    A browser tab can only download from peers that speak <strong>WebRTC</strong>: other browser
    tabs running webtor or another WebTorrent site,
    <a href={WEBTORRENT_DESKTOP_URL} target="_blank" rel="noopener noreferrer">WebTorrent Desktop</a
    >, webtorrent-cli and a few libtorrent 2.x builds. Browsers cannot open the plain TCP/UDP
    connections, DHT or UDP trackers that regular torrent clients use.
  </p>
  <p>
    Most torrent clients, such as qBittorrent, Transmission and µTorrent, therefore
    <strong>cannot serve browsers</strong>. A public torrent that only they seed has no peer this
    tab can reach, so it never starts, however many seeders other apps show.
  </p>
  <h3>What helps</h3>
  <ul>
    <li>
      <strong>Seed it from WebTorrent Desktop.</strong> Open the same magnet in
      <a href={WEBTORRENT_DESKTOP_URL} target="_blank" rel="noopener noreferrer"
        >WebTorrent Desktop</a
      >: it downloads from regular peers and serves browsers over WebRTC, so this tab can stream
      from it (and so can anyone you share the link with).
    </li>
    <li>
      <strong>Run a relay.</strong> webtor-relay is a small BitTorrent client you run yourself (on
      this computer or a server). It reaches regular peers and streams to this tab.
      <button type="button" data-testid="why-relay" onclick={openRelay}>Set up a relay…</button>
    </li>
    <li>
      Magnets with a web seed (<code>ws=</code>) or a .torrent URL (<code>xs=</code>) can play
      without any WebRTC peer.
    </li>
    <li>
      If it started and then stalled, the peers left or stopped sending data. It keeps retrying;
      more WebRTC seeders make it faster.
    </li>
  </ul>
  <form method="dialog">
    <button type="submit">Close</button>
  </form>
</dialog>

<style>
  dialog {
    max-width: min(40rem, calc(100vw - 2rem));
    box-sizing: border-box;
  }
  h2 {
    margin-top: 0;
  }
  li {
    margin-bottom: 0.5rem;
  }
  form {
    text-align: right;
  }
</style>
