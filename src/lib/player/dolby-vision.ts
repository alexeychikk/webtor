/**
 * Dolby Vision detection (docs/decisions/0010): what the DV configuration record says, and what the
 * player does with it. Pure; the MKV header pass (`readMkvHeader`) hands in the track's
 * `BlockAdditionMapping`s, Mediabunny the MP4 sample entry. See dolby-vision.test.ts.
 *
 * Browsers never show Dolby Vision itself. A DV track with a backward-compatible base layer
 * (profile 7, 8.x: HDR10, HLG or SDR) plays as that base layer; without one (profile 5, any
 * compatibility id 0) the picture decodes with wrong, green and purple colours, so it is refused.
 */

/** `BlockAddIDType` FourCCs of the DOVIDecoderConfigurationRecord (`dvcC` ≤ 7, `dvvC` 8–10, `dvwC` > 10). */
export const DOVI_BLOCK_ADD_ID_TYPES: ReadonlySet<number> = new Set([
  0x64766343, // dvcC
  0x64767643, // dvvC
  0x64767743, // dvwC
]);

/** MP4 sample entries that are Dolby Vision only (Mediabunny reports them as an unknown codec). */
const DOVI_SAMPLE_ENTRIES: ReadonlySet<string> = new Set(['dvh1', 'dvhe', 'dva1', 'dvav', 'dav1']);

export interface DoviConfig {
  profile: number;
  level: number;
  /** `dv_bl_signal_compatibility_id`: 0 none, 1 HDR10, 2 SDR, 4 HLG, 6 HDR10 (UHD Blu-ray). */
  compatibility: number;
  rpu: boolean;
  el: boolean;
  bl: boolean;
}

export interface BlockAdditionMapping {
  type: number;
  extraData: Uint8Array | null;
}

/** Parses a DOVIDecoderConfigurationRecord (`dvcC`/`dvvC` payload); `null` when too short. */
export function parseDoviRecord(record: Uint8Array): DoviConfig | null {
  if (record.length < 5) return null;
  const b2 = record[2]!;
  const b3 = record[3]!;
  return {
    profile: b2 >> 1,
    level: ((b2 & 1) << 5) | (b3 >> 3),
    rpu: ((b3 >> 2) & 1) === 1,
    el: ((b3 >> 1) & 1) === 1,
    bl: (b3 & 1) === 1,
    compatibility: record[4]! >> 4,
  };
}

/** The track's Dolby Vision configuration from its `BlockAdditionMapping`s; `null` = not DV. */
export function doviConfigOf(mappings: readonly BlockAdditionMapping[]): DoviConfig | null {
  for (const m of mappings) {
    if (!DOVI_BLOCK_ADD_ID_TYPES.has(m.type) || !m.extraData) continue;
    const config = parseDoviRecord(m.extraData);
    if (config) return config;
  }
  return null;
}

/** "5", "7", "8.1", "8.4": the profile as releases name it (8.x = compatibility id). */
export function doviProfileName(c: DoviConfig): string {
  return c.profile === 8 && c.compatibility > 0
    ? `${c.profile}.${c.compatibility}`
    : String(c.profile);
}

export type DolbyVisionPlayback =
  /** Plays its HDR10/HLG/SDR base layer (profile 7, 8.x): an info toast. */
  | { kind: 'base-layer'; profile: string }
  /** No base layer a browser can show (profile 5, compatibility id 0, no BL): refused. */
  | { kind: 'unsupported'; profile: string };

export function dolbyVisionPlayback(c: DoviConfig): DolbyVisionPlayback {
  const profile = doviProfileName(c);
  if (c.profile === 5 || c.compatibility === 0 || !c.bl) return { kind: 'unsupported', profile };
  return { kind: 'base-layer', profile };
}

/** Is this MP4 sample entry (`getInternalCodecId`) a Dolby Vision-only one (`dvh1`, `dvhe`…)? */
export function isDolbyVisionSampleEntry(entry: string): boolean {
  return DOVI_SAMPLE_ENTRIES.has(entry.toLowerCase());
}
