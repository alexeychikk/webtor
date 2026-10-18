/**
 * Glue between the MKV reader and the player: lists a file's embedded subtitle tracks and, while one
 * of them is selected, keeps the cluster scan ~30 s ahead of the playhead, restarting it on seeks
 * (docs/decisions/0004). The scan's reads are ones the video pipeline makes anyway.
 */
import type { ByteSource, SubtitleTrackInfo } from '../../player/types';
import type { SubtitleCue } from '../cue';
import { normalizeLanguage } from '../language';
import { readMkvHeader, type MkvHeader, type MkvSubtitleTrack } from './header';
import { ByteReader } from './reader';
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
    renderer: 'text', // ASS/SSA as plain text until the JASSUB renderer lands.
    language: normalizeLanguage(track.language),
    label: track.name || FORMAT_LABELS[track.codecId] || track.codecId || 'Subtitles',
    isDefault: track.isDefault,
    forced: track.forced,
    ...(track.format ? {} : { unsupported: true }),
  };
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
        if (t >= this.from && this.until >= t + SCAN_REFILL_S) return;
        const abort = new AbortController();
        this.scanAbort = abort;
        try {
          const from = Math.max(0, t - SCAN_BEHIND_S);
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
