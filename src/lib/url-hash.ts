/**
 * App state in the URL hash (docs/decisions/0001): `#magnet=<encoded magnet or info hash>`.
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
  if (/^magnet:\?/i.test(value)) return value.trim() || null;
  const ampersand = value.indexOf('&');
  const encoded = ampersand < 0 ? value : value.slice(0, ampersand);
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' ')).trim() || null;
  } catch {
    return null;
  }
}

export function magnetHash(torrentId: string): string {
  return `#magnet=${encodeURIComponent(torrentId.trim())}`;
}
