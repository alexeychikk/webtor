/**
 * Decodes subtitle file bytes (docs/decisions/0004): BOM if present → UTF-8 (fatal) →
 * windows-1251 if the bytes look like Cyrillic → windows-1252.
 */
export type SubtitleEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'windows-1252';

export function detectEncoding(bytes: Uint8Array): SubtitleEncoding {
  const [a, b, c] = bytes;
  if (a === 0xef && b === 0xbb && c === 0xbf) return 'utf-8';
  if (a === 0xff && b === 0xfe) return 'utf-16le';
  if (a === 0xfe && b === 0xff) return 'utf-16be';
  if (isValidUtf8(bytes)) return 'utf-8';
  return looksLikeCp1251(bytes) ? 'windows-1251' : 'windows-1252';
}

export function decodeSubtitleBytes(bytes: Uint8Array): {
  text: string;
  encoding: SubtitleEncoding;
} {
  const encoding = detectEncoding(bytes);
  // TextDecoder strips a BOM matching the encoding by default.
  return { text: new TextDecoder(encoding).decode(bytes), encoding };
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** А–я (0xC0–0xFF) plus Ё/ё (0xA8/0xB8) in windows-1251. */
const isCyrillic1251 = (byte: number) => byte >= 0xc0 || byte === 0xa8 || byte === 0xb8;

/**
 * Cyrillic text in windows-1251 is whole words of high bytes; Western text in windows-1252 has a
 * lone accented letter between ASCII ones ("café", "Größe"). So: most high bytes must sit in runs of
 * at least 3 letter bytes.
 */
export function looksLikeCp1251(bytes: Uint8Array): boolean {
  let high = 0;
  let inWords = 0;
  let run = 0;
  const flush = () => {
    if (run >= 3) inWords += run;
    run = 0;
  };
  for (const byte of bytes) {
    if (byte >= 0x80) high++;
    if (isCyrillic1251(byte)) run++;
    else flush();
  }
  flush();
  return high > 0 && inWords / high >= 0.5;
}
