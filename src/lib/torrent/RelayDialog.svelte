<script lang="ts">
  import { PLAYBACK_ERROR_MESSAGES } from '../player/errors';
  import { checkRelayUrl, RELAY_URL_PROBLEMS, relayEndpoints, relayErrorDetail } from './relay';
  import { fetchRelayInfo, RelayRequestError } from './relay-client';
  import { relaySettings } from './relay-settings.svelte';

  /** Called after the user saves or removes a relay, so the app can retry what is playing. */
  let { onchange }: { onchange?: () => void } = $props();

  // Relay releases (tag relay-v*) are the repository's only releases and are marked latest.
  const RELEASES_URL = 'https://github.com/alexeychikk/webtor/releases/latest';

  let dialog = $state<HTMLDialogElement>();
  let url = $state('');
  let touched = $state(false);
  let test = $state<
    | { state: 'idle' }
    | { state: 'testing' }
    | { state: 'ok'; version: string }
    | { state: 'failed'; message: string }
  >({ state: 'idle' });

  const check = $derived(checkRelayUrl(url, location.protocol));
  const problem = $derived(
    touched && url.trim() && !check.ok ? RELAY_URL_PROBLEMS[check.reason] : null,
  );

  $effect(() => {
    if (!dialog) return;
    if (relaySettings.dialogOpen && !dialog.open) {
      const initial = relaySettings.draft ?? relaySettings.base ?? '';
      url = initial;
      touched = initial !== '';
      test = { state: 'idle' };
      dialog.showModal();
    } else if (!relaySettings.dialogOpen && dialog.open) {
      dialog.close();
    }
  });

  function close() {
    relaySettings.dialogOpen = false;
    relaySettings.draft = null;
  }

  async function runTest() {
    touched = true;
    if (!check.ok) return;
    test = { state: 'testing' };
    const checked = url;
    try {
      const info = await fetchRelayInfo(relayEndpoints(check.base, '').info);
      if (url === checked) test = { state: 'ok', version: info.version };
    } catch (err) {
      if (url !== checked) return;
      const f = err instanceof RelayRequestError ? err.failure : ({ kind: 'network' } as const);
      const message =
        f.kind === 'network'
          ? PLAYBACK_ERROR_MESSAGES['relay-unreachable']
          : f.kind === 'timeout'
            ? 'The relay did not answer in time.'
            : `The relay did not answer as expected (${relayErrorDetail(f)}).`;
      test = { state: 'failed', message };
    }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    touched = true;
    if (!check.ok) return;
    relaySettings.save(check.base);
    close();
    onchange?.();
  }

  function remove() {
    relaySettings.save(null);
    close();
    onchange?.();
  }
</script>

<dialog bind:this={dialog} data-testid="relay-dialog" aria-labelledby="relay-title" onclose={close}>
  <form onsubmit={save}>
    <h2 id="relay-title">Connect a relay</h2>
    <p>
      A browser can only download from peers that speak WebRTC, and most torrents have none.
      <strong>webtor-relay</strong> is a small program you run yourself. It talks to regular BitTorrent
      peers (TCP, uTP, DHT, trackers) and passes the data to this page.
    </p>

    <h3>Set it up</h3>
    <ol>
      <li>
        Download <code>webtor-relay</code> for your system from the
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">latest relay release</a>.
      </li>
      <li>Run it. It prints a <em>Relay URL</em> and an <em>Open</em> link.</li>
      <li>
        Click the Open link, or paste the Relay URL below. Chrome and Firefox ask once to allow
        access to apps on your device or local network: allow it. In Safari, use the Open link.
      </li>
    </ol>

    <label for="relay-url">Relay URL</label>
    <div class="row">
      <input
        id="relay-url"
        data-testid="relay-url"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="http://127.0.0.1:7881/<token>"
        bind:value={url}
        oninput={() => {
          test = { state: 'idle' };
        }}
        onblur={() => (touched = true)}
        aria-invalid={problem ? 'true' : undefined}
        aria-describedby="relay-url-problem"
      />
      <button type="button" onclick={runTest} disabled={test.state === 'testing'}>Test</button>
    </div>
    {#if problem}
      <p class="problem" id="relay-url-problem">{problem}</p>
    {/if}
    <p class="test" data-testid="relay-test" data-state={test.state} aria-live="polite">
      {#if test.state === 'testing'}Testing…{:else if test.state === 'ok'}Connected to webtor-relay
        {test.version}.{:else if test.state === 'failed'}{test.message}{/if}
    </p>

    <p class="privacy">
      <strong>Privacy:</strong> the relay sees every byte and every torrent you open. Swarm peers and
      trackers see the relay's IP address — your home IP when it runs on your computer, just as with qBittorrent.
      Keep the relay URL secret: it is the password.
    </p>

    <div class="actions">
      {#if relaySettings.base}
        <button type="button" onclick={remove}>Disconnect relay</button>
      {/if}
      <span class="spacer"></span>
      <button type="button" onclick={close}>Cancel</button>
      <button type="submit" disabled={!check.ok}>Save</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    max-width: 40rem;
    width: calc(100% - 2rem);
  }
  h2 {
    margin-top: 0;
  }
  h3 {
    margin-bottom: 0.25rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  input {
    flex: 1;
    padding: 0.5rem;
  }
  .problem {
    color: crimson;
  }
  .test:empty {
    display: none;
  }
  .test[data-state='ok'] {
    color: seagreen;
  }
  .test[data-state='failed'] {
    color: crimson;
  }
  .privacy {
    padding: 0.5rem 0.75rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, orange 18%, transparent);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .spacer {
    flex: 1;
  }
</style>
