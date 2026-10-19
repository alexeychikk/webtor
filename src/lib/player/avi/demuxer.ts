/**
 * `AviInputFormat` (ADR 0007 §1): an AVI demuxer plugged into Mediabunny 1.x through its internal,
 * duck-typed demuxer / track-backing interfaces (`_canReadInput`, `_createDemuxer`,
 * `getTrackBackings`, the `InputTrackBacking` methods). Mediabunny is pinned to an exact version
 * for this; `demuxer.test.ts` runs the fixtures through `Input` + `EncodedPacketSink` and fails when
 * an upgrade changes what we rely on.
 *
 * Reads go through our own `ByteSource` (a `BlockReader` cache), not Mediabunny's `Reader`.
 * Video: H.264 packets stay as stored (Annex B, or length-prefixed with an `avcC` in `strf`); DTS of
 * chunk `i` is `(i + dwStart) · dwScale / dwRate`, PTS comes from the POC rank in the GOP. Audio is
 * re-framed from the stream's bytes (`audio.ts`).
 */
import type { EncodedPacket, InputFormat } from 'mediabunny';
import { readRange } from '../../subtitles/mkv/reader';
import { PlaybackError } from '../errors';
import type { ByteSource } from '../types';
import {
  aacObjectType,
  adtsAudioSpecificConfig,
  audioLayout,
  type AudioFrame,
  type AudioLayout,
  type Framer,
} from './audio';
import { BlockReader } from './block-reader';
import { isH264FourCC } from './fourcc';
import {
  avcCodecString,
  gopPocs,
  gopPresentationRanks,
  nalUnits,
  parseFirstSlice,
  parsePpsIds,
  parseSps,
  type NalUnit,
  type SliceInfo,
  type Sps,
} from './h264';
import {
  AVIF_HASINDEX,
  isAvi,
  parseHdrl,
  parseIdx1,
  readFourCC,
  type AviStreamHeader,
  type ChunkTable,
} from './riff';

type Mediabunny = typeof import('mediabunny');

interface RetrievalOptions {
  metadataOnly?: boolean;
}

export const AVI_FORMAT_NAME = 'AVI';
const HEADER_READ = 64 * 1024;
const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const EPSILON = 1e-7;

/** The AVI input format for `new Input({ formats: [createAviFormat(mb, source), ...ALL_FORMATS] })`. */
export function createAviFormat(mb: Mediabunny, source: ByteSource): InputFormat {
  class AviInputFormat extends mb.InputFormat {
    get name() {
      return AVI_FORMAT_NAME;
    }
    get mimeType() {
      return 'video/x-msvideo';
    }
    /** Mediabunny internal: format detection. */
    async _canReadInput(): Promise<boolean> {
      if (source.size < 12) return false;
      return isAvi(await readRange(source, 0, 12));
    }
    /** Mediabunny internal: the demuxer for an input this format can read. */
    _createDemuxer(): AviDemuxer {
      return new AviDemuxer(mb, source);
    }
  }
  return new AviInputFormat();
}

/** Thrown (as a `PlaybackError`) for AVI layouts this demuxer doesn't read yet. */
function unsupportedAvi(detail: string): PlaybackError {
  return new PlaybackError('unsupported-container', detail);
}

/** Last index `i` in `[0, n)` with `key(i) <= t`, or -1. `key` must be non-decreasing. */
function lastAtOrBefore(n: number, key: (i: number) => number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) <= t + EPSILON) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export class AviDemuxer {
  private readonly abort = new AbortController();
  readonly reader: BlockReader;
  private backings: Promise<Array<AviVideoBacking | AviAudioBacking>> | null = null;

  constructor(
    readonly mb: Mediabunny,
    private readonly source: ByteSource,
  ) {
    this.reader = new BlockReader(source, this.abort.signal);
  }

  getTrackBackings(): Promise<Array<AviVideoBacking | AviAudioBacking>> {
    return (this.backings ??= this.init());
  }

  async getMimeType(): Promise<string> {
    return 'video/x-msvideo';
  }

  async getMetadataTags(): Promise<Record<string, never>> {
    return {};
  }

  dispose(): void {
    this.abort.abort();
  }

  private read(start: number, end: number): Promise<Uint8Array> {
    return readRange(this.source, start, Math.min(end, this.source.size), this.abort.signal);
  }

  private async init(): Promise<Array<AviVideoBacking | AviAudioBacking>> {
    const size = this.source.size;
    const head = await this.read(0, Math.min(HEADER_READ, size));
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (!isAvi(head)) throw unsupportedAvi('not an AVI file');
    const riffEnd = 8 + dv.getUint32(4, true);

    // Top-level chunks of the first RIFF: `LIST hdrl` … `LIST movi`, then `idx1`.
    let hdrl: ReturnType<typeof parseHdrl> | null = null;
    let moviPos = -1;
    let moviEnd = -1;
    let o = 12;
    while (o + 12 <= Math.min(riffEnd, size)) {
      const h = o + 12 <= head.length ? head.subarray(o, o + 12) : await this.read(o, o + 12);
      const id = readFourCC(h, 0);
      const chunkSize = new DataView(h.buffer, h.byteOffset, 12).getUint32(4, true);
      const list = readFourCC(h, 8);
      if (id === 'LIST' && list === 'hdrl') {
        const end = o + 8 + chunkSize;
        const bytes = end <= head.length ? head : await this.read(0, end);
        hdrl = parseHdrl(bytes, o + 12, end);
      } else if (id === 'LIST' && list === 'movi') {
        moviPos = o + 8;
        moviEnd = o + 8 + chunkSize;
        break;
      }
      o += 8 + chunkSize + (chunkSize & 1);
    }
    if (!hdrl) throw unsupportedAvi('AVI without a header');
    if (moviPos < 0) throw unsupportedAvi('AVI without movie data');
    if (riffEnd + 12 <= size) {
      const next = await this.read(riffEnd, riffEnd + 12);
      if (readFourCC(next, 0) === 'RIFF' && readFourCC(next, 8) === 'AVIX') {
        throw unsupportedAvi('OpenDML AVI over 1 GB, not supported yet');
      }
    }

    // idx1 follows movi (maybe after other chunks).
    let tables: ChunkTable[] | null = null;
    if (hdrl.main.flags & AVIF_HASINDEX) {
      let p = moviEnd + (moviEnd & 1);
      while (p + 8 <= Math.min(riffEnd, size)) {
        const h = await this.read(p, p + 8);
        const chunkSize = new DataView(h.buffer, h.byteOffset, 8).getUint32(4, true);
        if (readFourCC(h, 0) === 'idx1') {
          const idx = await this.read(p + 8, p + 8 + chunkSize);
          tables = parseIdx1(
            idx,
            hdrl.streams.length,
            moviPos,
            await this.idx1IsAbsolute(idx, moviPos),
          );
          break;
        }
        p += 8 + chunkSize + (chunkSize & 1);
      }
    }
    if (!tables || tables.every((t) => t.sizes.length === 0)) {
      throw unsupportedAvi('AVI without an index, not supported yet');
    }

    const backings: Array<AviVideoBacking | AviAudioBacking> = [];
    hdrl.streams.forEach((s, i) => {
      const table = tables[i];
      if (!table || table.sizes.length === 0) return;
      if (s.type === 'vids' && s.video) backings.push(new AviVideoBacking(this, s, table));
      else if (s.type === 'auds' && s.audio) backings.push(new AviAudioBacking(this, s, table));
    });
    return backings;
  }

  /** `idx1` offsets point at chunk headers, relative to the `movi` FourCC or absolute: check one. */
  private async idx1IsAbsolute(idx: Uint8Array, moviPos: number): Promise<boolean> {
    if (idx.length < 16) return false;
    const dv = new DataView(idx.buffer, idx.byteOffset, 16);
    const offset = dv.getUint32(8, true);
    if (offset <= moviPos) return false;
    const id = readFourCC(idx, 0);
    const at = await this.read(offset, offset + 4).catch(() => new Uint8Array(0));
    return at.length === 4 && readFourCC(at, 0) === id;
  }
}

/** The `InputTrackBacking` methods shared by both track kinds. */
abstract class AviBacking {
  constructor(
    protected readonly demuxer: AviDemuxer,
    protected readonly stream: AviStreamHeader,
    protected readonly table: ChunkTable,
  ) {}
  getId() {
    return this.stream.index + 1;
  }
  getNumber() {
    return this.stream.index + 1;
  }
  getName() {
    return this.stream.name;
  }
  getLanguageCode() {
    return 'und';
  }
  isRelativeToUnixEpoch() {
    return false;
  }
  getUnixTimeForTimestamp() {
    return null;
  }
  getDisposition() {
    return {
      default: true,
      primary: true,
      forced: false,
      original: false,
      commentary: false,
      hearingImpaired: false,
      visuallyImpaired: false,
    };
  }
  getPairingMask() {
    return 1n;
  }
  getBitrate() {
    return null;
  }
  getAverageBitrate() {
    return null;
  }
  async getLiveRefreshInterval() {
    return null;
  }
  protected get mb() {
    return this.demuxer.mb;
  }
  protected readChunk(i: number, from = 0, to = Infinity): Promise<Uint8Array> {
    const start = this.table.offsets[i]!;
    const size = this.table.sizes[i]!;
    return this.demuxer.reader.read(start + from, start + Math.min(size, to));
  }
}

/** Video stream: one packet per non-empty chunk (empty chunks are dropped frames). */
export class AviVideoBacking extends AviBacking {
  /** Chunk index of each packet. */
  private readonly packetChunk: Uint32Array;
  /** Packet index of each GOP's first packet (key frames, plus packet 0). */
  private readonly gopStarts: Uint32Array;
  /** PTS of each packet once its GOP is analysed (NaN before). */
  private readonly pts: Float64Array;
  private readonly gopJobs = new Map<number, Promise<void>>();
  private readonly frameDuration: number;
  readonly fourcc: string;
  private readonly isAvc: boolean;
  /** 0 = Annex B; else the NAL length size of an `avcC` in `strf`. */
  private readonly lengthSize: number;
  private readonly spsById = new Map<number, Sps>();
  private readonly ppsToSps = new Map<number, number>();
  private configPromise: Promise<VideoDecoderConfig | null> | null = null;

  constructor(demuxer: AviDemuxer, stream: AviStreamHeader, table: ChunkTable) {
    super(demuxer, stream, table);
    const video = stream.video!;
    const handler = stream.handler.replace(/\0/g, '').trim();
    const compression = video.compression.replace(/\0/g, '').trim();
    this.isAvc = isH264FourCC(handler) || isH264FourCC(compression);
    this.fourcc =
      (this.isAvc && !isH264FourCC(handler) ? compression : handler || compression) || '';
    this.frameDuration = stream.rate > 0 && stream.scale > 0 ? stream.scale / stream.rate : 1 / 25;
    const extra = video.extra;
    this.lengthSize = extra[0] === 1 && extra.length >= 7 ? (extra[4]! & 3) + 1 : 0;
    if (this.isAvc) this.learnParameterSets(this.extradataNals());

    const n = table.sizes.length;
    let count = 0;
    for (let i = 0; i < n; i++) if (table.sizes[i]! > 0) count++;
    this.packetChunk = new Uint32Array(count);
    const starts: number[] = [];
    for (let i = 0, p = 0; i < n; i++) {
      if (table.sizes[i] === 0) continue;
      if (p === 0 || table.keys[i]) starts.push(p);
      this.packetChunk[p++] = i;
    }
    this.gopStarts = Uint32Array.from(starts);
    this.pts = new Float64Array(count).fill(NaN);
  }

  getType() {
    return 'video' as const;
  }
  getCodec() {
    return this.isAvc ? ('avc' as const) : null;
  }
  /** The FourCC (`strh.fccHandler`, else `biCompression`), e.g. `XVID`. */
  getInternalCodecId() {
    return this.fourcc;
  }
  getTimeResolution() {
    return 1 / this.frameDuration;
  }
  getCodedWidth() {
    return this.stream.video!.width;
  }
  getCodedHeight() {
    return this.stream.video!.height;
  }
  getSquarePixelWidth() {
    return this.stream.video!.width;
  }
  getSquarePixelHeight() {
    return this.stream.video!.height;
  }
  getTransformationMatrix() {
    return [...IDENTITY_MATRIX];
  }
  async getColorSpace() {
    return {};
  }
  async canBeTransparent() {
    return false;
  }
  getHasOnlyKeyPackets() {
    return this.gopStarts.length === this.packetChunk.length;
  }
  async getDurationFromMetadata() {
    const slots = Math.max(this.table.sizes.length, this.stream.length);
    return (slots + this.stream.start) * this.frameDuration;
  }

  /**
   * `{codec: 'avc1.PPCCLL', codedWidth, codedHeight}`, no `description` for Annex B: Mediabunny's
   * MP4 muxer builds `avcC` from the first key packet. The SPS comes from `strf` or that packet.
   */
  getDecoderConfig(): Promise<VideoDecoderConfig | null> {
    return (this.configPromise ??= (async () => {
      if (!this.isAvc) return null;
      let sps = this.firstSpsNal();
      if (!sps && this.packetChunk.length > 0) {
        this.learnParameterSets(
          nalUnits(await this.readChunk(this.packetChunk[0]!), this.lengthSize),
        );
        sps = this.firstSpsNal();
      }
      if (!sps) return null;
      const config: VideoDecoderConfig = {
        codec: avcCodecString(sps),
        codedWidth: this.stream.video!.width,
        codedHeight: this.stream.video!.height,
      };
      if (this.lengthSize) config.description = this.stream.video!.extra;
      return config;
    })());
  }

  async getFirstPacket(options: RetrievalOptions) {
    return this.packetAt(0, options);
  }
  async getNextPacket(packet: EncodedPacket, options: RetrievalOptions) {
    return this.packetAt(packet.sequenceNumber + 1, options);
  }
  /** Key frames are GOP starts, so their PTS is their DTS: found from the index alone. */
  async getKeyPacket(timestamp: number, options: RetrievalOptions) {
    const g = lastAtOrBefore(this.gopStarts.length, (i) => this.dts(this.gopStarts[i]!), timestamp);
    if (g < 0) return null;
    // Packet 0 starts a GOP even when it isn't flagged key; skip it then.
    let p = this.gopStarts[g]!;
    if (!this.isKey(p)) {
      const next = this.gopStarts[g + 1];
      if (next === undefined || this.dts(next) > timestamp + EPSILON) return null;
      p = next;
    }
    return this.packetAt(p, options);
  }
  async getNextKeyPacket(packet: EncodedPacket, options: RetrievalOptions) {
    for (let g = 0; g < this.gopStarts.length; g++) {
      const p = this.gopStarts[g]!;
      if (p > packet.sequenceNumber && this.isKey(p)) return this.packetAt(p, options);
    }
    return null;
  }
  /** Last packet in presentation order with PTS ≤ `timestamp`. */
  async getPacket(timestamp: number, options: RetrievalOptions) {
    const g = lastAtOrBefore(this.gopStarts.length, (i) => this.dts(this.gopStarts[i]!), timestamp);
    if (g < 0) return null;
    await this.analyseGop(g);
    const [from, to] = this.gopRange(g);
    let best = -1;
    for (let p = from; p < to; p++) {
      const pts = this.pts[p]!;
      if (pts <= timestamp + EPSILON && (best < 0 || pts > this.pts[best]!)) best = p;
    }
    return best < 0 ? null : this.packetAt(best, options);
  }

  private isKey(p: number): boolean {
    return this.table.keys[this.packetChunk[p]!] === 1;
  }
  private dts(p: number): number {
    return (this.packetChunk[p]! + this.stream.start) * this.frameDuration;
  }
  private gopRange(g: number): [number, number] {
    return [this.gopStarts[g]!, this.gopStarts[g + 1] ?? this.packetChunk.length];
  }
  private gopOf(p: number): number {
    return lastAtOrBefore(this.gopStarts.length, (i) => this.gopStarts[i]!, p);
  }

  private async packetAt(p: number, _options: RetrievalOptions): Promise<EncodedPacket | null> {
    if (p < 0 || p >= this.packetChunk.length) return null;
    const g = this.gopOf(p);
    // A GOP's first packet has rank 0: PTS = DTS without reading the GOP.
    if (p === this.gopStarts[g]) this.pts[p] = this.dts(p);
    else await this.analyseGop(g);
    // Mediabunny's metadata-only placeholder is internal; always return the data.
    const data = await this.readChunk(this.packetChunk[p]!);
    return new this.mb.EncodedPacket(
      data,
      this.isKey(p) ? 'key' : 'delta',
      this.pts[p]!,
      this.frameDuration,
      p,
    );
  }

  /** Reads GOP `g`'s packets and sets their PTS from the POC rank (POC type 0), else PTS = DTS. */
  private analyseGop(g: number): Promise<void> {
    const [from, to] = this.gopRange(g);
    if (!Number.isNaN(this.pts[to - 1]!)) return Promise.resolve();
    let job = this.gopJobs.get(g);
    if (!job) {
      job = this.computeGop(from, to).finally(() => this.gopJobs.delete(g));
      this.gopJobs.set(g, job);
    }
    return job;
  }

  private async computeGop(from: number, to: number) {
    const base = this.dts(from);
    const set = (ranks: (i: number) => number) => {
      for (let p = from; p < to; p++) this.pts[p] = base + ranks(p - from) * this.frameDuration;
    };
    if (!this.isAvc) return set((i) => i);
    const slices: Array<SliceInfo | null> = [];
    let pocType = -1;
    let log2MaxPocLsb = 4;
    for (let p = from; p < to; p++) {
      const nals = nalUnits(await this.readChunk(this.packetChunk[p]!), this.lengthSize);
      this.learnParameterSets(nals);
      let slice: SliceInfo | null = null;
      try {
        slice = parseFirstSlice(nals, (ppsId) => {
          const sps = this.spsById.get(this.ppsToSps.get(ppsId) ?? 0);
          if (sps && pocType < 0) {
            pocType = sps.pocType;
            log2MaxPocLsb = sps.log2MaxPocLsb;
          }
          return sps;
        });
      } catch {
        slice = null;
      }
      slices.push(slice);
    }
    // POC type 2: output order = decode order. Type 1 (rare in AVI): not modelled, same.
    if (pocType !== 0) return set((i) => i);
    const ranks = gopPresentationRanks(gopPocs(slices, log2MaxPocLsb));
    set((i) => ranks[i]!);
  }

  private extradataNals(): NalUnit[] {
    const extra = this.stream.video!.extra;
    if (extra.length === 0) return [];
    if (!this.lengthSize) return nalUnits(extra);
    // avcC: version, profile, compat, level, lengthSize, numSps + (len, sps)…, numPps + (len, pps)…
    const out: NalUnit[] = [];
    let o = 5;
    for (const countMask of [0x1f, 0xff]) {
      const count = (extra[o++] ?? 0) & countMask;
      for (let i = 0; i < count && o + 2 <= extra.length; i++) {
        const len = (extra[o]! << 8) | extra[o + 1]!;
        out.push(...nalUnits(extra.subarray(o, o + 2 + len), 2));
        o += 2 + len;
      }
    }
    return out;
  }

  private spsNals = new Map<number, Uint8Array>();
  private firstSpsNal(): Uint8Array | null {
    return this.spsNals.values().next().value ?? null;
  }

  private learnParameterSets(nals: readonly NalUnit[]) {
    for (const nal of nals) {
      try {
        if (nal.type === 7) {
          const sps = parseSps(nal.data);
          this.spsById.set(sps.id, sps);
          if (!this.spsNals.has(sps.id)) this.spsNals.set(sps.id, nal.data.slice());
        } else if (nal.type === 8) {
          const { id, spsId } = parsePpsIds(nal.data);
          this.ppsToSps.set(id, spsId);
        }
      } catch {
        // A damaged parameter set: keep the ones we have.
      }
    }
  }
}

/** Position of a frame in an audio stream: byte offset in the stream and samples before it. */
interface FramePos {
  pos: number;
  samples: number;
}

/**
 * Audio stream, re-framed: the chunks' bytes form one stream (empty chunks contribute nothing), cut
 * into codec frames. A packet's `sequenceNumber` is its byte position in that stream, so the next
 * packet is found from the packet alone.
 */
export class AviAudioBacking extends AviBacking {
  private readonly layout: AudioLayout;
  /** Stream position of each chunk's first byte; `cum[n]` = stream length. */
  private readonly cum: Float64Array;
  /** Chunk index of each non-empty chunk (VBR: one frame each, which times seeks). */
  private readonly nonEmpty: Uint32Array;
  private readonly sampleRate: number;
  private adtsConfig: Promise<Uint8Array | null> | null = null;

  constructor(demuxer: AviDemuxer, stream: AviStreamHeader, table: ChunkTable) {
    super(demuxer, stream, table);
    this.layout = audioLayout(stream.audio!);
    this.sampleRate = stream.audio!.sampleRate || 48_000;
    const n = table.sizes.length;
    this.cum = new Float64Array(n + 1);
    const nonEmpty: number[] = [];
    for (let i = 0; i < n; i++) {
      this.cum[i + 1] = this.cum[i]! + table.sizes[i]!;
      if (table.sizes[i]! > 0) nonEmpty.push(i);
    }
    this.nonEmpty = Uint32Array.from(nonEmpty);
  }

  getType() {
    return 'audio' as const;
  }
  getCodec() {
    return this.layout.kind === 'unsupported' ? null : this.layout.codec;
  }
  getInternalCodecId() {
    return this.stream.audio!.formatTag;
  }
  getNumberOfChannels() {
    return this.stream.audio!.channels;
  }
  getSampleRate() {
    return this.sampleRate;
  }
  getTimeResolution() {
    return this.sampleRate;
  }
  async getDurationFromMetadata() {
    const wf = this.stream.audio!;
    const total = this.cum[this.cum.length - 1]!;
    if (this.stream.sampleSize === 0 && this.stream.rate > 0) {
      return (this.nonEmpty.length * this.stream.scale) / this.stream.rate;
    }
    return wf.avgBytesPerSec > 0 ? total / wf.avgBytesPerSec : null;
  }

  async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
    const layout = this.layout;
    if (layout.kind === 'unsupported') return null;
    const base = { numberOfChannels: this.getNumberOfChannels(), sampleRate: this.sampleRate };
    if (layout.codec === 'aac') {
      const description = layout.kind === 'chunks' ? layout.description : await this.adtsAsc();
      if (!description) return null;
      return { ...base, codec: `mp4a.40.${aacObjectType(description)}`, description };
    }
    const codec = { mp3: 'mp3', ac3: 'ac-3', dts: 'dtsc' }[layout.codec as string] ?? layout.codec;
    return { ...base, codec };
  }

  private adtsAsc(): Promise<Uint8Array | null> {
    return (this.adtsConfig ??= this.resync(0).then(async (f) =>
      f ? adtsAudioSpecificConfig(await this.readStream(f.pos, 7)) : null,
    ));
  }

  async getFirstPacket(options: RetrievalOptions) {
    if (this.layout.kind === 'chunks') return this.chunkPacket(0, options);
    const f = await this.resync(0);
    return f ? this.framePacket({ pos: f.pos, samples: 0 }, f.frame) : null;
  }

  async getNextPacket(packet: EncodedPacket, options: RetrievalOptions) {
    if (this.layout.kind === 'chunks') return this.chunkPacket(packet.sequenceNumber + 1, options);
    const pos = packet.sequenceNumber;
    const frame = await this.frameAt(pos);
    if (!frame) return null;
    const samples = Math.round(packet.timestamp * this.sampleRate) + frame.samples;
    const next = await this.resync(pos + frame.size);
    return next ? this.framePacket({ pos: next.pos, samples }, next.frame) : null;
  }

  /** Every audio packet is a key packet. */
  getKeyPacket(timestamp: number, options: RetrievalOptions) {
    return this.getPacket(timestamp, options);
  }
  getNextKeyPacket(packet: EncodedPacket, options: RetrievalOptions) {
    return this.getNextPacket(packet, options);
  }

  /** Last packet with timestamp ≤ `timestamp`: jump near it by the index, then walk frames. */
  async getPacket(timestamp: number, options: RetrievalOptions) {
    if (timestamp < 0) return null;
    const { scale, rate, sampleSize } = this.stream;
    if (this.layout.kind === 'chunks') {
      const per = this.layout.samplesPerChunk / this.sampleRate;
      const k = Math.min(Math.floor(timestamp / per + EPSILON), this.nonEmpty.length - 1);
      return k < 0 ? null : this.chunkPacket(k, options);
    }
    let anchor: FramePos;
    if (sampleSize === 0 && rate > 0 && scale > 0) {
      // VBR: one frame per non-empty chunk, each dwScale / dwRate long.
      const k = Math.max(
        0,
        Math.min(Math.floor((timestamp * rate) / scale + EPSILON), this.nonEmpty.length - 1),
      );
      anchor = {
        pos: this.cum[this.nonEmpty[k]!]!,
        samples: Math.round(((k * scale) / rate) * this.sampleRate),
      };
    } else {
      // CBR: by byte position, a little early so the walk below lands on the frame.
      const avg = this.stream.audio!.avgBytesPerSec || 1;
      const framer = this.framer;
      const frameBytes = framer.headerSize === 0 ? framer.parse(new Uint8Array(0), 0)!.size : 0;
      let pos = Math.max(0, Math.floor(timestamp * avg) - (frameBytes ? 0 : 4096));
      if (frameBytes) pos -= pos % frameBytes;
      pos = Math.min(pos, Math.max(0, this.streamLength - 1));
      anchor = { pos, samples: Math.round((pos / avg) * this.sampleRate) };
    }
    const first = await this.resync(anchor.pos);
    if (!first) return null;
    let cur: FramePos = { pos: first.pos, samples: anchor.samples };
    let frame = first.frame;
    // Walk forward while the next frame still starts at or before `timestamp`.
    for (let i = 0; i < 64; i++) {
      const nextSamples = cur.samples + frame.samples;
      if (nextSamples / this.sampleRate > timestamp + EPSILON) break;
      const next = await this.resync(cur.pos + frame.size);
      if (!next) break;
      cur = { pos: next.pos, samples: nextSamples };
      frame = next.frame;
    }
    return this.framePacket(cur, frame);
  }

  private get streamLength(): number {
    return this.cum[this.cum.length - 1]!;
  }

  private get framer(): Framer {
    if (this.layout.kind !== 'framed') throw new Error('not a framed audio stream');
    return this.layout.framer;
  }

  /** Up to `length` bytes of the audio stream at `pos`, read across chunks. */
  private async readStream(pos: number, length: number): Promise<Uint8Array> {
    const end = Math.min(pos + length, this.streamLength);
    if (end <= pos) return new Uint8Array(0);
    let c = lastAtOrBefore(this.table.sizes.length, (i) => this.cum[i]!, pos);
    const parts: Uint8Array[] = [];
    let p = pos;
    while (p < end && c < this.table.sizes.length) {
      const chunkEnd = this.cum[c + 1]!;
      if (chunkEnd > p) {
        const to = Math.min(end, chunkEnd);
        parts.push(await this.readChunk(c, p - this.cum[c]!, to - this.cum[c]!));
        p = to;
      }
      c++;
    }
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of parts) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  }

  /** The frame at stream position `pos` (null if there's none), clipped at the stream end. */
  private async frameAt(pos: number): Promise<AudioFrame | null> {
    const framer = this.framer;
    const head = framer.headerSize
      ? await this.readStream(pos, framer.headerSize)
      : new Uint8Array(0);
    const frame = framer.parse(head, 0);
    if (!frame || pos >= this.streamLength) return null;
    return this.clip(pos, frame);
  }

  /** A frame past the stream end: PCM keeps what is there, a compressed frame is incomplete. */
  private clip(pos: number, frame: AudioFrame): AudioFrame | null {
    const left = this.streamLength - pos;
    if (frame.size <= left) return frame;
    if (this.framer.headerSize !== 0) return null;
    return { size: left, samples: Math.floor((frame.samples * left) / frame.size) };
  }

  /**
   * The first frame at or after `pos`: a valid header followed by another one (or the stream end),
   * so a stray sync word inside frame data isn't taken for a frame.
   */
  private async resync(pos: number): Promise<{ pos: number; frame: AudioFrame } | null> {
    const framer = this.framer;
    if (framer.headerSize === 0) {
      const frame =
        pos < this.streamLength ? this.clip(pos, framer.parse(new Uint8Array(0), 0)!) : null;
      return frame && frame.size > 0 ? { pos, frame } : null;
    }
    const WINDOW = 16 * 1024;
    for (let start = pos; start < this.streamLength && start < pos + 256 * 1024; start += WINDOW) {
      const b = await this.readStream(start, WINDOW + 8 * 1024);
      for (let i = 0; i < Math.min(WINDOW, b.length); i++) {
        const frame = framer.parse(b, i);
        if (!frame) continue;
        const at = start + i;
        const nextAt = at + frame.size;
        if (nextAt > this.streamLength) continue;
        if (nextAt < this.streamLength) {
          const rel = nextAt - start;
          const nextHead =
            rel + framer.headerSize <= b.length
              ? b
              : await this.readStream(nextAt, framer.headerSize);
          if (!framer.parse(nextHead, nextHead === b ? rel : 0)) continue;
        }
        return { pos: at, frame };
      }
    }
    return null;
  }

  private async framePacket(at: FramePos, frame: AudioFrame): Promise<EncodedPacket> {
    let data = await this.readStream(at.pos, frame.size);
    if (frame.skip) data = data.subarray(frame.skip);
    return new this.mb.EncodedPacket(
      data,
      'key',
      at.samples / this.sampleRate,
      frame.samples / this.sampleRate,
      at.pos,
    );
  }

  private async chunkPacket(k: number, _options: RetrievalOptions): Promise<EncodedPacket | null> {
    if (this.layout.kind !== 'chunks' || k < 0 || k >= this.nonEmpty.length) return null;
    const per = this.layout.samplesPerChunk / this.sampleRate;
    const data = await this.readChunk(this.nonEmpty[k]!);
    return new this.mb.EncodedPacket(data, 'key', k * per, per, k);
  }
}
