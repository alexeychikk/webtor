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
  | 'dolby-vision-unsupported'
  | 'dolby-vision-base-layer'
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
  | 'avi-no-index'
  | 'hdr-sdr-display';

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
  'dolby-vision-unsupported':
    'This video is Dolby Vision without an HDR10 or SDR fallback, and browsers can’t show Dolby ' +
    'Vision: it would play with wrong, green and purple colours. Look for an HDR10 or SDR release ' +
    'of it.',
  'dolby-vision-base-layer':
    'Browsers can’t show Dolby Vision, so this video plays its HDR10/HLG fallback (SDR in a few ' +
    'releases). The colours are right; only Dolby Vision’s scene-by-scene tuning is missing.',
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
  'hdr-sdr-display':
    'This HDR video plays tone-mapped: turn on HDR in your OS display settings to see it in HDR.',
};

/** Short titles over the message in the player's error cards and toasts (docs/decisions/0008 §5). */
export const PLAYBACK_ERROR_TITLES: Record<PlaybackErrorCode, string> = {
  'invalid-input': 'Not a torrent',
  'no-webrtc': 'No WebRTC in this browser',
  'no-peers': 'No browser peers yet',
  stalled: 'Download stalled',
  'no-playable-file': 'No playable video',
  'unsupported-container': 'Format not supported',
  'unsupported-video-codec': 'Video codec not supported',
  'video-needs-relay': 'Video needs a relay',
  'dolby-vision-unsupported': 'Dolby Vision not supported',
  'dolby-vision-base-layer': 'Dolby Vision plays as HDR10/HLG',
  'unsupported-audio-codec': 'Audio track not supported',
  'no-mse': 'Streaming not supported',
  'no-playable-audio': 'Playing without sound',
  'audio-convert-failed': 'Audio conversion failed',
  'torrent-failed': 'Torrent failed to load',
  'playback-failed': 'Playback failed',
  'subtitle-failed': 'Subtitle file unreadable',
  'relay-unreachable': 'Relay unreachable',
  'relay-no-metadata': 'Relay found no peers',
  'relay-busy': 'Relay is busy',
  'relay-error': 'Relay error',
  'relay-transcode-unavailable': 'Relay can’t convert video',
  'relay-transcode-busy': 'Relay is busy converting',
  'relay-transcode-failed': 'Relay conversion failed',
  'relay-transcode-slow': 'Relay converts too slowly',
  'avi-no-index': 'Seeking is limited',
  'hdr-sdr-display': 'HDR video on an SDR display',
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
