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
  | 'no-mse'
  | 'no-playable-audio'
  | 'torrent-failed'
  | 'playback-failed'
  | 'subtitle-failed'
  | 'relay-unreachable'
  | 'relay-no-metadata'
  | 'relay-error';

export const PLAYBACK_ERROR_MESSAGES: Record<PlaybackErrorCode, string> = {
  'invalid-input': 'That is not a magnet link, info hash or .torrent file.',
  'no-webrtc': 'This browser has no WebRTC support, so it cannot connect to any peers.',
  'no-peers':
    'No browser-compatible peers found. A browser can only download from peers that speak WebRTC ' +
    '(WebTorrent Desktop, webtorrent-cli, other browser tabs, a few libtorrent 2.x builds). Most ' +
    'regular torrent clients (qBittorrent, Transmission, µTorrent) cannot serve browsers, so many ' +
    'public torrents will never start here. We keep searching in the background. To reach regular ' +
    'peers too, connect a relay you run yourself.',
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
  'no-playable-audio':
    'None of the audio tracks in this video can be played in this browser, so it plays muted.',
  'torrent-failed': 'The torrent could not be loaded.',
  'playback-failed': 'The browser failed to play this video.',
  'subtitle-failed':
    'This subtitle file could not be read. Supported: SRT, WebVTT and ASS/SSA (shown as plain text).',
  'relay-unreachable':
    'Cannot reach your relay. Check that webtor-relay is running and the relay URL is right. If the ' +
    'browser asked to allow access to local network devices or apps, allow it and try again.',
  'relay-no-metadata':
    'Your relay found no peers that could send this torrent’s info in time. The torrent may be dead, ' +
    'or the relay’s network blocks BitTorrent traffic.',
  'relay-error': 'Your relay could not load this torrent.',
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
