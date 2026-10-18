/**
 * App state in the URL hash (docs/decisions/0001): `#magnet=<encoded magnet or info hash>&file=<n>`
 * (`n` = index into the torrent's file list, the file being played), and the one-shot `#relay=<encoded relay URL>` printed by webtor-relay (see `takeRelayFromHash`).
 * Pasted links often carry the magnet unencoded (`#magnet=magnet:?xt=…&dn=…&tr=…`); those are
 * accepted too, taking everything after `magnet=` as the magnet.
 */
export function readMagnetFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  if (!raw.startsWith('magnet=')) {
    const value = new URLSearchParams(raw).get('magnet');
    return value?.trim() || null;
  }
  const value = raw.slice('magnet='.length);
  if (/^magnet:\?/i.test(value)) {
    // Our own params can follow an unencoded magnet; no magnet carries `file=`.
    return value.replace(/&file=[^&]*/g, '').trim() || null;
  }
  const ampersand = value.indexOf('&');
  const encoded = ampersand < 0 ? value : value.slice(0, ampersand);
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' ')).trim() || null;
  } catch {
    return null;
  }
}

/** `#file=<n>`: the torrent file index to play, `null` when absent or not a whole number. */
export function readFileFromHash(hash: string): number | null {
  const parts = hash
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p.startsWith('file='));
  const value = parts.at(-1)?.slice('file='.length) ?? '';
  return /^\d{1,6}$/.test(value) ? Number(value) : null;
}

export function magnetHash(torrentId: string, fileIndex: number | null = null): string {
  const file = fileIndex === null ? '' : `&file=${fileIndex}`;
  return `#magnet=${encodeURIComponent(torrentId.trim())}${file}`;
}

/**
 * Splits `relay=<url>` (URL-encoded or not; a relay URL has no `&`) out of the hash, so the app can
 * save the setting and drop it from the address bar: the relay URL is a password. `hash` is what is
 * left, with its `#`, or `''`.
 */
export function takeRelayFromHash(hash: string): { relayUrl: string | null; hash: string } {
  const parts = hash.replace(/^#/, '').split('&');
  const i = parts.findIndex((p) => p.startsWith('relay='));
  if (i < 0) return { relayUrl: null, hash };
  const [part] = parts.splice(i, 1);
  let relayUrl: string | null;
  try {
    relayUrl = decodeURIComponent(part!.slice('relay='.length).replace(/\+/g, ' ')).trim() || null;
  } catch {
    relayUrl = null;
  }
  const rest = parts.filter(Boolean).join('&');
  return { relayUrl, hash: rest ? `#${rest}` : '' };
}
