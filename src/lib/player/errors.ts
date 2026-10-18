/**
 * Every failure the user can hit ends in one of these — never an endless spinner. Messages are
 * user-facing copy; keep them plain and say what the user can do next.
 */
export type PlaybackErrorCode =
  | 'invalid-input'
  | 'no-webrtc'
  | 'no-peers'
  | 'stalled'
  | 'no-playable-file'
  | 'unsupported-container'
  | 'unsupported-video-codec'
  | 'unsupported-audio-codec'
  | 'no-mse';

export const PLAYBACK_ERROR_MESSAGES: Record<PlaybackErrorCode, string> = {
  'invalid-input': 'That is not a magnet link, info hash or .torrent file.',
  'no-webrtc': 'This browser has no WebRTC support, so it cannot connect to any peers.',
  'no-peers':
    'No browser-compatible peers found. A browser can only download from peers that speak WebRTC ' +
    '(WebTorrent Desktop, webtorrent-cli, other browser tabs, a few libtorrent 2.x builds). Most ' +
    'regular torrent clients (qBittorrent, Transmission, µTorrent) cannot serve browsers, so many ' +
    'public torrents will never start here. We keep searching in the background.',
  stalled: 'Download stalled: peers disconnected or stopped sending data. Still trying…',
  'no-playable-file': 'This torrent contains no video file that can be played in the browser.',
  'unsupported-container':
    'This video format cannot be opened in the browser (supported: MKV, MP4, MOV, WebM, MPEG-TS).',
  'unsupported-video-codec':
    'This video uses a codec your browser cannot decode (often HEVC/H.265 or 10-bit H.264). ' +
    'Try Safari, or Chrome/Edge on a device with hardware HEVC support.',
  'unsupported-audio-codec':
    'This audio track cannot be played or converted in the browser. Pick another audio track.',
  'no-mse': 'This browser cannot stream video (Media Source Extensions missing; iOS needs 17.1+).',
};

export class PlaybackError extends Error {
  constructor(
    readonly code: PlaybackErrorCode,
    readonly detail?: string,
  ) {
    super(PLAYBACK_ERROR_MESSAGES[code] + (detail ? ` (${detail})` : ''));
    this.name = 'PlaybackError';
  }
}
