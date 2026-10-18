# 0004 — Subtitles: own MKV subtitle extractor, native VTTCue for text, JASSUB for ASS

Date: 2026-10-18 · Status: accepted

## Decision

**Sources:** embedded MKV tracks, sidecar files inside the torrent (`.srt .vtt .ass .ssa`), and a
user-uploaded file (file input + drop on the player). The selector shows "Off" plus every track,
grouped Embedded / In torrent / Uploaded. Bitmap tracks (PGS `S_HDMV/PGS`, VobSub) are listed as
"unsupported" and disabled. The default is Off, unless an embedded track is flagged forced or
default, or matches the user's last chosen subtitle language (localStorage). Precedence: the last
chosen language (any source) → an embedded forced track → an embedded default track, which is
skipped when the user's last choice was Off. Languages are normalised to ISO 639-1 (`eng` → `en`), so
MKV tags and filenames (`Movie.en.srt`) compare equal.

**Embedded extraction:** Mediabunny 1.61 exposes no subtitle input tracks (verified: our fixture's
SRT and ASS tracks don't appear in `getTracks()`). So we keep a small EBML reader in
`src/lib/subtitles/mkv/` that works over the same `ByteSource`:

- **Header pass:** Segment → SeekHead → Tracks. From each `TrackEntry` with `TrackType 0x11` it reads
  number, `CodecID` (`S_TEXT/UTF8`, `S_TEXT/ASS`, `S_TEXT/SSA`, `S_TEXT/WEBVTT`), language
  (`LanguageBCP47` ?? `Language`), `Name`, `FlagDefault`/`FlagForced` and `CodecPrivate` (the ASS
  header). It also reads `Info/TimestampScale`, plus `Cues` and `Attachments` (fonts) via SeekHead.
- **Cue scanner:** subtitle blocks are interleaved in Clusters. The scanner starts at the cluster
  containing the playhead (via Cues), stays ~30 s ahead of `currentTime` and restarts on seek. It
  reads element headers and the track-number vint of each `SimpleBlock`/`BlockGroup`, and skips
  non-subtitle blocks by size. The bytes it touches are ones the video pipeline downloads anyway.
  Cue time is `(ClusterTimestamp + int16 block timestamp) × TimestampScale`. Duration comes from
  `BlockDuration` (4 s when missing). Cues are kept per track (deduplicated by start + text) and
  Clusters already read are remembered, so going back is instant. A scan starts 5 s behind the
  playhead, so a cue that began in an earlier Cluster still shows after a seek. Track
  `ContentEncodings` are undone: zlib (mkvmerge's default for subtitles, via `DecompressionStream`)
  and header stripping; encrypted or bzlib/lzo tracks are listed as unsupported.
- An ASS block payload is `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`. It is
  turned into a `Dialogue:` line with the block's start and end.

**Rendering:**

- **Text (SRT, VTT, embedded UTF8/WEBVTT)** → native `TextTrack`
  (`video.addTextTrack('subtitles', label, lang)`) with `VTTCue`s. Mode is `showing` or `disabled`.
  This works in native fullscreen, including iOS. Text tracks can't be removed: keep one per source
  and clear its cues instead.
- **ASS/SSA** → **JASSUB `^2.5`** (libass wasm, worker + OffscreenCanvas; falls back to single-thread
  without cross-origin isolation), lazy-loaded with Vite `?worker&url` / `?url` imports. Feed it the
  `CodecPrivate` header (or the sidecar file) and add dialogue events as the scanner finds them, as
  raw Matroska block payloads through libass's `processChunk` (which drops duplicates by ReadOrder).
  Fonts come from MKV attachments plus JASSUB's bundled default (Liberation Sans, preloaded, so the
  first frame drawn while paused already has glyphs); no local or Google font queries. The canvas
  overlays the video inside the player container, so our fullscreen button fullscreens the
  container, and the native control's fullscreen button is hidden (`controlslist="nofullscreen"`).
  Native `<video>` fullscreen would hide the overlay. Where only the video element can go
  fullscreen (iOS Safari), render ASS as text instead: strip `{\…}` tags and use VTTCue. The same
  text track is shown while the bare video is fullscreen anyway (a browser's own control), and if
  JASSUB fails to load.
- **Sidecar / upload decoding:** BOM if present → UTF-8 (fatal) → windows-1251 if the text scores as
  Cyrillic → windows-1252. Own small SRT/VTT parsers (unit-tested); no dependency.
- **Sidecar matching:** files whose basename starts with the video's basename come first, then the rest
  of the torrent's subtitle files. Fetch with `file.arrayBuffer()` when selected.

## Rejected

- `matroska-subtitles` / `ebml` npm packages: Node-stream based, unmaintained since 2022. They need
  polyfills and don't support starting at the playhead.
- Converting ASS to VTT everywhere: loses positioning and styling, which matter for anime.
