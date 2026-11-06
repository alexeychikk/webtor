import { relayEndpoints } from '../torrent/relay';
import { fetchRelayDiagnostics } from '../torrent/relay-client';
import { COPIED_MS } from './share-link.svelte';
import { diagnosticsReport, relayReportNote, type RelayReport } from './diagnostics';

/** What "Copy diagnostics" reads: the app's state, the relay set (if any) and the torrent. */
export interface DiagnosticsSource {
  app(): Record<string, unknown>;
  relayBase(): string | null;
  infoHash(): string | null;
}

/**
 * "Copy diagnostics" (relay dialog): builds the report (diagnostics.ts) and copies it. `failed`: no
 * clipboard access; the dialog then shows `text` to copy by hand. `note` says what the report holds
 * of the relay (e.g. a relay too old to report).
 */
export class DiagnosticsCopy {
  state = $state<'idle' | 'collecting' | 'copied' | 'failed'>('idle');
  text = $state('');
  relay = $state<RelayReport['kind'] | null>(null);
  note = $state('');
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly source: DiagnosticsSource) {}

  /** Resolves to whether the report reached the clipboard. */
  async copy(): Promise<boolean> {
    clearTimeout(this.#timer);
    this.state = 'collecting';
    const report = this.#collect();
    // Started within the click: Safari copies only during the gesture, and the relay can take seconds.
    const copied = writeLater(report).catch(async () => {
      await navigator.clipboard.writeText(await report);
    });
    try {
      await report;
      await copied;
      this.state = 'copied';
      this.#timer = setTimeout(() => (this.state = 'idle'), COPIED_MS);
      return true;
    } catch {
      this.state = 'failed';
      return false;
    }
  }

  async #collect(): Promise<string> {
    const base = this.source.relayBase();
    const app = this.source.app();
    let relay: RelayReport = { kind: 'none' };
    if (base) {
      const urls = relayEndpoints(base, this.source.infoHash() ?? '');
      relay = await fetchRelayDiagnostics(urls.diagnostics, urls.info);
    }
    this.text = diagnosticsReport(app, relay, base, new Date());
    this.relay = relay.kind;
    this.note = relayReportNote(relay);
    return this.text;
  }

  reset() {
    clearTimeout(this.#timer);
    this.state = 'idle';
    this.text = '';
    this.relay = null;
    this.note = '';
  }
}

/** `clipboard.write` with the text still to come (a promised Blob); rejects where unsupported. */
async function writeLater(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('no ClipboardItem');
  }
  const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
  await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
}
