# 0003 — Media pipeline: Mediabunny remux to fragmented MP4 → MSE, audio-only transcode

Date: 2026-10-18 · Status: accepted

## Decision

Every container goes through one path, with no special case for "natively playable" files:

```
TorrentFile ──ByteSource──▶ Mediabunny Input (CustomSource, ALL_FORMATS)
   ├─ Conversion #1: selected video track, copied   ─▶ fMP4 ─▶ StreamTarget ─▶ video SourceBuffer
   └─ Conversion #2: selected audio track, copy|transcode ─▶ fMP4 ─▶ StreamTarget ─▶ audio SourceBuffer
                                                                  (one MediaSource on <video>)
```

- **Library: `mediabunny@^1.61`**: pure TypeScript, demuxes MKV/WebM/MP4/MOV/MPEG-TS and muxes
  fragmented MP4 (`new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 })`).
  `CustomSource({ getSize, read, prefetchProfile: 'network' })` reads from the torrent file.
  `ByteSource.read` uses an exclusive end; WebTorrent's `file.stream({start, end})` uses an inclusive
  end and treats `end: 0` as "to EOF", so never pass 0.
- **Two SourceBuffers** (video, audio), each fed by its own `Conversion`, so an audio switch never
  touches video. `MediaSource`, or `ManagedMediaSource` where only that exists (iOS 17.1+;
  set `video.disableRemotePlayback = true`). Neither present → `no-mse` error.
- **Back-pressure:** the `WritableStream` behind `StreamTarget` awaits `appendBuffer` and then waits
  while buffered-ahead > 60 s. Mediabunny propagates this to reads, so the download follows the
  playhead (the relay's stream likewise: `pumpRemote` stops reading). Evict more than 30 s behind
  the playhead. With `ManagedMediaSource`, `endstreaming` holds appends (and so the download) until
  `startstreaming`, except below 3 s ahead (`MIN_AHEAD_S`), so a missed event never stalls playback.
- **`QuotaExceededError` is back-pressure, never fatal** (`src/lib/player/append.ts`, 2026-10-19).
  Safari/iPadOS give a SourceBuffer far fewer bytes than 60 s of a high-bitrate file, and nothing
  behind the playhead may be left to evict: failing after a few retries killed playback on iPad. On a
  quota hit the pipeline (1) evicts all but 1 s behind the playhead, ending on a keyframe it appended
  (MSE removes up to the next random-access point, which must not be past the playhead; relay video
  has one every 2 s); (2) caps its own ahead target at 80 % of what was buffered ahead when it hit
  (never below 3 s) and from then on evicts tightly before every append; (3) waits for playback
  (`timeupdate`, `seeking`, `startstreaming`, or 1 s) and retries, holding the chunk. Paused, it
  simply holds. Audio switch: the old track ahead of the new pipeline is dropped first (it gets
  overwritten anyway). A pipeline starved by the quota (< 3 s ahead) asks the other SourceBuffer for
  room: evict behind, else halve its media ahead (restart it there, cap it) so audio and video never
  starve each other under a shared quota. Only a buffer with nothing at the playhead and nothing to
  free anywhere, 5 hits in a row, fails (`playback-failed`). A hole at the playhead between buffered
  ranges (UA eviction ahead, `bufferedchange`) restarts the pipelines there on `waiting`. e2e forces
  a quota with `localStorage['webtor:sb-quota-bytes']`; real Safari/iPad behaviour is checked by hand.
- **Timestamps:** `Conversion` with `trim.start = K` rebases output to 0, so set
  `sourceBuffer.timestampOffset = K` before the first append (verified in a spike).
- **Seeking:** if the target is buffered in both SourceBuffers, do nothing. Otherwise debounce (150 ms),
  `cancel()` both conversions, `abort()` + clear each SourceBuffer, and find
  `K = (await new EncodedPacketSink(videoTrack).getKeyPacket(t, { verifyKeyPackets: true })).timestamp`.
  Then restart both conversions at `trim.start = K`. Reads issued by the new conversion re-prioritise
  pieces. WebTorrent reads selected ranges first. MKV Cues and MP4 `moov`-at-end sit at the file tail:
  the first read fetches those few pieces.
- **Video is never transcoded.** Copy when
  `MediaSource.isTypeSupported('video/mp4; codecs="' + await track.getCodecParameterString() + '"')`.
  Otherwise show `unsupported-video-codec`. Real-time software video encoding in a tab is not viable.
  This mostly hits HEVC: it plays on Safari and on Chrome/Edge with a hardware HEVC decoder
  (Windows/macOS/Android), and fails elsewhere (most Firefox, Linux). It also hits 10-bit H.264
  ("Hi10P", common in anime).
- **Audio** is copied when MSE accepts it in MP4 (AAC, MP3, Opus, FLAC; AC-3/E-AC-3 only on Safari
  and some Edge). Otherwise it is transcoded inside the same `Conversion`
  (`{ codec, numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 }`). Decoders: WebCodecs, plus
  lazily imported `@mediabunny/ac3` (AC-3/E-AC-3) and `@mediabunny/dts` (DTS), registered on first
  need. Target codec: the first of Opus, AAC that `canEncodeAudio()` reports and MSE accepts in MP4.
  If neither, load `@mediabunny/aac-encoder` (wasm). Tracks with no decoder (e.g. TrueHD, or
  `codec === null`) are listed as unsupported. If no audio track is playable, play the video muted
  with a notice.
- **Audio track switching** (`HTMLMediaElement.audioTracks` is not used anywhere):
  1. Cancel the audio conversion and `abort()` the audio SourceBuffer, keeping everything it has
     buffered. The old track plays on until the new one replaces it. Cutting it (all of it, or
     everything past `t + 1 s`) stalled playback whenever the new pipeline's first fragment took
     longer: an AC-3 → Opus start (decoder worker + wasm, encoder, a 1 s fragment) takes 0.5 s
     idle and 2–4 s on a busy machine.
  2. Call `changeType(mime)` if the new output codec differs (e.g. AAC copy → Opus transcode).
  3. Set `timestampOffset = t` and restart with `trim.start = t`, where `t = currentTime`. MSE
     drops the old frames each new fragment overlaps, so the buffer stays contiguous: new track up
     to where the pipeline is, old track after it. While the old media lies ahead, `sb.buffered`
     can't show how far the new pipeline got, so back-pressure follows the start of its latest
     fragment (`Mp4OutputFormat.onMoof`) until it passes the old buffered end. Video keeps playing
     without an audio gap.
     If the new track fails to start, the player goes back to the previous one.
     The default track is the user's last chosen language (`localStorage['webtor:audio-lang']`),
     else the `default`-flagged track, else the first one; unsupported tracks are skipped.
     The decision table is `decideAudio` / `pickTranscodeTarget` in `src/lib/player/codecs.ts`.
- **Loading:** `mediabunny` is imported dynamically when the first torrent is added; codec extensions
  load only when a track needs them (each is ~1–2 MB of wasm).

## Evidence (spike, headless Chromium 1248 arm64, 2026-10-18)

The 12 s fixture `e2e/fixtures/sample.mkv` (H.264, AAC + AC-3, SRT + ASS) came from a web seed and
went through MSE with the H.264 video copied and AC-3 transcoded to Opus. The 12 s of AC-3 took
466 ms (~25× realtime). A seek restarted at keyframe K=6 with `timestampOffset` and played
(readyState 4). Chromium there reported: `ac-3` in MSE no, Opus in MP4 yes, Opus encode yes,
AAC encode no.

## Rejected

- **Service worker + `file.streamURL`/`streamTo`:** it only plays what `<video>` plays natively
  (MP4/WebM with supported codecs). It has no MKV, no audio choice and no transcode, and adds a
  service worker scope to manage on Pages.
- **ffmpeg.wasm / libav.js:** 25–30 MB cores, slower, and threads need COOP/COEP (see 0001).
  Mediabunny does demux + mux in TS and loads codec wasm only when needed.
- **Canvas/WebCodecs/WebAudio rendering (e.g. MediaFox):** loses native `<video>` (hardware
  playback, PiP, AirPlay, iOS fullscreen) and forces us to own A/V sync.
- **mp4box.js / ebml-based custom remuxers:** this is exactly what Mediabunny already does,
  maintained and typed.
