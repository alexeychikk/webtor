import { describe, expect, it } from 'vitest';
import { decodeSubtitleBytes, detectEncoding, looksLikeCp1251 } from './encoding';

const bytes = (...b: number[]) => new Uint8Array(b);
/** Encodes text in a single-byte code page via a reverse table built from TextDecoder. */
function encodeSingleByte(text: string, encoding: string): Uint8Array {
  const decoder = new TextDecoder(encoding);
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b++) table.set(decoder.decode(bytes(b)), b);
  return new Uint8Array([...text].map((ch) => table.get(ch) ?? 0x3f));
}

const SRT_RU = '1\n00:00:01,000 --> 00:00:02,000\nПривет, мир! Ёлка и ещё немного текста.\n';
const SRT_FR = '1\n00:00:01,000 --> 00:00:02,000\nC’est l’été à Noël, très bientôt. Größe.\n';

describe('detectEncoding', () => {
  it('honours BOMs', () => {
    expect(detectEncoding(bytes(0xef, 0xbb, 0xbf, 0x41))).toBe('utf-8');
    expect(detectEncoding(bytes(0xff, 0xfe, 0x41, 0x00))).toBe('utf-16le');
    expect(detectEncoding(bytes(0xfe, 0xff, 0x00, 0x41))).toBe('utf-16be');
  });

  it('takes valid UTF-8 (including Cyrillic) as UTF-8', () => {
    expect(detectEncoding(new TextEncoder().encode(SRT_RU))).toBe('utf-8');
    expect(detectEncoding(new TextEncoder().encode('plain ascii'))).toBe('utf-8');
  });

  it('tells windows-1251 Cyrillic from windows-1252 Western text', () => {
    expect(detectEncoding(encodeSingleByte(SRT_RU, 'windows-1251'))).toBe('windows-1251');
    expect(detectEncoding(encodeSingleByte(SRT_FR, 'windows-1252'))).toBe('windows-1252');
  });
});

describe('looksLikeCp1251', () => {
  it('needs whole words of high bytes', () => {
    expect(looksLikeCp1251(encodeSingleByte('да нет', 'windows-1251'))).toBe(true);
    expect(looksLikeCp1251(encodeSingleByte('café', 'windows-1252'))).toBe(false);
    expect(looksLikeCp1251(bytes(0x41, 0x42))).toBe(false);
  });
});

describe('decodeSubtitleBytes', () => {
  it('decodes each encoding back to the same text, dropping the BOM', () => {
    expect(decodeSubtitleBytes(encodeSingleByte(SRT_RU, 'windows-1251')).text).toBe(SRT_RU);
    expect(decodeSubtitleBytes(encodeSingleByte(SRT_FR, 'windows-1252')).text).toBe(SRT_FR);
    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SRT_RU)]);
    expect(decodeSubtitleBytes(utf8Bom).text).toBe(SRT_RU);
    const utf16 = new Uint8Array(2 + SRT_RU.length * 2);
    utf16.set([0xff, 0xfe]);
    [...SRT_RU].forEach((ch, i) => {
      const code = ch.charCodeAt(0);
      utf16[2 + i * 2] = code & 0xff;
      utf16[3 + i * 2] = code >> 8;
    });
    expect(decodeSubtitleBytes(utf16)).toEqual({ text: SRT_RU, encoding: 'utf-16le' });
  });
});
