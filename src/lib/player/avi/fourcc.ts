/**
 * AVI video FourCCs (`strh.fccHandler`, else `BITMAPINFOHEADER.biCompression`) → what the user is
 * told. Only H.264 plays in the browser; everything else needs the relay (ADR 0007).
 */

const H264 = new Set(['H264', 'X264', 'AVC1', 'DAVC', 'VSSH', 'AVCX']);

/** True for the FourCCs that carry H.264 (Annex B) video. Case-insensitive. */
export function isH264FourCC(fourcc: string): boolean {
  return H264.has(fourcc.trim().toUpperCase());
}

const NAMES: ReadonlyArray<[RegExp, string]> = [
  [
    /^(XVID|DIVX|DX50|FMP4|MP4V|M4S2|MP4S|3IV2|DIV[456]|BLZ0|DXGM|UMP4|RMP4|SEDG|WV1F)$/,
    'DivX/Xvid (MPEG-4 Part 2)',
  ],
  [/^(DIV3|DIV4|MP43|MP42|MP41|MPG4|DIV1|DIV2|AP41|COL0|COL1|3IVD|3IV1)$/, 'DivX 3 / MS-MPEG4'],
  [/^(MJPG|AVRN|LJPG|JPGL|MJLS|DMB1)$/, 'Motion JPEG'],
  [/^(WMV[1-3]|WMVA|WVC1)$/, 'Windows Media Video'],
  [/^(MPG1|MPG2|MPEG|MP2V|MMES|PIM1)$/, 'MPEG-1/2'],
  [/^(HEVC|HVC1|H265|X265)$/, 'HEVC/H.265'],
  [/^(CVID)$/, 'Cinepak'],
  [/^(IV3[12]|IV4[1-5]|IV50)$/, 'Indeo'],
  [/^(DVSD|DV25|DV50|DVHD|CDVC)$/, 'DV'],
  [/^(H263|U263|I263|S263)$/, 'H.263'],
  [/^(VP[3-8]0|VP6F)$/, 'On2 VP'],
  [/^(MSVC|CRAM|WHAM)$/, 'Microsoft Video 1'],
  [/^(FFV1)$/, 'FFV1'],
  [/^(HFYU|FFVH)$/, 'HuffYUV'],
];

/** Display name of an AVI video format, e.g. `XVID` → `DivX/Xvid (MPEG-4 Part 2)`. */
export function aviVideoFormatName(fourcc: string): string {
  const cc = fourcc.trim().toUpperCase();
  if (isH264FourCC(cc)) return 'H.264';
  for (const [re, name] of NAMES) if (re.test(cc)) return name;
  // Unknown or raw (`\0\0\0\0` = uncompressed RGB): show the FourCC itself.
  const printable = cc.replace(/[^\x20-\x7e]/g, '').trim();
  return printable ? `${printable} video` : 'uncompressed video';
}
