<script lang="ts">
  import Waypoints from '@lucide/svelte/icons/waypoints';
  import X from '@lucide/svelte/icons/x';
  import { SHORTCUTS } from '../player/shortcuts';
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { closeOnBackdrop, showPageDialog } from '../ui/page-dialog';
  import { helpDialog } from './help-dialog.svelte';

  const WEBTORRENT_DESKTOP_URL = 'https://webtorrent.io/desktop/';

  let dialog = $state<HTMLDialogElement>();
  let shortcuts = $state<HTMLElement>();
  let hdr = $state<HTMLElement>();

  $effect(() => {
    if (!dialog) return;
    if (helpDialog.open && !dialog.open) {
      const d = dialog;
      // Opened by `?`: straight to the keyboard shortcuts; by the HDR toast: to the HDR section.
      void showPageDialog(d, () => helpDialog.open).then(() => {
        const section = helpDialog.section;
        const target = section === 'shortcuts' ? shortcuts : section === 'hdr' ? hdr : null;
        if (target) target.scrollIntoView({ block: 'start' });
        else d.scrollTop = 0;
      });
    } else if (!helpDialog.open && dialog.open) dialog.close();
  });

  function close() {
    helpDialog.open = false;
  }

  // Close button, Esc (`onclose`) and a click on the backdrop all close it.
  $effect(() => (dialog ? closeOnBackdrop(dialog, close) : undefined));

  function openRelay() {
    close();
    relaySettings.openDialog();
  }
</script>

<dialog
  bind:this={dialog}
  class="page-dialog"
  data-testid="why-dialog"
  aria-labelledby="why-title"
  onclose={close}
>
  <div class="dialog-header">
    <h2 id="why-title">Why won’t my torrent play?</h2>
    <IconButton icon={X} label="Close" onclick={close} />
  </div>
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
      <button type="button" class="btn relay" data-testid="why-relay" onclick={openRelay}>
        <Waypoints size={18} aria-hidden="true" />Set up a relay…
      </button>
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
  <h3>It loads, but the video won’t play</h3>
  <p data-testid="why-video">
    The video is never converted, so it plays only if this browser decodes its codec: HEVC (H.265)
    and 10-bit H.264 need Safari, or Chrome/Edge with a hardware decoder. For HDR and Dolby Vision,
    see the HDR section below.
  </p>
  <section bind:this={hdr} data-testid="hdr-help" aria-labelledby="hdr-title">
    <h3 id="hdr-title">HDR</h3>
    <p>
      HDR10 and HLG videos keep their HDR colours here. They show as HDR only when the browser, the
      graphics card and the display all do it; otherwise they play tone-mapped to SDR, which looks
      flatter but has the right colours.
    </p>
    <ul>
      <li>
        <strong>Windows:</strong> turn on Settings › System › Display › <em>Use HDR</em>. On a
        laptop, also clear “Turn off HDR when on battery”.
      </li>
      <li>
        A graphics card with HEVC Main10 hardware decoding and current drivers, and hardware
        acceleration on in the browser’s settings.
      </li>
      <li>
        <strong>Chrome 110+</strong> works best. <strong>Edge</strong> also needs the “HEVC Video
        Extensions” from the Microsoft Store. <strong>Firefox 153+</strong> shows HDR on AMD and NVIDIA
        graphics, with the HEVC Video Extensions installed.
      </li>
      <li>
        <strong>Safari</strong> on macOS and iPad shows HDR10 and HLG on HDR displays.
      </li>
      <li>
        <strong>Dolby Vision</strong> never shows as such: profiles 7 and 8 play their HDR10/HLG
        fallback, but profile 5 has none and can’t play in a browser. Look for an HDR10 or SDR release.
      </li>
    </ul>
  </section>
  <section bind:this={shortcuts} data-testid="shortcuts-help" aria-labelledby="shortcuts-title">
    <h3 id="shortcuts-title">Keyboard shortcuts</h3>
    <dl>
      {#each SHORTCUTS as s (s.keys)}
        <div>
          <dt>
            {#each s.keys.split(' / ') as key, i (key)}{#if i > 0}<span class="sep">/</span
                >{/if}<kbd>{key}</kbd>{/each}
          </dt>
          <dd>{s.action}</dd>
        </div>
      {/each}
    </dl>
  </section>
</dialog>

<style>
  li {
    margin-bottom: var(--space-2);
  }
  ul {
    padding-left: var(--space-5);
  }
  .relay {
    display: flex;
    margin-top: var(--space-2);
  }
  section {
    scroll-margin-top: var(--space-4);
  }
  dl {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }
  dl div {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }
  dt {
    display: flex;
    flex: none;
    gap: var(--space-1);
    align-items: center;
    min-width: 6rem;
  }
  dd {
    margin: 0;
    color: var(--text-muted);
  }
  .sep {
    color: var(--text-faint);
  }
</style>
