/**
 * "Copy diagnostics" (relay dialog): one text blob with the app's playback state and, when a relay
 * is set, its event log for the torrent (`GET /v1/diagnostics`, api 4), for a bug report. The relay
 * URL and its token never appear in it: `redactRelay` removes them from the whole text.
 */

/** Warnings kept per torrent for the report (WebTorrent's web seed and tracker failures). */
export const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 300;

/** Where the relay side of a report came from. */
export type RelayReport =
  | { kind: 'none' }
  | { kind: 'ok'; report: unknown }
  | { kind: 'too-old'; version: string; api: number }
  | { kind: 'failed'; reason: string };

/** One line for the dialog after a copy: what the report holds of the relay. */
export function relayReportNote(r: RelayReport): string {
  switch (r.kind) {
    case 'none':
      return 'No relay is set: the report holds this page’s side only.';
    case 'ok':
      return 'The report holds this page’s side and the relay’s event log.';
    case 'too-old':
      return `webtor-relay ${r.version} is too old to report its side: update it for that. The report holds this page’s side only.`;
    case 'failed':
      return `The relay did not send its side (${r.reason}). The report holds this page’s side only.`;
  }
}

/** Appends a warning to a bounded list (newest last), clipped. */
export function pushWarning(list: string[], at: number, warning: unknown): void {
  const text = warning instanceof Error ? warning.message : String(warning);
  list.push(`+${(at / 1000).toFixed(1)}s ${text.slice(0, MAX_WARNING_CHARS)}`);
  if (list.length > MAX_WARNINGS) list.splice(0, list.length - MAX_WARNINGS);
}

/**
 * Replaces the relay's URL, its token and its host in `text`. `base` is the normalised relay URL
 * (`http(s)://host[:port]/<token>`, relay-settings).
 */
export function redactRelay(text: string, base: string | null): string {
  if (!base) return text;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return text.split(base).join('<relay>');
  }
  const token = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let out = text.split(base).join('<relay>');
  if (token.length >= 4) out = out.split(token).join('<token>');
  if (url.host) out = out.split(url.host).join('<relay-host>');
  return out;
}

/** Every URL in `text` reduced to its origin (paths and queries can hold passkeys or tokens). */
export function originsOnly(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/"'?#]+)[^\s"']*/gi, '$1');
}

/** The report as copied: pretty JSON, relay URL and token removed. */
export function diagnosticsReport(
  app: Record<string, unknown>,
  relay: RelayReport,
  relayBase: string | null,
  now: Date,
): string {
  const relayPart =
    relay.kind === 'ok'
      ? relay.report
      : relay.kind === 'none'
        ? null
        : { unavailable: relayReportNote(relay) };
  const report = { webtorDiagnostics: 1, createdAt: now.toISOString(), app, relay: relayPart };
  return redactRelay(JSON.stringify(report, null, 2), relayBase);
}

const PROBE_TYPES: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  h264High10: 'video/mp4; codecs="avc1.6e0028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  hevcMain10: 'video/mp4; codecs="hvc1.2.4.L120.90"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  vp9: 'video/mp4; codecs="vp09.00.40.08"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  opus: 'audio/mp4; codecs="opus"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
};

/** What the browser can do that playback depends on (feature detection only). */
export function browserFeatures(): Record<string, unknown> {
  const g = globalThis as typeof globalThis & {
    ManagedMediaSource?: typeof MediaSource;
    RTCPeerConnection?: unknown;
  };
  const mse = g.ManagedMediaSource ?? g.MediaSource;
  const nav = g.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const codecs: Record<string, boolean> = {};
  for (const [name, type] of Object.entries(PROBE_TYPES)) {
    codecs[name] = Boolean(mse?.isTypeSupported(type));
  }
  return {
    userAgent: nav?.userAgent,
    mediaSource: typeof g.MediaSource === 'function',
    managedMediaSource: typeof g.ManagedMediaSource === 'function',
    webrtc: typeof g.RTCPeerConnection === 'function',
    codecs,
    deviceMemory: nav?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
    secureContext: g.isSecureContext,
    hdrDisplay: g.matchMedia?.('(dynamic-range: high)').matches,
  };
}
