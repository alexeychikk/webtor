#!/usr/bin/env node
// Writes the Dolby Vision e2e fixtures (docs/decisions/0010) from the ffmpeg-made MKVs, without
// any DV encoder: a `BlockAdditionMapping` with a DOVIDecoderConfigurationRecord goes into the
// video TrackEntry, as mkvmerge/ffmpeg write it for real DV. The H.264 picture is untouched.
//   dolby-vision-p5.mkv  ← short-audio.mkv, dvcC profile 5 (compatibility id 0): refused
//   dolby-vision-p8.mkv  ← sample.mkv, dvvC profile 8.1 (HDR10 base): plays, with a notice
// Room for it comes from the EBML Void that ffmpeg leaves in front of Info/Tracks, so the file keeps
// its length and nothing after Tracks moves (Cues, Clusters); SeekHead positions of the elements
// in between and the CRC-32 of each master element changed are rewritten.
//   node scripts/make-dv-fixtures.mjs   (after scripts/make-fixtures.sh)
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const dir = new URL('../e2e/fixtures/', import.meta.url);

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekPosition: 0x53ac,
  Void: 0xec,
  CRC32: 0xbf,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  BlockAdditionMapping: 0x41e4,
  BlockAddIDName: 0x41a4,
  BlockAddIDType: 0x41e7,
  BlockAddIDExtraData: 0x41ed,
};
const DVCC = 0x64766343;
const DVVC = 0x64767643;

function vint(buf, pos, keepMarker = false) {
  const first = buf[pos];
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
  return { value, length };
}

/** Element headers in `buf[start, end)`. */
function children(buf, start, end) {
  const out = [];
  for (let pos = start; pos < end;) {
    const id = vint(buf, pos, true);
    const size = vint(buf, pos + id.length);
    const dataStart = pos + id.length + size.length;
    out.push({
      id: id.value,
      start: pos,
      sizeLength: size.length,
      dataStart,
      end: dataStart + size.value,
    });
    pos = dataStart + size.value;
  }
  return out;
}

const idBytes = (id) => {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
};
/** A size vint of exactly `length` bytes. */
function sizeBytes(size, length) {
  if (size >= 2 ** (7 * length) - 1)
    throw new Error(`size ${size} needs more than ${length} bytes`);
  const out = [];
  for (let i = 0, v = size; i < length; i++, v = Math.floor(v / 256)) out.unshift(v & 0xff);
  out[0] |= 0x80 >> (length - 1);
  return out;
}
const element = (id, data, sizeLength = 1) => [
  ...idBytes(id),
  ...sizeBytes(data.length, sizeLength),
  ...data,
];
const uintData = (v) => (v === 0 ? [0] : idBytes(v));

/** Master element data with its CRC-32 child (if any) recomputed over what follows it. */
function withCrc(items) {
  const [first, ...rest] = items;
  if (first?.[0] !== ID.CRC32) return items.flat();
  const body = rest.flat();
  const crc = crc32(Uint8Array.from(body));
  return [ID.CRC32, 0x84, crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24, ...body];
}

function doviRecord({ profile, level, compat }) {
  const out = new Array(24).fill(0);
  out[0] = 1; // dv_version_major 1, minor 0
  out[2] = (profile << 1) | (level >> 5);
  out[3] = ((level & 0x1f) << 3) | 0b101; // rpu_present, no el, bl_present
  out[4] = compat << 4;
  return out;
}

function withDolbyVision(src, type, record) {
  const ebml = children(src, 0, src.length)[0];
  if (ebml.id !== ID.EBML) throw new Error('not an MKV');
  const [segment] = children(src, ebml.end, src.length);
  if (segment.id !== ID.Segment) throw new Error('no Segment');
  const top = children(src, segment.dataStart, Math.min(segment.end, src.length));
  const tracks = top.find((h) => h.id === ID.Tracks);
  const space = top.find((h) => h.id === ID.Void && h.start < tracks.start);
  if (!tracks || !space) throw new Error('needs a Void in front of Tracks');
  const bytes = (h) => [...src.subarray(h.start, h.end)];

  const mapping = element(ID.BlockAdditionMapping, [
    ...element(ID.BlockAddIDName, [...new TextEncoder().encode('Dolby Vision configuration')]),
    ...element(ID.BlockAddIDType, uintData(type)),
    ...element(ID.BlockAddIDExtraData, record),
  ]);
  let video = false;
  const entries = children(src, tracks.dataStart, tracks.end).map((h) => {
    if (h.id !== ID.TrackEntry) return bytes(h);
    const items = children(src, h.dataStart, h.end);
    const type = items.find((c) => c.id === ID.TrackType);
    if (video || src[type.dataStart] !== 1) return bytes(h);
    video = true;
    // The Void ffmpeg reserves in a video TrackEntry makes room too.
    const data = [...items.filter((c) => c.id !== ID.Void).map(bytes), mapping];
    return element(ID.TrackEntry, withCrc(data), h.sizeLength);
  });
  if (!video) throw new Error('no video track');
  const newTracks = element(ID.Tracks, withCrc(entries), tracks.sizeLength);
  const delta = newTracks.length - (tracks.end - tracks.start);
  const voidSize = space.end - space.dataStart - delta;
  if (voidSize < 0) throw new Error(`Void too small by ${-voidSize} bytes`);
  const newVoid = element(ID.Void, new Array(voidSize).fill(0), space.sizeLength);

  // Elements between the Void and Tracks move back by `delta`: fix their SeekHead entries.
  const moved = (pos) => pos > space.start && pos <= tracks.start;
  const head = [...src.subarray(0, space.start)];
  for (const sh of top.filter((h) => h.id === ID.SeekHead && h.end <= space.start)) {
    const items = children(src, sh.dataStart, sh.end).map((seek) => {
      if (seek.id !== ID.Seek) return bytes(seek);
      const fields = children(src, seek.dataStart, seek.end).map((f) => {
        const value = Number(src.subarray(f.dataStart, f.end).reduce((v, b) => v * 256 + b, 0));
        if (f.id !== ID.SeekPosition || !moved(segment.dataStart + value)) return bytes(f);
        const width = f.end - f.dataStart;
        const next = value - delta;
        const value_ = [];
        for (let i = 0, v = next; i < width; i++, v = Math.floor(v / 256)) value_.unshift(v & 0xff);
        return [...src.subarray(f.start, f.dataStart), ...value_];
      });
      return [...src.subarray(seek.start, seek.dataStart), ...fields.flat()];
    });
    const data = withCrc(items);
    if (data.length !== sh.end - sh.dataStart) throw new Error('SeekHead changed size');
    head.splice(sh.dataStart, data.length, ...data);
  }
  const out = Uint8Array.from([
    ...head,
    ...newVoid,
    ...src.subarray(space.end, tracks.start),
    ...newTracks,
    ...src.subarray(tracks.end),
  ]);
  if (out.length !== src.length) throw new Error('length changed');
  return out;
}

const make = (from, to, type, config) => {
  const src = new Uint8Array(readFileSync(new URL(from, dir)));
  writeFileSync(new URL(to, dir), withDolbyVision(src, type, doviRecord(config)));
  console.log(
    `${to}: ${from} + Dolby Vision profile ${config.profile} (compatibility ${config.compat})`,
  );
};
make('short-audio.mkv', 'dolby-vision-p5.mkv', DVCC, { profile: 5, level: 6, compat: 0 });
make('sample.mkv', 'dolby-vision-p8.mkv', DVVC, { profile: 8, level: 6, compat: 1 });
