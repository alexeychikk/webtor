# 0007 — AVI: our own demuxer inside Mediabunny, relay-side video conversion for DivX/Xvid

Date: 2026-10-19 · Status: accepted (§1 in-browser AVI implemented; relay conversion pending) · Extends 0003 and 0006

## Context

`.avi` files are listed greyed out because Mediabunny 1.61 (0003) has no AVI demuxer. Upstream
work has stalled: PR "Add AVI container format support" (Vanilagy/mediabunny#155) has been open
since 2025-09, and the unofficial `mediabunny-avi` fork targets an unreleased v2. Most AVI files carry
**MPEG-4 Part 2** video (DivX/Xvid; older ones MS-MPEG4 v2/v3 `MP42`/`DIV3`) with MP3 or AC-3 audio.
No browser decodes that video, and 0003 rules out video encoding in a tab. Newer AVI files sometimes
carry H.264, which the browser plays once it is demuxed.

## Decision

### 1. In the browser: `AviInputFormat`, a Mediabunny input format of our own

`src/lib/player/avi/` adds an AVI format that `MsePlayer.open` puts in front of `ALL_FORMATS`
(`formats: [createAviFormat(source), ...mb.ALL_FORMATS]`). Everything downstream is unchanged:
`Conversion`, the audio copy or transcode decision, `getKeyPacket` seeking, `timeline.ts` and audio
switching.

- **Mediabunny 1.x has no public API for this.** `InputFormat` exposes only `name` and `mimeType`.
  `Input` checks `instanceof InputFormat`, then calls the internal `_canReadInput(input)` and
  `_createDemuxer(input)`. It duck-types the demuxer (`getTrackBackings`, `getMimeType`,
  `getMetadataTags`, `dispose`) and each track backing (about 30 methods: `getType`, `getCodec`,
  `getDecoderConfig`, `getFirstPacket`, `getPacket`, `getNextPacket`, `getKeyPacket`,
  `getNextKeyPacket`, the dimension and timing getters). We subclass the exported `InputFormat` and
  implement those methods. The format reads through our own `ByteSource`, not the internal `Reader`.
  **Pin `mediabunny` (and `@mediabunny/*`) to an exact version.** A unit test feeds the fixtures
  through `Input` + `EncodedPacketSink`, so an upgrade that changes the internals fails `pnpm test`.
  If upstream ships AVI later, swap it in behind `createAviFormat`.
- **H.264 packets stay Annex B.** `getDecoderConfig()` returns `{codec: 'avc1.PPCCLL',
codedWidth, codedHeight}` with **no `description`**. Mediabunny's MP4 muxer then builds `avcC`
  from the first key packet and converts the samples to length-prefixed (its public Annex B path,
  also used for MPEG-TS). The codec string comes from SPS bytes 1–3.
- **Timestamps.** AVI stores frames in decode order and has no PTS. DTS of video chunk `i` is
  `(i + strh.dwStart) · dwScale / dwRate`. Zero-size video chunks are dropped frames: they take a
  slot but produce no packet. With B-frames, PTS comes from the picture order count. Parse the SPS
  (`pic_order_cnt_type`, `log2_max_frame_num`, `log2_max_pic_order_cnt_lsb`, `frame_mbs_only`),
  parse each slice header up to `pic_order_cnt_lsb`, and track the POC MSB. Then **rank each frame's
  POC within its GOP** (IDR to IDR) and set `pts = dts(first frame of GOP) + rank · frameDuration`.
  POC type 2 means PTS = DTS. POC type 1 and open GOPs that never send an IDR are rare: fall back
  to POC deltas (`(poc − anchorPoc) / pocStep`, with `pocStep` the GCD of the deltas seen) and
  test it with a fixture. The packet's first NAL units can be an SEI of several hundred bytes, so
  read the whole chunk, not a fixed prefix.
- **Audio is re-framed.** Treat each audio stream as one byte stream (chunk boundaries mean nothing)
  and split it into codec frames: MP3 (frame header gives length and 1152/576 samples), AC-3 (sync
  word `0x0B77`, `fscod`/`frmsizecod`, 1536 samples) and PCM (`nBlockAlign`). Each frame becomes one
  packet, timed by frame count. This handles CBR, VBR (`strh.dwSampleSize = 0`), empty interleave
  chunks (ffmpeg writes them) and frames that span chunks. To find the frame at time `t`, find the
  chunk: by byte position `t · nAvgBytesPerSec` for CBR, by chunk index `t · dwRate / dwScale` for
  VBR (one frame per chunk). Then resync to a frame header. Codec map
  (`WAVEFORMATEX.wFormatTag`): `0x55` mp3, `0x2000` ac3, `0x2001` dts, `0x01`/`0x03`/`0xFFFE`
  PCM, `0xFF`/`0x1610` aac (with `strf` extradata as `description`). Others (WMA `0x161`…) give
  `codec: null` and are listed as unsupported. Chromium's MSE rejects MP3 in MP4 (`mp3`,
  `mp4a.6b`, `mp4a.69` are all unsupported in the spike), so MP3 is usually transcoded to Opus
  through the existing path. `decideAudio` should still try `mp4a.6b` first, for browsers that
  take it.
- **Index and torrent reads.** Read the first 64 KiB: `hdrl` (`avih`, `strl` = `strh`/`strf`/
  `strn`/`indx`) and the position and size of `LIST movi`. Then:
  - **OpenDML** (an `indx` super index in a `strl`; files over 1 GB, where `idx1` only covers the
    first `RIFF`): the super index lists `ix##` standard index chunks with their durations. Load
    each one lazily, only for the time range being read: the first at open, another on a seek
    into its range.
  - **`idx1`** (`AVIF_HASINDEX`), at the end of `movi`: one ranged read of 16 bytes per chunk
    (about 5–6 MB for 2 h at 25 fps with interleaved audio). It sits at the file tail, like MKV
    Cues, so it costs a few pieces before the first frame. Offsets are relative to `movi` or
    absolute: decide from the first entry. Keep per-stream tables in typed arrays (offset, size,
    key flag).
  - **No usable index** (flag missing, size 0, entries outside `movi`): scan `movi` chunk headers
    while playing from the start, and keep a notice up (`avi-no-index`): seeking works only within
    what has been scanned. Duration still comes from `avih` (`dwTotalFrames · dwMicroSecPerFrame`).
    Jumping by bitrate estimate with resync was rejected for now: AVI has no timestamps to resync
    to, so A/V sync after the jump would be a guess.
- **Video the browser can't decode** (any `vids` stream that isn't H.264) gets `codec: null`, and
  `getInternalCodecId()` returns the FourCC (`strh.fccHandler`, else `biCompression`). With no
  relay, the player fails with a new code **`video-needs-relay`**. Its copy names the format
  (`XVID`/`DIVX`/`DX50`/`FMP4`/`MP4V` → "DivX/Xvid (MPEG-4 Part 2)", `DIV3`/`MP43`/`MP42` → "DivX 3 /
  MS-MPEG4", `MJPG`, `WMV*`…; pure map in `avi/fourcc.ts`) and links to the relay dialog.
  Packed B-frames (DivX 5 "packed bitstream") only occur in MPEG-4 Part 2, so only the relay sees
  them, and ffmpeg unpacks them while decoding.
- `files.ts`: `avi` moves to the playable extensions. The codec is only known after the header is
  read, so a DivX file is listed as playable and fails with `video-needs-relay` when opened.

### 2. On the relay: video-only conversion to fragmented MP4, audio stays in the browser

With a relay set and a video track the browser can't copy, `MsePlayer` keeps everything as it is
except the **video pipeline**. That pipeline streams H.264 from the relay into the video
SourceBuffer instead of running a `Conversion`. The browser still demuxes the AVI (header + index
via WebTorrent from the relay's web seed). That gives the track list, duration, audio (copy or
transcode, track switching) and sidecar subtitles. So the relay needs no probe endpoint and no
audio jobs, and audio switching never restarts the video encoder. The same branch covers HEVC or
10-bit H.264 MKVs (`unsupported-video-codec`) once a relay is set. Showing the relay option for
those as well is a Product call; it costs no relay work.

- **API:** `GET {base}/v1/torrents/{ih}/transcode/{fileIndex}?start=<s>` → `200 video/mp4`,
  chunked, no `Range`, `Cache-Control: no-store`. The body is fragmented MP4
  (`frag_keyframe+empty_moov+default_base_moof`, `-frag_duration 1000000`) of H.264 High 8-bit
  `yuv420p`, no audio, timestamps starting at 0 for source time `start`. `start` is element time
  (0003 timeline): ffmpeg's input `-ss` is also relative to the file's start time. Errors (JSON
  `{error}`): 404 unknown torrent or file; 503 `transcode-unavailable` (no usable ffmpeg); 429
  `transcode-busy` `{maxTranscodes}`; 422 `transcode-failed` `{detail}` when ffmpeg exits before
  the first byte (for example, can't decode). `/v1/info` gains `transcode: {available, ffmpeg:
"<version>", maxHeight, preset}`, and `api` goes to 2.
- **ffmpeg input:** a loopback-only listener on `127.0.0.1:0` serves only the job's file at
  `/<random job id>` (`http.ServeContent` over an anacrolix `Reader`, as the web seed does). ffmpeg
  then seeks with `Range` (`idx1` at the tail, `-ss` on the index), torrent reads follow its read
  position, and the relay token never appears in ffmpeg's argv. Add `-protocol_whitelist http,tcp`
  and `-nostdin`.
- **Command:** `ffmpeg -ss <start> -i <job url> -map 0:v:0 -an -sn -dn -vf
"scale=-2:min(ih\,<maxHeight>)" -c:v libx264 -preset <preset> -crf 23 -pix_fmt yuv420p
-profile:v high -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 -f mp4 -movflags …
pipe:1`. Input `-ss` with transcoding is frame-accurate, so the output starts exactly at `start`,
  with no keyframe alignment. **Seeking** is: cancel the fetch, clear the video SourceBuffer, set
  `timestampOffset = t`, request `start=t`. The audio `Conversion` restarts at the same `t` (every
  audio packet is a key packet).
- **Back-pressure is TCP.** The app stops reading the response while buffered-ahead > the window
  (60 s). The relay's copy loop blocks, ffmpeg blocks on its stdout pipe and stops decoding: no CPU
  is spent ahead of the viewer. A job whose output hasn't moved for 10 minutes (paused tab) is
  killed. The app restarts it at the buffered end when playback resumes.
- **Jobs:** `exec.CommandContext(request ctx)` kills ffmpeg (process group) when the client goes
  away. Each job counts as an active request on its torrent (`acquire`/`release`), so the janitor
  never drops a torrent mid-conversion. `-max-transcodes` (default 1) limits concurrent jobs. A new
  request for the same torrent + file replaces the running job at once (a seek). Any other request
  over the limit gets 429. Shutdown kills all jobs. The last stderr lines go to the log at
  `-debug`, never with the token.
- **Defaults** come from the measurements below: `-transcode-preset veryfast`,
  `-transcode-max-height 720`. On 4 Ampere cores 720p keeps ≥ 2× realtime, which absorbs seeks and
  a slow swarm, and 1080p sources are scaled to 720p. A user with a fast PC can raise both. When
  the buffer runs dry while the relay is converting, the app shows a notice
  `relay-transcode-slow` (lower `-transcode-max-height` or use a faster preset).
- **Output format:** fragmented MP4 goes straight into the existing SourceBuffer. HLS was rejected:
  segment files, a playlist and seek logic on the relay, plus hls.js in Chrome, for nothing MSE
  lacks. MPEG-TS was rejected: MSE doesn't take it, so the app would need a transmuxer.
- **App errors:** `relay-transcode-unavailable` ("your relay can't convert video: install ffmpeg on
  its computer and restart it"), `relay-transcode-busy`, `relay-transcode-failed`, plus the
  notice above. A torrent opened from a `.torrent` file skips the relay (0006). When it needs
  conversion, the app first asks the relay for `metainfo` with the torrent's magnet so that the
  relay joins the swarm.

### 3. How ffmpeg ships: an optional dependency found at runtime

The release binaries stay single static Go binaries (`CGO_ENABLED=0`). Conversion is optional:
`-ffmpeg <path>` / `WEBTOR_RELAY_FFMPEG`, else `ffmpeg` on `PATH`, else next to the binary.
`-no-transcode` turns it off. At startup the relay runs `ffmpeg -hide_banner -encoders` once. It
checks for `libx264` and prints "video conversion: on (ffmpeg 7.x)" or "off: install ffmpeg"
(`winget install ffmpeg`, `brew install ffmpeg`, `apt install ffmpeg`).

- Not bundled in the release assets: +50–80 MB per platform, no official static macOS arm64 build,
  and ffmpeg with libx264 is GPL, so redistributing it carries source-offer duties. The repository
  has no license file yet; that is the owner's call.
- **Container image:** ships ffmpeg. `relay/Dockerfile` copies a pinned static ffmpeg (linux
  amd64/arm64) into the distroless image. ko can't add per-arch files, so `release-relay.sh` first
  builds `ghcr.io/alexeychikk/webtor-relay-base:<ffmpeg version>` with `crane` (pure Go, no Docker
  daemon). It appends the static ffmpeg layer per platform to
  `gcr.io/distroless/static-debian12:nonroot`, joins them in one index, and uses that as ko's
  `defaultBaseImage`.
- **Oracle Cloud deploy:** cloud-init installs `ffmpeg` from Ubuntu's archive (6.1 with libx264).
  On the 1/8-OCPU `E2.1.Micro` fallback shape, `setup.sh` sets `WEBTOR_RELAY_NO_TRANSCODE=1`
  (`nproc` < 2): it can't convert in realtime. User-data can't change after launch, so existing
  VMs get ffmpeg only after destroy + deploy (the `config` tag already says so).

### Extending to WMV, FLV, MPG/VOB, RMVB (not planned)

The relay side already converts anything ffmpeg reads. Those containers would cost what the browser
does for AVI here: track list, duration and audio. Without a browser demuxer, that means a relay
`probe` endpoint (tracks, duration; `ffprobe` or `ffmpeg -i`), relay audio jobs
(`…/transcode/{i}?track=audio:<n>`, AAC), and an app mode where both SourceBuffers are fed from
the relay. About one ticket, plus a fixture per container. MPEG-PS (mpg/vob) could also get a
browser demuxer like this one, but its MPEG-2 video still needs the relay.

## Evidence (spike, 2026-10-19, this sandbox: aarch64, 4 cores, Oracle kernel = A1-class CPU)

- **Demux H.264 AVI into MSE.** The fixture is `e2e/fixtures/avi-h264-mp3.avi` (12 s, H.264 High
  with 2 B-frames, VBR MP3, written by ffmpeg 7.0.2). A 300-line throwaway `AviInputFormat` with the
  duck types above, PTS by POC rank, and one packet per non-empty audio chunk ran through Mediabunny
  1.61.6 `Conversion` to fragmented MP4 in 46 ms. ffmpeg decodes all **288/288 frames
  identically** (framemd5) from the AVI and from our MP4. In Chromium 156 headless: video copied
  and MP3 → Opus into two SourceBuffers, buffered 0–12 s in 0.97 s, playing at readyState 4. A seek
  restart to t = 9.5 (`getKeyPacket` → K = 8, `timestampOffset` = 8) played on. Xvid fixtures open
  with `codec: null` as intended. Gotchas found: ffmpeg writes empty audio chunks (skip them),
  x264's first key packet carries a ~600-byte SEI, and Chromium MSE doesn't accept MP3 in MP4.
- **Relay conversion speed** (ffmpeg 7.0.2 static, libx264, 4 threads, video only, fMP4 to a
  pipe). Input: 60 s from the middle of Big Buck Bunny, as Blender's MS-MPEG4 v2 AVI and re-encoded
  to Xvid (720p 2 Mb/s, 1080p 5 Mb/s):

| Source (60 s)              | Output | Preset    | Speed (× realtime) | Output bitrate |
| -------------------------- | ------ | --------- | ------------------ | -------------- |
| Xvid 720p                  | 720p   | ultrafast | 7.6                | 3.6 Mb/s       |
| Xvid 720p                  | 720p   | superfast | 4.7                | 1.9 Mb/s       |
| Xvid 720p                  | 720p   | veryfast  | **3.4**            | 1.4 Mb/s       |
| Xvid 1080p                 | 1080p  | ultrafast | 2.9                | 8.4 Mb/s       |
| Xvid 1080p                 | 1080p  | superfast | 1.8                | 4.8 Mb/s       |
| Xvid 1080p                 | 1080p  | veryfast  | 1.4                | 3.5 Mb/s       |
| Xvid 1080p                 | 720p   | veryfast  | **2.0**            | 1.6 Mb/s       |
| Xvid 1080p                 | 720p   | superfast | 2.3                | 2.4 Mb/s       |
| MS-MPEG4 v2 720p (Blender) | 720p   | veryfast  | 2.6                | 1.6 Mb/s       |

The first fragment arrives in 0.2–0.8 s from the start. After an input `-ss` into the middle
(GOP 250), it takes 0.4–0.8 s at 720p and 0.9–1.6 s for 1080p → 720p. So a seek on the relay
path costs about one second plus the network. Realtime 1080p output on 4 A1 cores needs
`superfast` or faster: 1.4× at `veryfast` leaves no headroom for the relay's own torrent work.
Hence the 720p cap. Synthetic `testsrc2` sources gave similar speeds at 3–4× the bitrate, so
they are not used for tuning. Scripts: the ticket's hand-off comment.

## Consequences

- AVI with H.264 plays with no relay, and seeking works wherever there is an index. DivX/Xvid AVI
  plays only with a relay that has ffmpeg, at 720p by default.
- We depend on Mediabunny internals and pin its version. Every Mediabunny upgrade runs the AVI unit
  tests first.
- The relay gains an optional runtime dependency and a CPU-heavy endpoint, limited to one job by
  default. Bandwidth is unchanged: the relay downloads the torrent and sends a smaller H.264 stream.
