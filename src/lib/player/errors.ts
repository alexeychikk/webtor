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
  | 'video-needs-relay'
  | 'unsupported-audio-codec'
  | 'no-mse'
  | 'no-playable-audio'
  | 'audio-convert-failed'
  | 'torrent-failed'
  | 'playback-failed'
  | 'subtitle-failed'
  | 'relay-unreachable'
  | 'relay-no-metadata'
  | 'relay-busy'
  | 'relay-error'
  | 'relay-transcode-unavailable'
  | 'relay-transcode-busy'
  | 'relay-transcode-failed'
  | 'relay-transcode-slow'
  | 'avi-no-index';

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
    'This video format cannot be opened in the browser (supported: MKV, MP4, MOV, WebM, MPEG-TS, AVI).',
  'unsupported-video-codec':
    'This video uses a codec your browser cannot decode (often HEVC/H.265 or 10-bit H.264). ' +
    'Try Safari, or Chrome/Edge on a device with hardware HEVC support.',
  'video-needs-relay':
    'This video uses an old format that browsers can’t play. Converting it needs a relay you run ' +
    'yourself (webtor-relay) with ffmpeg installed.',
  'unsupported-audio-codec':
    'This audio track cannot be played or converted in the browser. Pick another audio track.',
  'no-mse': 'This browser cannot stream video (Media Source Extensions missing; iOS needs 17.1+).',
  'no-playable-audio':
    'None of the audio tracks in this video can be played in this browser, so it plays muted.',
  'audio-convert-failed':
    'This audio track could not be converted in the browser. Pick another audio track.',
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
  'relay-busy':
    'Your relay is already streaming its maximum number of torrents. Stop one or raise -max-torrents.',
  'relay-error': 'Your relay could not load this torrent.',
  'relay-transcode-unavailable':
    'Your relay can’t convert video. Install ffmpeg on its computer and restart webtor-relay.',
  'relay-transcode-busy':
    'Your relay is already converting another video. Close it, or raise -max-transcodes.',
  'relay-transcode-failed': 'Your relay could not convert this video.',
  'relay-transcode-slow':
    'Your relay converts video slower than it plays. Start it with a lower -transcode-max-height ' +
    'or a faster -transcode-preset.',
  'avi-no-index':
    'This AVI file has no index, so seeking is limited: it plays from the start, and you can only ' +
    'seek within the part loaded so far.',
};

export class PlaybackError extends Error {
  constructor(
    readonly code: PlaybackErrorCode,
    readonly detail?: string,
  ) {
    super(playbackErrorMessage(code, detail));
    this.name = 'PlaybackError';
  }
}

/** The user-facing message; `video-needs-relay` names the format (`detail`) in the sentence. */
export function playbackErrorMessage(code: PlaybackErrorCode, detail?: string): string {
  if (code === 'video-needs-relay' && detail) {
    return (
      `This video uses an old ${detail} format that browsers can’t play. Converting it needs a ` +
      'relay you run yourself (webtor-relay) with ffmpeg installed.'
    );
  }
  return PLAYBACK_ERROR_MESSAGES[code] + (detail ? ` (${detail})` : '');
}
