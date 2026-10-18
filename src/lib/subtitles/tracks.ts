import type { SubtitleSourceKind, SubtitleTrackInfo } from '../player/types';
import { languageName } from './language';

export const SUBTITLE_GROUPS: ReadonlyArray<{ kind: SubtitleSourceKind; label: string }> = [
  { kind: 'embedded', label: 'Embedded' },
  { kind: 'sidecar', label: 'In torrent' },
  { kind: 'upload', label: 'Uploaded' },
];

/** Selector groups in display order; empty groups are left out. */
export function groupSubtitleTracks(tracks: readonly SubtitleTrackInfo[]) {
  return SUBTITLE_GROUPS.map((g) => ({
    ...g,
    tracks: tracks.filter((t) => t.kind === g.kind),
  })).filter((g) => g.tracks.length > 0);
}

/** Option text: "English · Movie.en.srt", "Movie.srt", plus "(forced)". */
export function subtitleTrackText(track: SubtitleTrackInfo): string {
  const lang = track.language ? languageName(track.language) : '';
  const parts = [lang, track.label].filter((p, i, all) => p && all.indexOf(p) === i);
  return (parts.join(' · ') || 'Untitled') + (track.forced ? ' (forced)' : '');
}

/** Stored subtitle preference: a normalised language code, `off`, or nothing yet. */
export type SubtitlePreference = string | 'off' | null;

/**
 * Default selection (docs/decisions/0004): a track in the user's last chosen language, else an
 * embedded forced track (meant to show even with subtitles off), else an embedded default track
 * unless the user last chose Off; otherwise Off (`null`). Earlier tracks win ties.
 */
export function defaultSubtitleKey(
  tracks: readonly SubtitleTrackInfo[],
  preference: SubtitlePreference,
): string | null {
  const usable = tracks.filter((t) => !t.unsupported);
  const embedded = usable.filter((t) => t.kind === 'embedded');
  const pick =
    (preference && preference !== 'off'
      ? usable.find((t) => t.language === preference)
      : undefined) ??
    embedded.find((t) => t.forced) ??
    (preference !== 'off' ? embedded.find((t) => t.isDefault) : undefined);
  return pick?.key ?? null;
}

/**
 * The `c` shortcut: the next selectable track in selector order after `selected`, then Off
 * (`null`), then the first again. An unknown `selected` counts as Off.
 */
export function nextSubtitleKey(
  tracks: readonly SubtitleTrackInfo[],
  selected: string | null,
): string | null {
  const keys = groupSubtitleTracks(tracks)
    .flatMap((g) => g.tracks)
    .filter((t) => !t.unsupported)
    .map((t) => t.key);
  const i = selected === null ? -1 : keys.indexOf(selected);
  return keys[i + 1] ?? null;
}
