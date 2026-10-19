<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import X from '@lucide/svelte/icons/x';
  import IconButton from '../ui/IconButton.svelte';
  import { showPageDialog } from '../ui/page-dialog';
  import { PLAYBACK_ERROR_MESSAGES } from '../player/errors';
  import {
    checkRelayUrl,
    RELAY_URL_PROBLEMS,
    relayEndpoints,
    relayErrorDetail,
    transcodeSummary,
    type RelayTranscodeInfo,
  } from './relay';
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
    | { state: 'ok'; version: string; transcode: RelayTranscodeInfo }
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
      void showPageDialog(dialog, () => relaySettings.dialogOpen);
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
      if (url === checked) {
        test = { state: 'ok', version: info.version, transcode: info.transcode };
      }
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

<dialog
  bind:this={dialog}
  class="page-dialog"
  data-testid="relay-dialog"
  aria-labelledby="relay-title"
  onclose={close}
>
  <form onsubmit={save}>
    <div class="dialog-header">
      <h2 id="relay-title">Connect a relay</h2>
      <IconButton icon={X} label="Close" onclick={close} />
    </div>
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
      <button type="button" class="btn" onclick={runTest} disabled={test.state === 'testing'}
        >Test</button
      >
    </div>
    {#if problem}
      <p class="problem" id="relay-url-problem">{problem}</p>
    {/if}
    <p class="test" data-testid="relay-test" data-state={test.state} aria-live="polite">
      {#if test.state === 'testing'}<span class="icon spin"><LoaderCircle size={18} /></span
        >Testing…{:else if test.state === 'ok'}<span class="icon"><Check size={18} /></span
        >Connected to webtor-relay
        {test.version}.{:else if test.state === 'failed'}<span class="icon"
          ><CircleAlert size={18} /></span
        >{test.message}{/if}
    </p>
    {#if test.state === 'ok'}
      <p
        class="transcode"
        data-testid="relay-transcode"
        data-available={test.transcode.available}
        aria-live="polite"
      >
        {transcodeSummary(test.transcode)}
      </p>
    {/if}

    <p class="privacy">
      <strong>Privacy:</strong> the relay sees every byte and every torrent you open. Swarm peers and
      trackers see the relay's IP address — your home IP when it runs on your computer, just as with qBittorrent.
      Keep the relay URL secret: it is the password.
    </p>

    <div class="actions">
      {#if relaySettings.base}
        <button type="button" class="btn btn-danger" onclick={remove}>Disconnect relay</button>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="btn" onclick={close}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={!check.ok}>Save</button>
    </div>
  </form>
</dialog>

<style>
  ol {
    padding-left: var(--space-5);
  }
  li {
    margin-bottom: var(--space-1);
  }
  label {
    display: block;
    margin: var(--space-4) 0 var(--space-2);
    font-weight: var(--weight-medium);
  }
  .row {
    display: flex;
    gap: var(--space-2);
  }
  input {
    flex: 1;
    min-width: 0;
    min-height: var(--hit);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    color: var(--text);
  }
  input::placeholder {
    color: var(--text-faint);
  }
  input[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .problem {
    margin: var(--space-2) 0 0;
    color: var(--danger);
  }
  .test {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin: var(--space-3) 0 0;
  }
  .test:empty {
    display: none;
  }
  .icon {
    display: inline-grid;
    flex: none;
    padding-top: 3px;
  }
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .test[data-state='ok'] {
    color: var(--success);
  }
  .test[data-state='failed'] {
    color: var(--danger);
  }
  .transcode {
    margin-top: var(--space-1);
  }
  .transcode[data-available='false'] {
    color: var(--warning);
  }
  .privacy {
    margin: var(--space-5) 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--warning-soft);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .spacer {
    flex: 1;
  }
</style>
