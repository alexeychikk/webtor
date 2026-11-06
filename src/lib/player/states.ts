/**
 * What the player shows about errors and notices (docs/decisions/0008 §5), kept pure: one card at
 * most (a fatal error, or no-peers while still searching) and a stack of toasts for the rest.
 */
import type { Phase } from './controller.svelte';
import type { PlaybackErrorCode } from './errors';
import { STALLED_NOTICES } from './watchdog';

export interface StateCard {
  code: PlaybackErrorCode;
  /** `error`: fatal (`role=alert`); `searching`: no-peers, the search goes on under it. */
  kind: 'error' | 'searching';
}

export interface StateToast {
  code: PlaybackErrorCode;
  detail?: string;
}

export function playerStates(s: {
  phase: Phase;
  error: PlaybackErrorCode | null;
  notices: readonly PlaybackErrorCode[];
  subtitleNotice: StateToast | null;
  /** The detail (`playbackErrorMessage`) of a notice, by code. */
  details?: Partial<Record<PlaybackErrorCode, string>>;
  /** Toast codes the user dismissed for the current file. */
  dismissed: ReadonlySet<PlaybackErrorCode>;
}): { card: StateCard | null; toasts: StateToast[] } {
  if (s.phase === 'idle') return { card: null, toasts: [] };
  if (s.phase === 'error') {
    return { card: s.error ? { code: s.error, kind: 'error' } : null, toasts: [] };
  }
  const card: StateCard | null = s.notices.includes('no-peers')
    ? { code: 'no-peers', kind: 'searching' }
    : null;
  const toasts: StateToast[] = s.notices
    .filter((code) => code !== 'no-peers')
    .map((code) => {
      const detail = s.details?.[code];
      return detail === undefined ? { code } : { code, detail };
    });
  if (s.subtitleNotice) toasts.push(s.subtitleNotice);
  return { card, toasts: toasts.filter((t) => !s.dismissed.has(t.code)) };
}

/**
 * The buttons of an error card: Retry (pointless for a non-torrent or a Dolby Vision-only video,
 * which fail the same way again) and a way to the relay.
 */
export function errorActions(code: PlaybackErrorCode): {
  retry: boolean;
  relay: 'settings' | 'setup' | null;
} {
  return {
    retry: code !== 'invalid-input' && code !== 'dolby-vision-unsupported',
    relay: code.startsWith('relay-') ? 'settings' : code === 'video-needs-relay' ? 'setup' : null,
  };
}

/** `playerStates` details for the stalled notice showing, if any: its number (`stalledNotice`). */
export function stalledDetails(
  notices: readonly PlaybackErrorCode[],
  detail: string | undefined,
): Partial<Record<PlaybackErrorCode, string>> {
  const code = notices.find((n) => (STALLED_NOTICES as readonly string[]).includes(n));
  return code && detail !== undefined ? { [code]: detail } : {};
}

/** The stalled notices offer the help dialog ("Why won’t it play?"). */
export const isStalledNotice = (code: PlaybackErrorCode): boolean =>
  (STALLED_NOTICES as readonly string[]).includes(code);
