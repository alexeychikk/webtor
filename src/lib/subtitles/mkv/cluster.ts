/**
 * Cluster walk for subtitle blocks (docs/decisions/0004): reads element headers and the track number
 * of each SimpleBlock / Block, reads only the blocks of the wanted tracks and skips the rest by size.
 */
import { ID, TOP_LEVEL_IDS, readUint, readVint } from './ebml';
import type { ByteReader } from './reader';

export interface MkvBlock {
  track: number;
  /** Absolute timestamp in TimestampScale units (Cluster timestamp + the block's int16 offset). */
  timestamp: number;
  /** `BlockDuration` in TimestampScale units, `null` when the block has none. */
  duration: number | null;
  /** Frame data (still encoded per the track's `ContentEncodings`). */
  data: Uint8Array;
}

export interface MkvCluster {
  /** File offset of the Cluster element. */
  start: number;
  /** File offset right after it (the next level-1 element). */
  end: number;
  /** Cluster timestamp in TimestampScale units. */
  timestamp: number;
  blocks: MkvBlock[];
}

/** Track number, relative timestamp and frame data of a (Simple)Block body; `null` if laced. */
function parseBlock(body: Uint8Array): { track: number; offset: number; data: Uint8Array } | null {
  const track = readVint(body, 0);
  if (!track || body.length < track.length + 3) return null;
  const view = new DataView(body.buffer, body.byteOffset + track.length, 3);
  const offset = view.getInt16(0);
  const flags = view.getUint8(2);
  if (flags & 0x06) return null; // Lacing: never used for subtitles.
  return { track: track.value, offset, data: body.subarray(track.length + 3) };
}

/** Bytes needed to see a block's track number (vint ≤ 8 bytes). */
const BLOCK_HEAD = 8;

/**
 * Reads the Cluster at `pos` and returns the blocks of the tracks in `wanted`; `limit` is the end
 * of the Segment. Returns `null` if `pos` isn't a Cluster.
 */
export async function readCluster(
  reader: ByteReader,
  pos: number,
  wanted: ReadonlySet<number>,
  limit: number,
): Promise<MkvCluster | null> {
  const h = await reader.header(pos);
  if (!h || h.id !== ID.Cluster) return null;
  const known = h.size !== null;
  let end = known ? Math.min(h.dataStart + h.size!, limit) : limit;
  let timestamp = 0;
  const blocks: MkvBlock[] = [];

  const readBlock = async (start: number, size: number, duration: number | null) => {
    const head = parseBlock(await reader.bytes(start, Math.min(size, BLOCK_HEAD)));
    if (!head || !wanted.has(head.track)) return;
    const body = parseBlock((await reader.bytes(start, size)).slice());
    if (!body) return;
    blocks.push({
      track: body.track,
      timestamp: timestamp + body.offset,
      duration,
      data: body.data,
    });
  };

  for (let p = h.dataStart; p < end;) {
    const c = await reader.header(p);
    if (!c) break;
    if (!known && TOP_LEVEL_IDS.has(c.id)) {
      end = p; // An unknown-size Cluster ends where the next level-1 element starts.
      break;
    }
    if (c.size === null) break;
    const next = c.dataStart + c.size;
    if (c.id === ID.Timestamp) {
      timestamp = readUint(await reader.bytes(c.dataStart, c.size), 0, c.size);
    } else if (c.id === ID.SimpleBlock) {
      await readBlock(c.dataStart, c.size, null);
    } else if (c.id === ID.BlockGroup) {
      let block: { start: number; size: number } | null = null;
      let duration: number | null = null;
      for (let q = c.dataStart; q < next;) {
        const g = await reader.header(q);
        if (!g || g.size === null) break;
        if (g.id === ID.Block) block = { start: g.dataStart, size: g.size };
        else if (g.id === ID.BlockDuration) {
          duration = readUint(await reader.bytes(g.dataStart, g.size), 0, g.size);
        }
        q = g.dataStart + g.size;
      }
      if (block) await readBlock(block.start, block.size, duration);
    }
    p = next;
  }
  return { start: h.start, end, timestamp, blocks };
}
