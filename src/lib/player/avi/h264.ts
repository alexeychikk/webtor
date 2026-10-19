/**
 * Just enough H.264 parsing for AVI (ADR 0007 §1): NAL units of a packet, the SPS fields that the
 * picture order count needs, the slice header up to `pic_order_cnt_lsb`, and the codec string.
 * AVI has no presentation timestamps; `gopPresentationRanks` rebuilds the order from the POC.
 */

export interface NalUnit {
  type: number;
  refIdc: number;
  /** The NAL unit including its 1-byte header, emulation prevention bytes still in. */
  data: Uint8Array;
}

/**
 * NAL units of an Annex B packet (`lengthSize` 0) or of a length-prefixed one (`lengthSize` 1–4,
 * from `avcC`).
 */
export function nalUnits(packet: Uint8Array, lengthSize = 0): NalUnit[] {
  const out: NalUnit[] = [];
  const push = (data: Uint8Array) => {
    if (data.length === 0) return;
    const h = data[0]!;
    out.push({ type: h & 0x1f, refIdc: (h >> 5) & 3, data });
  };
  if (lengthSize > 0) {
    let o = 0;
    while (o + lengthSize <= packet.length) {
      let len = 0;
      for (let i = 0; i < lengthSize; i++) len = len * 256 + packet[o + i]!;
      o += lengthSize;
      push(packet.subarray(o, Math.min(o + len, packet.length)));
      o += len;
    }
    return out;
  }
  // Annex B: split on 00 00 01 (a leading 00 of 00 00 00 01 is trailing zero of the previous unit).
  let start = -1;
  const n = packet.length;
  for (let i = 0; i + 2 < n; i++) {
    if (packet[i] === 0 && packet[i + 1] === 0 && packet[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && packet[end - 1] === 0) end--;
        push(packet.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0) push(packet.subarray(start, n));
  return out;
}

/** RBSP of a NAL unit payload: drops the header byte and the emulation prevention bytes. */
export function rbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    zeros = b === 0 ? zeros + 1 : 0;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

class BitReader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  bit(): number {
    const byte = this.b[this.pos >> 3];
    if (byte === undefined) throw new RangeError('end of RBSP');
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > 31) throw new RangeError('bad exp-Golomb code');
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

export interface Sps {
  id: number;
  profile: number;
  constraints: number;
  level: number;
  separateColourPlane: boolean;
  log2MaxFrameNum: number;
  pocType: number;
  log2MaxPocLsb: number;
  frameMbsOnly: boolean;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Parses a sequence parameter set NAL unit (header byte included). */
export function parseSps(nal: Uint8Array): Sps {
  const r = new BitReader(rbsp(nal));
  const profile = r.bits(8);
  const constraints = r.bits(8);
  const level = r.bits(8);
  const id = r.ue();
  let separateColourPlane = false;
  if (HIGH_PROFILES.has(profile)) {
    const chroma = r.ue();
    if (chroma === 3) separateColourPlane = r.bit() === 1;
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const lists = chroma === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const pocType = r.ue();
  let log2MaxPocLsb = 0;
  if (pocType === 0) {
    log2MaxPocLsb = r.ue() + 4;
  } else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  const frameMbsOnly = r.bit() === 1;
  return {
    id,
    profile,
    constraints,
    level,
    separateColourPlane,
    log2MaxFrameNum,
    pocType,
    log2MaxPocLsb,
    frameMbsOnly,
  };
}

/** `pic_parameter_set_id` → `seq_parameter_set_id` of a PPS NAL unit. */
export function parsePpsIds(nal: Uint8Array): { id: number; spsId: number } {
  const r = new BitReader(rbsp(nal));
  return { id: r.ue(), spsId: r.ue() };
}

/** RFC 6381 `avc1.PPCCLL` from an SPS NAL unit (bytes 1–3). */
export function avcCodecString(sps: Uint8Array): string {
  const hex = (b: number | undefined) => (b ?? 0).toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

export interface SliceInfo {
  idr: boolean;
  refIdc: number;
  /** `pic_order_cnt_lsb` (POC type 0), else 0. */
  pocLsb: number;
}

/**
 * Parses the first slice of a coded picture up to `pic_order_cnt_lsb`. `sps` resolves the SPS of
 * the slice's PPS. Returns null if the packet holds no slice.
 */
export function parseFirstSlice(
  nals: readonly NalUnit[],
  sps: (ppsId: number) => Sps | undefined,
): SliceInfo | null {
  const nal = nals.find((n) => n.type === 1 || n.type === 5);
  if (!nal) return null;
  // The slice header is short: a few dozen bytes of RBSP are plenty.
  const r = new BitReader(rbsp(nal.data.subarray(0, 64)));
  r.ue(); // first_mb_in_slice
  r.ue(); // slice_type
  const s = sps(r.ue());
  if (!s) return null;
  if (s.separateColourPlane) r.bits(2);
  r.bits(s.log2MaxFrameNum);
  if (!s.frameMbsOnly && r.bit()) r.bit(); // field_pic_flag, bottom_field_flag
  const idr = nal.type === 5;
  if (idr) r.ue(); // idr_pic_id
  const pocLsb = s.pocType === 0 ? r.bits(s.log2MaxPocLsb) : 0;
  return { idr, refIdc: nal.refIdc, pocLsb };
}

/**
 * Picture order counts (POC type 0, H.264 8.2.1.1) of one GOP's pictures in decode order. The GOP
 * starts at an IDR (POC state reset) or at another key frame (its own LSB starts the count).
 * `null` entries (no parsable slice) stay null.
 */
export function gopPocs(
  slices: ReadonlyArray<SliceInfo | null>,
  log2MaxPocLsb: number,
): Array<number | null> {
  const max = 2 ** log2MaxPocLsb;
  let prevMsb = 0;
  let prevLsb = slices[0]?.idr ? 0 : (slices[0]?.pocLsb ?? 0);
  return slices.map((s) => {
    if (!s) return null;
    if (s.idr) {
      prevMsb = 0;
      prevLsb = 0;
    }
    let msb = prevMsb;
    if (s.pocLsb < prevLsb && prevLsb - s.pocLsb >= max / 2) msb = prevMsb + max;
    else if (s.pocLsb > prevLsb && s.pocLsb - prevLsb > max / 2) msb = prevMsb - max;
    if (s.refIdc !== 0) {
      prevMsb = msb;
      prevLsb = s.pocLsb;
    }
    return msb + s.pocLsb;
  });
}

/**
 * Presentation slot of each picture relative to the GOP's first (key) picture: its POC rank minus
 * the key's rank. Pictures without a POC keep their decode position.
 */
export function gopPresentationRanks(pocs: ReadonlyArray<number | null>): number[] {
  const known = pocs
    .map((poc, i) => ({ poc, i }))
    .filter((x): x is { poc: number; i: number } => x.poc !== null)
    .sort((a, b) => a.poc - b.poc || a.i - b.i);
  const rank = pocs.map((_, i) => i);
  // Known POCs fill the decode positions they occupy, in POC order.
  const slots = known.map((x) => x.i).sort((a, b) => a - b);
  known.forEach((x, k) => (rank[x.i] = slots[k]!));
  const keyRank = rank[0] ?? 0;
  return rank.map((r) => r - keyRank);
}

/**
 * Key frame test for a chunk without an index flag (the `movi` scan): an IDR slice, or a non-IDR
 * slice of type I (an open-GOP key frame, which muxers flag as key in `idx1` too).
 */
export function isH264KeyFrame(nals: readonly NalUnit[]): boolean {
  const nal = nals.find((n) => n.type === 1 || n.type === 5);
  if (!nal) return false;
  if (nal.type === 5) return true;
  try {
    const r = new BitReader(rbsp(nal.data.subarray(0, 16)));
    r.ue(); // first_mb_in_slice
    return r.ue() % 5 === 2; // slice_type I
  } catch {
    return false;
  }
}

/**
 * Key frame test for an MPEG-4 Part 2 (DivX/Xvid) chunk: its first VOP is an I-VOP. Null when the
 * chunk holds no VOP start code (another codec).
 */
export function isMpeg4KeyFrame(chunk: Uint8Array): boolean | null {
  for (let i = 0; i + 4 < chunk.length; i++) {
    if (chunk[i] === 0 && chunk[i + 1] === 0 && chunk[i + 2] === 1 && chunk[i + 3] === 0xb6) {
      return chunk[i + 4]! >> 6 === 0;
    }
  }
  return null;
}
