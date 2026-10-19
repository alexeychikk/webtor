# 0009 — Per-video watch state: remembered tracks and resume

Date: 2026-10-19 · Status: accepted · Extends 0003 (audio default, seeks) and 0004 (subtitle default)

## Context

Only the last chosen audio and subtitle _language_ was remembered, globally. A reload lost the exact
track (two English subtitle tracks, sidecars, uploads, tracks without a language) and the position.

## Decision

- **One localStorage entry per video**: `webtor:watch:<infohash lower-case>:<file path in the
torrent>` → JSON `{ audio?, subtitle?, delay?, position?, duration?, updated }`
  (`src/lib/player/watch-state.ts`, pure, Vitest). Only user choices are written (picking a track,
  Off, the delay), never what a default picked. At most 200 entries: a new one evicts the least
  recently `updated`. Every storage error (private mode, quota) is ignored.
- **Tracks are found again robustly.** Audio: same id + language + label, else language + label +
  codec, else id + language. Subtitles: same key (`embedded:<TrackNumber>`, `sidecar:<file index>`)
  - language + label, else kind + language + label. Not found → the global language preferences
    (`webtor:audio-lang`, `webtor:subtitle-language`), which also stay the rule for videos never
    opened. A stored Off stays off. A stored embedded track waits until the file's embedded tracks are
    listed (`SubtitleManager.listingDone`) before falling back.
- **Uploads** are kept cheaply: the file's text under `webtor:watch-upload:<infohash>:<path>` when
  its stored form is at most 1 M characters, one per video, the newest 5 overall and at most 1.5 M
  characters together (evicted with their video too). Older uploads are evicted before the new one
  is written, and a watch entry that finds storage full drops uploads (oldest first) and retries:
  uploads must never crowd the origin's ~5 M quota and make positions, tracks, the relay URL or the
  language preferences fail to save. Bigger ones are not restored.
- **Resume.** The position is saved every 5 s while playing, on pause, seek, `ended`, `pagehide`,
  `visibilitychange` (hidden) and before a file switch or stop. On open, `resumePoint` resumes unless
  the position is under 10 s or in the watched end (the last 5 %, at most 60 s). `MsePlayer.open`
  looks up the keyframe before the resume point and starts both pipelines there (the relay
  conversion at the exact time), and sets `currentTime` while the element has no data yet, so it
  seeks there itself and nothing is fetched from the start; that one `seeking` restarts nothing. An
  AVI without an index can't seek ahead, so it starts from 0. A toast "Resumed at m:ss · Start
  over" (`resume-toast`, `start-over`) goes once the playhead is 15 s away or on dismiss.

## Rejected

- **IndexedDB:** async reads would delay the first fetch; the state is a few hundred bytes.
- **Keying by file index:** within one info hash the path is just as stable, and readable.
