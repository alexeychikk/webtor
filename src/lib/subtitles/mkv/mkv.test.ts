import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../player/types';
import type { SubtitleCue } from '../cue';
import { assBlockText } from './blocks';
import { ID, readVint } from './ebml';
import {
  MAX_FONT_BYTES,
  assHeaderOf,
  embeddedTrackInfo,
  isFontAttachment,
  readFontAttachments,
} from './embedded';
import { readAttachments, readCuePoints, readMkvHeader, type MkvSubtitleTrack } from './header';
import { ByteReader, readRange } from './reader';
import { ClusterScanner } from './scanner';

const fixture = new Uint8Array(
  readFileSync(new URL('../../../../e2e/fixtures/sample.mkv', import.meta.url)),
);

/** In-memory source that records the ranges read; `chunk` > 0 answers with a ReadableStream. */
function memorySource(bytes: Uint8Array, chunk = 0) {
  const reads: Array<[number, number]> = [];
  const source: ByteSource = {
    size: bytes.length,
    read(start, end) {
      reads.push([start, end]);
      const slice = bytes.slice(start, end);
      if (!chunk) return Promise.resolve(slice);
      return new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < slice.length; i += chunk) c.enqueue(slice.slice(i, i + chunk));
          c.close();
        },
      });
    },
  };
  return { source, reads };
}

async function scanAll(bytes: Uint8Array, from = 0, until = Infinity) {
  const { source } = memorySource(bytes);
  const header = (await readMkvHeader(new ByteReader(source)))!;
  const cues = new Map<number, SubtitleCue[]>();
  const scanner = new ClusterScanner(source, header, (track, list) =>
    cues.set(track, [...(cues.get(track) ?? []), ...list]),
  );
  const covered = await scanner.scan(from, until);
  return { header, cues, covered, scanner };
}

describe('EBML primitives', () => {
  it('reads vints, keeping the marker for IDs and flagging unknown sizes', () => {
    expect(readVint(new Uint8Array([0x81]), 0)).toEqual({ value: 1, length: 1, unknown: false });
    expect(readVint(new Uint8Array([0x40, 0x02]), 0)).toEqual({
      value: 2,
      length: 2,
      unknown: false,
    });
    expect(readVint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, true)?.value).toBe(ID.EBML);
    expect(
      readVint(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)?.unknown,
    ).toBe(true);
    expect(readVint(new Uint8Array([0x40]), 0)).toBeNull(); // Needs more bytes.
    expect(() => readVint(new Uint8Array([0x00]), 0)).toThrow(/invalid/);
  });

  it('readRange collects a chunked stream', async () => {
    const { source } = memorySource(fixture, 1000);
    expect(await readRange(source, 100, 5100)).toEqual(fixture.slice(100, 5100));
  });

  it('readRange cancels when aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const { source } = memorySource(fixture, 1000);
    await expect(readRange(source, 0, 10, abort.signal)).rejects.toThrow();
  });
});

describe('MKV header on sample.mkv', () => {
  it('lists the SRT and ASS subtitle tracks with language, codec and the ASS header', async () => {
    const { source } = memorySource(fixture);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    expect(header.timestampScale).toBe(1_000_000);
    expect(header.firstCluster).toBeGreaterThan(header.segmentStart);
    expect(header.subtitleTracks.map(({ codecPrivate, ...t }) => t)).toEqual([
      {
        number: 4,
        codecId: 'S_TEXT/UTF8',
        format: 'srt',
        language: 'eng',
        name: '',
        isDefault: false,
        forced: false,
        encodings: [],
      },
      {
        number: 5,
        codecId: 'S_TEXT/ASS',
        format: 'ass',
        language: 'rus',
        name: '',
        isDefault: false,
        forced: false,
        encodings: [],
      },
    ]);
    expect(header.subtitleTracks[0]!.codecPrivate).toBeNull();
    const assHeader = new TextDecoder().decode(header.subtitleTracks[1]!.codecPrivate!);
    expect(assHeader).toMatch(/^\[Script Info\]/);
    expect(assHeader).toContain('[V4+ Styles]');
  });

  it('finds the Cues through the SeekHead: one cluster every 2 s', async () => {
    const { source } = memorySource(fixture);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const points = await readCuePoints(new ByteReader(source), header);
    expect(points.map((p) => p.time)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(points[0]!.cluster).toBe(header.firstCluster);
    expect(await readAttachments(new ByteReader(source), header)).toEqual([]);
  });

  it('is null for a file that is not Matroska', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(await readMkvHeader(new ByteReader(memorySource(mp4).source))).toBeNull();
  });
});

describe('cluster scan on sample.mkv', () => {
  it('extracts every cue of both tracks (ASS as plain text plus its raw block)', async () => {
    const { cues, covered } = await scanAll(fixture);
    expect(covered).toBe(Infinity);
    expect(cues.get(4)).toEqual([
      { start: 1, end: 3, text: 'Hello from English SRT' },
      { start: 5, end: 8, text: 'Second english cue' },
    ]);
    expect(cues.get(5)).toEqual([
      {
        start: 2,
        end: 4,
        text: 'Привет из ASS',
        assChunk: '0,0,Default,,0,0,0,,{\\i1}Привет из ASS{\\i0}',
      },
      { start: 6, end: 9, text: 'Второй субтитр', assChunk: '1,0,Default,,0,0,0,,Второй субтитр' },
    ]);
  });

  it('starts at the cluster holding the playhead and stops past the target', async () => {
    const { cues, covered } = await scanAll(fixture, 6.5, 7);
    // Cluster 6–8 s only: the next one starts just before 8 s (audio leads the keyframe).
    expect(covered).toBeCloseTo(8, 0);
    expect(cues.get(4)).toBeUndefined(); // "Second english cue" starts at 5 s, in the 4–6 s cluster.
    expect(cues.get(5)).toMatchObject([{ start: 6, end: 9, text: 'Второй субтитр' }]);
  });

  it('does not read clusters again or emit duplicates when a range is scanned twice', async () => {
    const { source, reads } = memorySource(fixture);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const emitted: SubtitleCue[] = [];
    const scanner = new ClusterScanner(source, header, (_, list) => emitted.push(...list));
    await scanner.scan(0, 5);
    const count = reads.length;
    expect(await scanner.scan(1, 5)).toBeCloseTo(6, 0);
    expect(reads.length).toBe(count);
    await scanner.scan(0, Infinity);
    expect(emitted.map((c) => c.start).sort()).toEqual([1, 2, 5, 6]);
  });

  it('works over a chunked ReadableStream source and honours abort', async () => {
    const { source } = memorySource(fixture, 4096);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const seen: string[] = [];
    await new ClusterScanner(source, header, (_, list) =>
      seen.push(...list.map((c) => c.text)),
    ).scan(0, Infinity);
    expect(seen).toHaveLength(4);
    const abort = new AbortController();
    abort.abort();
    await expect(
      new ClusterScanner(source, header, () => {}).scan(0, 5, abort.signal),
    ).rejects.toThrow();
  });
});

// --- A tiny EBML writer for cases the fixture doesn't have. ---

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}
function sizeBytes(size: number | null): number[] {
  if (size === null) return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return [0x10, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff].map((b, i) =>
    i === 0 ? b | ((size / 2 ** 24) & 0x0f) : b,
  );
}
type Bytes = number[] | Uint8Array;
const cat = (...parts: Bytes[]) => parts.flatMap((p) => [...p]);
const el = (id: number, ...body: Bytes[]) => {
  const data = cat(...body);
  return cat(idBytes(id), sizeBytes(data.length), data);
};
const unknownEl = (id: number, ...body: Bytes[]) => cat(idBytes(id), sizeBytes(null), ...body);
const uint = (id: number, v: number) => el(id, v === 0 ? [0] : idBytes(v));
const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));
const block = (track: number, offset: number, payload: Bytes) =>
  cat([0x80 | track, (offset >> 8) & 0xff, offset & 0xff, 0x80], payload);

function syntheticMkv(): Uint8Array {
  const text = (s: string) => new TextEncoder().encode(s);
  const tracks = el(
    ID.Tracks,
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 1),
      uint(ID.TrackType, 1),
      str(ID.CodecID, 'V_MPEG4/ISO/AVC'),
    ),
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 2),
      uint(ID.TrackType, 0x11),
      str(ID.CodecID, 'S_TEXT/UTF8'),
      str(ID.Language, 'ger'),
      str(ID.Name, 'Deutsch (zlib)'),
      uint(ID.FlagForced, 1),
      el(
        ID.ContentEncodings,
        el(ID.ContentEncoding, el(ID.ContentCompression, uint(ID.ContentCompAlgo, 0))),
      ),
    ),
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 3),
      uint(ID.TrackType, 0x11),
      str(ID.CodecID, 'S_TEXT/SSA'),
      str(ID.LanguageBCP47, 'fr-CA'),
      str(ID.Language, 'fre'),
      uint(ID.FlagDefault, 0),
      el(
        ID.ContentEncodings,
        el(
          ID.ContentEncoding,
          el(
            ID.ContentCompression,
            uint(ID.ContentCompAlgo, 3),
            str(ID.ContentCompSettings, '0,0,'),
          ),
        ),
      ),
    ),
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 4),
      uint(ID.TrackType, 0x11),
      str(ID.CodecID, 'S_HDMV/PGS'),
    ),
  );
  const attachments = el(
    ID.Attachments,
    el(
      ID.AttachedFile,
      str(ID.FileName, 'Font.ttf'),
      str(ID.FileMimeType, 'font/ttf'),
      el(ID.FileData, new Uint8Array(3000).fill(7)),
    ),
  );
  const cluster1 = el(
    ID.Cluster,
    uint(ID.Timestamp, 1000),
    el(ID.SimpleBlock, block(1, 0, new Uint8Array(5000))), // Video: skipped by size.
    el(
      ID.BlockGroup,
      el(ID.Block, block(2, 500, deflateSync(text('Hallo <i>Welt</i>')))),
      uint(ID.BlockDuration, 1500),
    ),
    el(
      ID.BlockGroup,
      el(ID.Block, block(3, 200, text('Default,,0,0,0,,Bonjour{\\i1}, le\\Nmonde'))),
      uint(ID.BlockDuration, 800),
    ),
    el(ID.SimpleBlock, block(4, 0, [1, 2, 3])),
  );
  // Live-muxed: unknown size, ends where the next level-1 element starts.
  const cluster2 = unknownEl(
    ID.Cluster,
    uint(ID.Timestamp, 4000),
    el(ID.SimpleBlock, block(2, 0, deflateSync(text('Ohne Dauer')))),
  );
  const cluster3 = el(ID.Cluster, uint(ID.Timestamp, 9000), el(ID.SimpleBlock, block(1, 0, [0])));
  const segment = cat(
    el(ID.Info, uint(ID.TimestampScale, 1_000_000)),
    tracks,
    attachments,
    cluster1,
    cluster2,
    cluster3,
  );
  return new Uint8Array(cat(el(ID.EBML, str(0x4282, 'matroska')), unknownEl(ID.Segment, segment)));
}

describe('MKV reader on a synthetic file', () => {
  const bytes = syntheticMkv();

  it('reads track flags, BCP 47 language, encodings and marks PGS unsupported', async () => {
    const { source } = memorySource(bytes);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const [de, fr, pgs] = header.subtitleTracks;
    expect(de).toMatchObject({
      number: 2,
      language: 'ger',
      forced: true,
      isDefault: true,
      format: 'srt',
    });
    expect(de!.encodings).toEqual([{ kind: 'zlib' }]);
    expect(fr).toMatchObject({ number: 3, language: 'fr-CA', isDefault: false, format: 'ssa' });
    expect(pgs).toMatchObject({ number: 4, format: null });
    expect(header.cuesPosition).toBeNull();
    expect(header.attachmentsPosition).not.toBeNull();
  });

  it('reads the attached fonts for the ASS renderer', async () => {
    const { source } = memorySource(bytes);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const fonts = await readFontAttachments(source, header);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toHaveLength(3000);
    expect(fonts[0]!.every((b) => b === 7)).toBe(true);
  });

  it('lists attachments without reading their data', async () => {
    const { source, reads } = memorySource(bytes);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const before = reads.length;
    const [font] = await readAttachments(new ByteReader(source, 16), header);
    expect(font).toMatchObject({ name: 'Font.ttf', mimeType: 'font/ttf', size: 3000 });
    expect(await readRange(source, font!.dataStart, font!.dataStart + 3)).toEqual(
      new Uint8Array([7, 7, 7]),
    );
    const largest = Math.max(...reads.slice(before, -1).map(([s, e]) => e - s));
    expect(largest).toBeLessThan(3000);
  });

  it('decodes zlib and header-stripped blocks, BlockDuration and unknown-size clusters', async () => {
    const { cues, covered } = await scanAll(bytes);
    expect(covered).toBe(Infinity);
    expect(cues.get(2)).toEqual([
      { start: 1.5, end: 3, text: 'Hallo <i>Welt</i>' },
      { start: 4, end: 8, text: 'Ohne Dauer' }, // No duration: DEFAULT_CUE_SECONDS.
    ]);
    expect(cues.get(3)).toEqual([
      {
        start: 1.2,
        end: 2,
        text: 'Bonjour, le\nmonde',
        assChunk: '0,0,Default,,0,0,0,,Bonjour{\\i1}, le\\Nmonde',
      },
    ]);
    expect(cues.get(4)).toBeUndefined();
  });

  it('without Cues, starts at the first cluster', async () => {
    const { cues, covered } = await scanAll(bytes, 0, 2);
    expect(covered).toBe(4);
    // The cluster that ends the scan has been read too.
    expect(cues.get(2)).toHaveLength(2);
  });
});

describe('embedded selector entries', () => {
  const track = (t: Partial<MkvSubtitleTrack>): MkvSubtitleTrack => ({
    number: 3,
    codecId: 'S_TEXT/UTF8',
    format: 'srt',
    language: 'eng',
    name: '',
    isDefault: false,
    forced: false,
    codecPrivate: null,
    encodings: [],
    ...t,
  });

  it('uses the track name, else the format, and a normalised language', () => {
    expect(embeddedTrackInfo(track({}))).toEqual({
      key: 'embedded:3',
      kind: 'embedded',
      renderer: 'text',
      language: 'en',
      label: 'SRT',
      isDefault: false,
      forced: false,
    });
    expect(
      embeddedTrackInfo(track({ name: 'Signs', language: 'rus', forced: true })),
    ).toMatchObject({
      label: 'Signs',
      language: 'ru',
      forced: true,
    });
    expect(embeddedTrackInfo(track({ codecId: 'S_TEXT/ASS', format: 'ass' })).label).toBe('ASS');
  });

  it('lists bitmap tracks as unsupported', () => {
    expect(embeddedTrackInfo(track({ codecId: 'S_HDMV/PGS', format: null }))).toMatchObject({
      label: 'PGS',
      unsupported: true,
    });
  });

  it('marks ASS/SSA tracks for the styled renderer', () => {
    expect(embeddedTrackInfo(track({ codecId: 'S_TEXT/ASS', format: 'ass' })).renderer).toBe('ass');
    expect(embeddedTrackInfo(track({ codecId: 'S_TEXT/SSA', format: 'ssa' })).renderer).toBe('ass');
    expect(embeddedTrackInfo(track({ codecId: 'S_TEXT/WEBVTT', format: 'webvtt' })).renderer).toBe(
      'text',
    );
  });

  it('takes the ASS header from CodecPrivate, null when there is none', async () => {
    const { source } = memorySource(fixture);
    const header = (await readMkvHeader(new ByteReader(source)))!;
    const [srt, ass] = header.subtitleTracks;
    expect(assHeaderOf(srt!)).toBeNull();
    const text = assHeaderOf(ass!)!;
    expect(text).toMatch(/^\[Script Info\]/);
    expect(text).toContain('Style: Default,Arial,28');
    expect(text).toContain('[Events]');
    const enc = new TextEncoder();
    expect(assHeaderOf(track({ format: 'ass', codecPrivate: null }))).toBeNull();
    expect(assHeaderOf(track({ format: 'ass', codecPrivate: enc.encode('garbage') }))).toBeNull();
    expect(
      assHeaderOf(track({ format: 'srt', codecPrivate: enc.encode('[Script Info]\n') })),
    ).toBeNull();
  });

  it('recognises font attachments by MIME type or extension', () => {
    const att = (name: string, mimeType: string) => ({ name, mimeType });
    expect(isFontAttachment(att('a.bin', 'font/ttf'))).toBe(true);
    expect(isFontAttachment(att('a.bin', 'application/x-truetype-font'))).toBe(true);
    expect(isFontAttachment(att('a.bin', 'application/vnd.ms-opentype'))).toBe(true);
    expect(isFontAttachment(att('a.bin', 'application/font-sfnt'))).toBe(true);
    expect(isFontAttachment(att('a.bin', 'application/x-font-ttf'))).toBe(true);
    expect(isFontAttachment(att('Arial Bold.TTF', 'application/octet-stream'))).toBe(true);
    expect(isFontAttachment(att('a.otf', ''))).toBe(true);
    expect(isFontAttachment(att('cover.jpg', 'image/jpeg'))).toBe(false);
    expect(isFontAttachment(att('notes.txt', 'text/plain'))).toBe(false);
    expect(MAX_FONT_BYTES).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('takes the Text field of an ASS block', () => {
    expect(assBlockText('12,0,Default,,0,0,0,,Hi, there')).toBe('Hi, there');
    expect(assBlockText('broken')).toBe('broken');
  });
});
