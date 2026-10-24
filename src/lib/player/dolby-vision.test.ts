import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ID } from '../subtitles/mkv/ebml';
import { readMkvHeader } from '../subtitles/mkv/header';
import { ByteReader } from '../subtitles/mkv/reader';
import { cat, el, str, uint, unknownEl } from '../subtitles/mkv/test-ebml';
import {
  doviConfigOf,
  dolbyVisionPlayback,
  isDolbyVisionSampleEntry,
  parseDoviRecord,
  type DoviConfig,
} from './dolby-vision';
import type { ByteSource } from './types';

const DVCC = 0x64766343;
const DVVC = 0x64767643;

/** A 24-byte DOVIDecoderConfigurationRecord (version 1.0). */
function doviRecord(o: { profile: number; level?: number; compat: number; el?: boolean }) {
  const level = o.level ?? 6;
  const out = new Uint8Array(24);
  out[0] = 1;
  out[2] = (o.profile << 1) | (level >> 5);
  out[3] = ((level & 0x1f) << 3) | (1 << 2) | ((o.el ? 1 : 0) << 1) | 1; // RPU + BL present.
  out[4] = o.compat << 4;
  return out;
}

/** A Matroska file whose header has one HEVC video track with these mappings, plus a subtitle. */
function mkvWith(...mappings: number[][]): Uint8Array {
  const tracks = el(
    ID.Tracks,
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 1),
      uint(ID.TrackType, 1),
      str(ID.CodecID, 'V_MPEGH/ISO/HEVC'),
      ...mappings,
    ),
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 2),
      uint(ID.TrackType, 0x11),
      str(ID.CodecID, 'S_TEXT/UTF8'),
    ),
  );
  const segment = cat(el(ID.Info, uint(ID.TimestampScale, 1_000_000)), tracks);
  return new Uint8Array(cat(el(ID.EBML, str(0x4282, 'matroska')), unknownEl(ID.Segment, segment)));
}

const mapping = (type: number, record: Uint8Array) =>
  el(ID.BlockAdditionMapping, uint(ID.BlockAddIDType, type), el(ID.BlockAddIDExtraData, record));

const memory = (bytes: Uint8Array): ByteSource => ({
  size: bytes.length,
  read: (start, end) => Promise.resolve(bytes.slice(start, end)),
});

/** What the player does with the file: the header pass, then the classification. */
async function playbackOf(bytes: Uint8Array) {
  const header = (await readMkvHeader(new ByteReader(memory(bytes))))!;
  const config = doviConfigOf(header.videoTracks[0]!.blockAdditionMappings);
  return config && dolbyVisionPlayback(config);
}

describe('Dolby Vision in MKV', () => {
  it('refuses profile 5 (no backward-compatible base layer)', async () => {
    const bytes = mkvWith(mapping(DVCC, doviRecord({ profile: 5, compat: 0 })));
    expect(await playbackOf(bytes)).toEqual({ kind: 'unsupported', profile: '5' });
  });

  it('plays profile 8.1 (HDR10 base) and 8.4 (HLG base) as their base layer', async () => {
    expect(await playbackOf(mkvWith(mapping(DVVC, doviRecord({ profile: 8, compat: 1 }))))).toEqual(
      { kind: 'base-layer', profile: '8.1' },
    );
    expect(await playbackOf(mkvWith(mapping(DVVC, doviRecord({ profile: 8, compat: 4 }))))).toEqual(
      { kind: 'base-layer', profile: '8.4' },
    );
  });

  it('plays profile 7 (UHD Blu-ray, HDR10 base + enhancement layer) as its base layer', async () => {
    const bytes = mkvWith(mapping(DVCC, doviRecord({ profile: 7, compat: 6, el: true })));
    expect(await playbackOf(bytes)).toEqual({ kind: 'base-layer', profile: '7' });
  });

  it('refuses any profile with compatibility id 0', async () => {
    const bytes = mkvWith(mapping(DVVC, doviRecord({ profile: 8, compat: 0 })));
    expect(await playbackOf(bytes)).toEqual({ kind: 'unsupported', profile: '8' });
  });

  it('finds nothing without a DV mapping (plain HEVC, other mapping types)', async () => {
    expect(await playbackOf(mkvWith())).toBeNull();
    // An ITU-T T.35 (HDR10+) mapping, and a DV type without its record.
    const other = el(ID.BlockAdditionMapping, uint(ID.BlockAddIDType, 0x69747335));
    const empty = el(ID.BlockAdditionMapping, uint(ID.BlockAddIDType, DVCC));
    expect(await playbackOf(mkvWith(other, empty))).toBeNull();
  });

  it('reads the e2e fixtures as profile 5 and 8.1', async () => {
    const fixture = (name: string) =>
      new Uint8Array(readFileSync(new URL(`../../../e2e/fixtures/${name}`, import.meta.url)));
    expect(await playbackOf(fixture('dolby-vision-p5.mkv'))).toEqual({
      kind: 'unsupported',
      profile: '5',
    });
    expect(await playbackOf(fixture('dolby-vision-p8.mkv'))).toEqual({
      kind: 'base-layer',
      profile: '8.1',
    });
  });
});

describe('parseDoviRecord', () => {
  it('reads profile, level, flags and the compatibility id', () => {
    expect(parseDoviRecord(doviRecord({ profile: 7, level: 33, compat: 6, el: true }))).toEqual({
      profile: 7,
      level: 33,
      compatibility: 6,
      rpu: true,
      el: true,
      bl: true,
    } satisfies DoviConfig);
    expect(parseDoviRecord(new Uint8Array(4))).toBeNull();
  });

  it('refuses a record without a base layer', () => {
    const record = doviRecord({ profile: 8, compat: 1 });
    record[3]! &= ~1;
    expect(dolbyVisionPlayback(parseDoviRecord(record)!).kind).toBe('unsupported');
  });
});

describe('isDolbyVisionSampleEntry', () => {
  it('knows the MP4 Dolby Vision-only sample entries', () => {
    for (const entry of ['dvh1', 'dvhe', 'dva1', 'dvav', 'dav1']) {
      expect(isDolbyVisionSampleEntry(entry)).toBe(true);
    }
    for (const entry of ['hvc1', 'hev1', 'avc1', 'av01', 'XVID', '']) {
      expect(isDolbyVisionSampleEntry(entry)).toBe(false);
    }
  });
});
