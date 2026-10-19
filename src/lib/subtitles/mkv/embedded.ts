/**
 * Glue between the MKV reader and the player: lists a file's embedded subtitle tracks and, while one
 * of them is selected, keeps the cluster scan ~30 s ahead of the playhead, restarting it on seeks
 * (docs/decisions/0004). The scan's reads are ones the video pipeline makes anyway.
 */
import type { ByteSource, SubtitleTrackInfo } from '../../player/types';
import type { SubtitleCue } from '../cue';
import { normalizeLanguage } from '../language';
import {
  readAttachments,
  readMkvHeader,
  type MkvAttachment,
  type MkvHeader,
  type MkvSubtitleTrack,
} from './header';
import { ByteReader, readRange } from './reader';
import { ClusterScanner } from './scanner';

/** How far ahead of the playhead cues are read (seconds). */
export const SCAN_AHEAD_S = 30;
/**
 * Scans start this far behind the playhead (seconds): a cue is stored in the Cluster where it starts,
 * so one still on screen at the seek target can sit a Cluster or two earlier.
 */
export const SCAN_BEHIND_S = 5;
/** A new scan starts when less than this much is covered ahead of the playhead (seconds). */
export const SCAN_REFILL_S = 15;

const FORMAT_LABELS: Record<string, string> = {
  'S_TEXT/UTF8': 'SRT',
  'S_TEXT/ASCII': 'SRT',
  'S_TEXT/ASS': 'ASS',
  S_ASS: 'ASS',
  'S_TEXT/SSA': 'SSA',
  S_SSA: 'SSA',
  'S_TEXT/WEBVTT': 'WebVTT',
  'S_HDMV/PGS': 'PGS',
  S_VOBSUB: 'VobSub',
  S_DVBSUB: 'DVB',
};

export const embeddedKey = (trackNumber: number) => `embedded:${trackNumber}`;

/** Selector entry for an embedded track; bitmap and unknown codecs are listed as unsupported. */
export function embeddedTrackInfo(track: MkvSubtitleTrack): SubtitleTrackInfo {
  return {
    key: embeddedKey(track.number),
    kind: 'embedded',
    renderer: track.format === 'ass' || track.format === 'ssa' ? 'ass' : 'text',
    language: normalizeLanguage(track.language),
    label: track.name || FORMAT_LABELS[track.codecId] || track.codecId || 'Subtitles',
    isDefault: track.isDefault,
    forced: track.forced,
    ...(track.format ? {} : { unsupported: true }),
  };
}

/**
 * The ASS/SSA script header (`[Script Info]`, styles, `[Events]` format) of a styled track, from
 * its `CodecPrivate`; `null` for other tracks or when it is missing.
 */
export function assHeaderOf(track: MkvSubtitleTrack): string | null {
  if ((track.format !== 'ass' && track.format !== 'ssa') || !track.codecPrivate?.length) {
    return null;
  }
  const text = new TextDecoder('utf-8').decode(track.codecPrivate).replace(/\0+$/, '');
  return /\[Script Info\]|\[V4\+? Styles\]/i.test(text) ? text : null;
}

/** All attached fonts together may take this much; a file with more gets the first ones. */
export const MAX_FONT_BYTES = 64 * 1024 * 1024;

const FONT_EXTENSION = /\.(ttf|otf|ttc|otc|woff2?)$/i;

/** Is an attachment a font (by MIME type, or by extension for `application/octet-stream`)? */
export function isFontAttachment(att: Pick<MkvAttachment, 'name' | 'mimeType'>): boolean {
  const mime = att.mimeType.toLowerCase();
  return (
    mime.startsWith('font/') ||
    /^application\/(x-)?(truetype-font|font-[a-z]+|vnd\.ms-opentype|x-font-[a-z]+)$/.test(mime) ||
    FONT_EXTENSION.test(att.name)
  );
}

/** Reads the file's attached fonts (for the ASS renderer), up to `MAX_FONT_BYTES` in total. */
export async function readFontAttachments(
  source: ByteSource,
  header: MkvHeader,
): Promise<Uint8Array[]> {
  const fonts: Uint8Array[] = [];
  let total = 0;
  for (const att of await readAttachments(new ByteReader(source), header)) {
    if (!isFontAttachment(att) || total + att.size > MAX_FONT_BYTES) continue;
    total += att.size;
    fonts.push(await readRange(source, att.dataStart, att.dataStart + att.size));
  }
  return fonts;
}

/** Reads a Matroska/WebM file's header; `null` for other containers or no Tracks. */
export function readEmbeddedHeader(source: ByteSource): Promise<MkvHeader | null> {
  return readMkvHeader(new ByteReader(source));
}

export interface EmbeddedScanEvents {
  /** New cues of a track, already on the element timeline. */
  onCues(key: string, cues: SubtitleCue[]): void;
  onError(err: unknown): void;
}

/** Runs the cluster scan for one playing file. */
export class EmbeddedSubtitleScan {
  private readonly scanner: ClusterScanner;
  private readonly events = new AbortController();
  private active = false;
  private destroyed = false;
  private running = false;
  private scanAbort: AbortController | null = null;
  /** Source-time range the last finished scan covered. */
  private from = Infinity;
  private until = -Infinity;

  constructor(
    source: ByteSource,
    header: MkvHeader,
    private readonly video: HTMLVideoElement,
    /** Source time of element time 0 (`Timeline.startTime`). */
    private readonly startTime: number,
    private readonly handlers: EmbeddedScanEvents,
  ) {
    this.scanner = new ClusterScanner(source, header, (track, cues) => {
      // A read still in flight when the file closed must not feed the next file's tracks.
      if (this.destroyed) return;
      const shifted = cues
        .map((c) => ({ ...c, start: c.start - startTime, end: c.end - startTime }))
        .filter((c) => c.end > 0);
      if (shifted.length) handlers.onCues(embeddedKey(track), shifted);
    });
    const { signal } = this.events;
    video.addEventListener('timeupdate', () => void this.pump(), { signal });
    video.addEventListener('seeking', () => this.onSeeking(), { signal });
  }

  /** Scans only while an embedded track is selected. */
  setActive(active: boolean) {
    if (this.destroyed || active === this.active) return;
    this.active = active;
    if (active) void this.pump();
    else this.scanAbort?.abort();
  }

  destroy() {
    this.destroyed = true;
    this.events.abort();
    this.scanAbort?.abort();
  }

  private sourceTime() {
    return this.video.currentTime + this.startTime;
  }

  private onSeeking() {
    const t = this.sourceTime();
    // Jumped out of what is being read: drop that read and start at the new position.
    if (t < this.from || t > this.until) this.scanAbort?.abort();
    void this.pump();
  }

  private async pump() {
    if (this.running || !this.active || this.destroyed) return;
    this.running = true;
    try {
      while (this.active && !this.destroyed) {
        const t = this.sourceTime();
        // Covered only with the margin behind the playhead too: a cue still on screen can start
        // a Cluster or two earlier (an aborted scan may have started past it).
        const from = Math.max(0, t - SCAN_BEHIND_S);
        if (from >= this.from && this.until >= t + SCAN_REFILL_S) return;
        const abort = new AbortController();
        this.scanAbort = abort;
        try {
          this.until = await this.scanner.scan(from, t + SCAN_AHEAD_S, abort.signal);
          this.from = from;
        } catch (err) {
          if (abort.signal.aborted) {
            this.from = Infinity;
            this.until = -Infinity;
            continue; // Seek or deselect: the loop re-checks where to read.
          }
          throw err;
        }
      }
    } catch (err) {
      if (this.destroyed) return;
      this.active = false;
      this.handlers.onError(err);
    } finally {
      this.running = false;
      this.scanAbort = null;
    }
  }
}
