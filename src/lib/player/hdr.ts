/**
 * HDR video (docs/decisions/0010): which HDR format a track is, from its colour space as
 * Mediabunny reads it (MKV `Colour`, MP4 `colr`, or the bitstream), and whether to warn that it is
 * tone-mapped. Only the transfer function decides: BT.2020 primaries with an SDR transfer
 * (BT.2020 10-bit, transfer 14) are wide colour gamut, not HDR.
 */

export type HdrFormat = 'hdr10' | 'hlg';

/** The part of `VideoColorSpaceInit` the decision needs; transfer as a name or an H.273 code. */
export interface ColorSpaceLike {
  primaries?: string | null;
  transfer?: string | number | null;
  matrix?: string | null;
}

/** H.273 transfer characteristics: 16 = SMPTE ST 2084 (PQ), 18 = ARIB STD-B67 (HLG). */
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

/** HDR10 for PQ (HDR10+ plays as HDR10), HLG for hybrid log-gamma, else null (SDR). */
export function hdrFormatOf(colorSpace: ColorSpaceLike | null | undefined): HdrFormat | null {
  const transfer = colorSpace?.transfer;
  if (transfer === 'pq' || transfer === TRANSFER_PQ) return 'hdr10';
  if (transfer === 'hlg' || transfer === TRANSFER_HLG) return 'hlg';
  return null;
}

/** Chip text in the stats panel. */
export const HDR_LABELS: Record<HdrFormat, string> = { hdr10: 'HDR10', hlg: 'HLG' };

/** The `(dynamic-range: high)` query: the display (and OS setting) can show HDR right now. */
export const HDR_DISPLAY_QUERY = '(dynamic-range: high)';

/** The "plays tone-mapped" toast applies: an HDR video on a display that shows only SDR. */
export function toneMapped(format: HdrFormat | null, displayHdr: boolean): boolean {
  return format !== null && !displayHdr;
}
