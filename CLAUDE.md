# webtor

Stream torrents in the browser with **no backend**: paste a magnet → the video plays, with audio-track
and subtitle selection. Everything runs in the tab: WebTorrent (WebRTC peers) → Mediabunny (demux,
remux, audio transcode) → MSE `<video>`. Static site on GitHub Pages.

## Hard limits (say them plainly in UI and docs)

- **Peers must speak WebRTC.** Browsers can't reach TCP/UDP peers, DHT or UDP trackers. Most public
  torrents have zero WebRTC peers and will not start. Web seeds (`ws=`) and `xs=` .torrent URLs
  help. See `docs/decisions/0002-torrent-engine.md`. The opt-in way past this is **`webtor-relay`**
  (`relay/`, Go), a BitTorrent client the user runs themselves. The app uses it as an `xs=` source
  and a web seed (`docs/decisions/0006-regular-peers-relay.md`). The team runs no public relay.
- **Video is never transcoded.** HEVC and 10-bit H.264 play only where the browser decodes them.
  Audio the browser can't play (AC-3, E-AC-3, DTS, Vorbis…) is transcoded in-browser to Opus/AAC.
  TrueHD and bitmap subtitles (PGS) are unsupported.

## Stack

Vite 8 · Svelte 5 (runes) · TypeScript 6 (not 7: svelte-check) · pnpm 12 · Vitest 5 ·
Playwright 1.64 (Chromium). SPA without SvelteKit. Relay: Go (version in `mise.toml`) +
anacrolix/torrent. Decisions: `docs/decisions/` (0001 stack & hosting, 0002 torrent engine, 0003
media pipeline, 0004 subtitles, 0005 manual CI & release, 0006 regular-peers relay, 0007 AVI
playback: own demuxer on Mediabunny internals, relay-side video conversion with ffmpeg, 0008 UI
design system: dark, Lucide icons, every player control inside the player).

## Commands

```sh
pnpm install
pnpm dev            # http://localhost:5173
pnpm check          # svelte-check (types, Svelte)
pnpm test           # vitest unit tests (src/**/*.test.ts)
pnpm test:e2e       # playwright: builds, serves on :4173, starts e2e fixture server (:9000, :8000)
                    #   and the relay stack (:9100, relay :7882; needs Go, first build is slow).
                    #   Projects: chromium runs every spec; firefox + webkit run smoke.spec.ts only
                    #   (`--project=chromium` to skip them; `playwright install firefox webkit` once)
pnpm format         # prettier (CI runs format:check)
pnpm build          # → dist/
pnpm run deploy:pages      # build main and publish dist/ to gh-pages (scripts/deploy-pages.sh)
scripts/release-relay.sh <version> [all|binaries|image|build]   # relay release, see below
scripts/make-fixtures.sh   # regenerate e2e/fixtures/sample.mkv (needs ffmpeg)
scripts/deploy-relay-oci.sh [--destroy] [--dry-run | --print-cloud-init]   # relay on Oracle Cloud, see below
cd relay && go test ./...  # relay checks: gofmt -l . && go vet ./... && go test ./...  (relay/CLAUDE.md)
```

## Checks and release: local only, no GitHub Actions

By the owner's decision CI is **manual-only** (`.github/workflows/ci.yml` has just
`workflow_dispatch`; never add `push`/`pull_request`/`schedule` back, never trigger or wait on runs).
`main` has no required status checks. See `docs/decisions/0005-manual-ci-and-release.md`.

- **Before review / in QA**, run locally: `pnpm format:check && pnpm check && pnpm test && pnpm build`,
  plus `pnpm test:e2e` (always in QA; for the developer when playback or UI changed).
- **Release:** merge the PR, then from an up-to-date, clean `main` (`git checkout main && git pull`)
  run `pnpm run deploy:pages`. It refuses a dirty tree, a branch other than `main` or a `main` that
  differs from `origin/main`; runs `pnpm install --frozen-lockfile && pnpm build`; adds
  `dist/.nojekyll`; and force-pushes `dist/` as one parentless commit (`deploy: <sha>`) to
  `origin gh-pages`, which GitHub Pages serves at https://alexeychikk.github.io/webtor/. It builds the
  commit with a temporary index, so `main`, the index and the working tree are never touched.

**The one exception: `.github/workflows/deploy-relay-oci.yml`** (`workflow_dispatch` only, input
`action` = deploy|destroy). The owner runs it by hand to deploy webtor-relay to their Oracle Cloud
Always Free account with credentials held in repository secrets, which agents can't read. Agents
never trigger, re-run or watch it, and never add another trigger.

## Relay on Oracle Cloud (`scripts/deploy-relay-oci.sh`)

OCI CLI only (HTTPS, no SSH: the sandbox reaches TCP 80/443 only). Inputs are env vars named like
the repo secrets (script header, `relay/README.md` "Oracle Cloud in one click"). Everything it creates
is named `webtor-relay` and tagged `managed-by=webtor-relay`; lookups use both, so re-runs reuse and
`--destroy` deletes only those. The VM is configured by cloud-init rendered from
`scripts/deploy-relay-oci/` (`setup.sh` → `/usr/local/sbin/webtor-relay-setup`, run on every boot by
`webtor-relay-setup.service`: iptables, `<ip>.sslip.io` host, Caddyfile, latest release checked
against `SHA256SUMS`; `webtor-relay.service`). A re-run reboots the VM, which updates the relay.
User-data can't change after launch: the `config` tag (hash of user-data + SSH key) tells a re-run
when only destroy + deploy applies new settings. Never print `RELAY_TOKEN`: output masks it as
`<RELAY_TOKEN>`, and URLs holding it go to curl via `-K -`, not argv. Checks without credentials:
`shellcheck scripts/deploy-relay-oci.sh scripts/deploy-relay-oci/setup.sh`, `--dry-run` (stand-in
responses; `DRY_RUN_NO_A1=1` simulates "Out of host capacity"), `--print-cloud-init` piped to
`cloud-init schema -c` (cloud-init from its git checkout works), and `actionlint` on the workflow.

## Relay release (manual, no GitHub Actions)

`webtor-relay` (`relay/`) is versioned on its own: tags `relay-v<semver>`. From a clean, pushed
`main`, run `scripts/release-relay.sh <version>`. It builds the web app and embeds it
(`relay/internal/webapp/dist`, placeholder restored on exit), cross-compiles `CGO_ENABLED=0` binaries
for linux/darwin amd64+arm64 and windows/amd64 into `relay/dist/` with the version in
`-ldflags` (checked with `-version`), writes `SHA256SUMS`, and runs `gh release create relay-v<version>
--latest`. Asset names carry no version, so `releases/latest/download/<name>` links (relay README,
the app's relay dialog → `releases/latest`) stay valid. Relay releases must stay the repository's
only "latest" releases. It then pushes `ghcr.io/alexeychikk/webtor-relay:<version>` and `:latest`
(linux amd64+arm64) with `ko` (`relay/.ko.yaml`; no Docker daemon). `relay/Dockerfile` builds the
same image with Docker (context: repository root). Container builds set `main.defaultListen`
(`0.0.0.0:7881`) and `main.defaultDataDir` (`/home/nonroot/webtor-relay`) via `-ldflags`; keep the
two in step. The image push needs a token that can write packages (`ko login ghcr.io`); if it fails
after the binaries are out, run the `image` step alone. Re-releasing a version: `gh release delete
relay-v<version> --cleanup-tag` first.

## Layout

```
src/App.svelte                 shell: input → player
src/styles/tokens.css          design tokens (colour, type, space, radius, motion, player z-layers), ADR 0008
src/lib/torrent/               WebTorrent client, trackers, file classification; memory-store.ts (when OPFS can't write)
  files.ts FileList.svelte     video file list (playable / greyed-out unsupported), pick, picker UI
  webtorrent.d.ts              typings for the WebTorrent API subset we use; extend as needed
src/lib/player/                MSE session, Mediabunny conversions, codec decisions
  types.ts                     contracts between torrent layer, pipeline and UI
  errors.ts                    PlaybackError codes + user-facing copy
  mse-player.ts                Input → per-SourceBuffer Conversion → MSE; back-pressure, seek restart
  controller.svelte.ts         torrent → file pick → MsePlayer; phase/stats/notices for the UI
  codecs.ts buffer.ts watchdog.ts   pure decisions (codec copy/transcode, buffer math, no-peers/stalled)
  codec-extensions.ts          lazy import + register of @mediabunny/ac3, dts, aac-encoder
  PlayerControls.svelte        our control bar (play, seek, time, volume, the one fullscreen icon)
  avi/                         AVI demuxer (ADR 0007): `createAviFormat` = Mediabunny `InputFormat` subclass
                               on its internal demuxer/track-backing API; riff.ts (hdrl, idx1), h264.ts (POC → PTS),
                               audio.ts (re-framing MP3/AC-3/DTS/PCM/AAC), fourcc.ts (codec names for `video-needs-relay`)
  shortcuts.ts                 keyboard shortcuts (key → action, SHORTCUTS for the help); Player.svelte runs them
  StatsPanel.svelte ShareButton.svelte   peers/speed/progress panel; "Copy share link" (`shareUrl`)
src/lib/help/WhyDialog.svelte  "Why won't my torrent play?" (WebRTC-only peers, WebTorrent Desktop, relay);
                               open state in help-dialog.svelte.ts (header button, no-peers/stalled notices)
  fullscreen.ts                capabilities (styled ASS, container/video fullscreen), fullscreen method,
                               own control bar vs native controls (`controlsFor`),
                               ASS styled-vs-text decision; prefixed Fullscreen API glue
src/lib/subtitles/             subtitle sources, parsers and rendering (ADR 0004)
  manager.svelte.ts            selector state; one TextTrack of VTTCues per source; default pick;
                               ASS/SSA → AssOverlay when `assRenderMode` is styled, else its text track
  ass-overlay.ts               JASSUB glue: lazy import, canvas after the <video>, fonts, processChunk
  srt.ts vtt.ts ass.ts         own parsers → SubtitleCue (ass.ts: plain-text fallback of ASS/SSA)
  encoding.ts language.ts tracks.ts   BOM/UTF-8/1251/1252 decode, filename language, default rule
  mkv/                         embedded MKV/WebM subtitles: EBML reader (header, Cues, Attachments),
                               cluster scanner, embedded.ts (selector entries + scan ~30 s ahead of the playhead)
src/lib/torrent/relay.ts       webtor-relay contract: URL check, endpoints, error mapping, stats merge
  relay-client.ts              fetch glue (metainfo, /v1/info, /stats); relay-settings.svelte.ts
  RelayDialog.svelte           settings dialog (setup steps, Test, privacy copy)
relay/                         Go module: cmd/webtor-relay, cmd/tcp-seeder (test seeder), internal/relay
e2e/                           Playwright specs; e2e/support/fixture-server.mjs; e2e/fixtures/
docs/decisions/                ADRs
```

## Conventions

- **UI (ADR 0008).** Dark only; style with the `src/styles/tokens.css` custom properties, never
  literal colours. Icons are Lucide, one module per icon (`@lucide/svelte/icons/<name>`). Every
  icon-only button has an `aria-label` and our tooltip (label + shortcut), no `title`. Player
  controls, menus and states live inside the screen container, so they also work in fullscreen.
- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); shared reactive state in
  `*.svelte.ts` modules, no Svelte 4 stores. Components in PascalCase, modules in kebab-case.
- Import WebTorrent as `import WebTorrent from 'webtorrent/dist/webtorrent.min.js'` (prebuilt browser
  ESM; no Node polyfills). Never import `webtorrent` bare in browser code.
- **Mediabunny is pinned exactly** (`mediabunny`, `@mediabunny/*` at the same version, no `^`): the AVI
  demuxer implements internals. Upgrade all together and keep `src/lib/player/avi/demuxer.test.ts` green.
- AVI scope: idx1-indexed files up to 1 GB, H.264 video (non-H.264 → `video-needs-relay`, naming the
  format). OpenDML and index-less AVIs fail with `unsupported-container`. PTS comes from POC type 0
  ranks within a GOP (open GOPs and POC type 1 are approximated). MP3 is copied as `mp4a.6b`.
- Lazy-load heavy parts: `mediabunny` when the first torrent is added, `@mediabunny/ac3|dts|aac-encoder`
  and `jassub` only when a track needs them.
- Decide capabilities by feature detection (`MediaSource.isTypeSupported`, `canEncodeAudio`,
  `ManagedMediaSource`), never by user-agent.
- Every failure ends in a `PlaybackError` with a code from `errors.ts`, shown as a message. Never
  leave an endless spinner. Add new codes there with their copy.
- Byte ranges: `ByteSource.read(start, end)` uses an exclusive end (Mediabunny). WebTorrent's
  `file.stream({start, end})` uses an inclusive end, and `end: 0` means EOF there.
- Keep codec, track and parser logic in pure functions with Vitest tests. Keep the DOM/MSE glue thin.
- Feature e2e tests use the fixture server. `fixtureMagnet('sample.mkv')` returns a magnet that plays
  with zero peers (`xs=` .torrent + `ws=` web seed). For real WebRTC, seed from a second page with
  `client.seed(...)` announcing to `ws://127.0.0.1:8000`. Every file in `e2e/fixtures/` is served
  this way automatically.
- e2e can shrink the 60 s back-pressure window with `localStorage['webtor:buffer-ahead-s']` (set it
  in `page.addInitScript`) so the 12 s fixture exercises back-pressure and seek restarts.
- **Files.** `#magnet=<encoded>&file=<n>`: `n` is the index into `torrent.files` of the file playing
  (`readFileFromHash`; an unplayable or missing `n` falls back to the largest playable video). The
  hash follows the controller (`magnet`, `fileIndex`) with `replaceState`. `controller.selectFile(n)`
  destroys the MsePlayer and subtitle sources and opens a new one on the same torrent; after a fatal
  error it reloads the torrent on that file. An opened/dropped `.torrent` (`TorrentInput` =
  `Uint8Array`) goes straight to WebTorrent (no relay); its `magnetURI` then goes into the hash.
- UI test hooks: `data-testid` `file-list` / `file` (`data-index`, `data-kind`, `aria-current`; shown
  only with 2+ video files), `torrent-file` (the .torrent input), `video`, `status` (with `data-phase`), `error` and `notice` (with
  `data-code` = the `PlaybackErrorCode`), `audio-track` (the audio `<select>`), `subtitles` (the
  `<select>`; values `sidecar:<file index>`, `upload:<n>`, `""` = Off), `subtitle-upload` (file
  input), `screen` (the container our fullscreen button, the `f` shortcut and a double-click on the
  video fullscreen), `controls` (our control bar; class `shown`) with `play-pause`, `seek`, `time`,
  `mute`, `volume` and `fullscreen` (the icon button, `aria-pressed`, `aria-label` "Fullscreen" /
  "Exit fullscreen"; none of these exist on iOS or without fullscreen: native controls there) and `ass-canvas` (the JASSUB overlay; exists only while
  an ASS track is drawn styled). Read its pixels with `drawImage` onto a 2D canvas after a paused
  seek. The video carries `data-audio-codec` (Mediabunny codec fed to MSE: `aac`, `opus`…; empty
  when muted) and `data-audio-track` (the selected `AudioTrackInfo.id`). Polish hooks: `why-button`
  (header), `why-link` (in no-peers/stalled notices), `why-dialog`, `why-relay`; `stats` with
  `stats-peers`, `stats-download`, `stats-upload`, `stats-progress`; `share-link` (`data-state`
  `idle|copied|failed`; `share-url` shows the link when the clipboard is denied); `shortcuts-help`;
  `subtitle-delay` (`data-delay` in s), `subtitle-delay-minus|plus|reset`. Check shown cues through
  `video.textTracks` (`mode === 'showing'`, `activeCues`) after a paused seek.
- Embedded MKV tracks are `embedded:<TrackNumber>` (sample.mkv: `embedded:4` "English · SRT",
  `embedded:5` "Russian · ASS"). Their cues stream in: `SubtitleManager.addEmbedded` lists them,
  `appendCues` adds what the scanner finds, and the scanner runs only while one is selected.
- New subtitle sources plug into `SubtitleManager`: list a
  `SubtitleTrackInfo` (key `<kind>:<id>`) with a loader for its cues; the selector groups by `kind`.
- **Styled ASS/SSA (JASSUB 2.5).** A source is styled when it has an `assScript`: the whole file
  (sidecar/upload) or the track's CodecPrivate header (embedded, `assHeaderOf`). Embedded cues carry
  the raw block in `SubtitleCue.assChunk`, fed to libass with `renderer.processChunk` (it skips
  duplicates by ReadOrder). Every ASS source also gets its plain-text TextTrack, shown instead of the
  canvas on iOS (no container fullscreen), while the bare `<video>` is fullscreen, or after JASSUB
  failed. The default font (Liberation Sans, metric-compatible with Arial) is preloaded in `fonts`:
  a font fetched on demand isn't drawn until the next video frame, which never comes while paused.
  `queryFonts: false` (no local-font prompts, no Google Fonts). Single-threaded without COOP/COEP.
  JASSUB uses `requestVideoFrameCallback` `mediaTime` (element timeline), like the text tracks.
  The remembered choice is `localStorage['webtor:subtitle-language']` (a language code or `off`).
  **Subtitle delay** (`SubtitleManager.delay`, ±0.5 s, reset per file) re-fills the showing track
  with `shiftCues` (pure, `cue.ts`); embedded tracks refill from `source.live`, and `appendCues` shifts
  new cues by the track's delay. The JASSUB overlay gets unshifted events and renders with
  `timeOffset = −delay` (`AssOverlay.setDelay`). Any renderer must draw cues shifted by it. Note: a disabled
  `TextTrack` returns `cues === null`, so `clearTrack` unhides it before removing cues.
- Keyboard shortcuts (`shortcuts.ts`) are ignored in form controls, buttons, links, dialogs and with
  Ctrl/Meta/Alt; they act only while a file is open (not idle/error). On our control bar
  (`[data-player-controls]`) they work, except arrows on its sliders. Player.svelte handles them in
  the window's capture phase (preventDefault + stopPropagation, keyup of a handled Space too, no
  auto-repeat except seeks), so a focused button or native control never toggles a second time.
- **Player controls (ADR 0004).** Where the container can go fullscreen (`controlsFor` = `own`), the
  `<video>` has no `controls`: `PlayerControls.svelte` sits below the picture, and over it in
  fullscreen (text cues are lifted above it via `::-webkit-media-text-track-container`). While
  playing, the bar and cursor hide 1 s after the pointer rests (3 s after a touch), at once when it
  leaves the player or window; any move, touch or key shows them; kept while paused or with the
  pointer on the bar. Hidden = `visibility: hidden` (Playwright `toBeHidden`). No "Exit fullscreen"
  text anywhere (aria-label/title only). Click on the video = play/pause, double-click =
  fullscreen. iOS (video-only fullscreen) and pages without fullscreen keep the native controls.
- AVI fixtures (ADR 0007): `avi-h264-mp3.avi` (12 s 640×360 H.264 High with B-frames + VBR MP3; plays
  in the browser), `avi-xvid-mp3.avi` and `avi-xvid-ac3.avi` (12 s 320×180 Xvid; need the relay).
- `sample.mkv`: 12 s 640×360 H.264 · audio 1 "English AAC" (eng, default) · audio 2 "Russian AC3" (rus) ·
  subtitles SRT (eng) and ASS (rus). `sidecar.en.srt` is a standalone SRT.
- A directory in `e2e/fixtures/` is served as a multi-file torrent named after it (web seed = the
  server root). `with-sidecar/` = `sample.mkv` + `sidecar.en.srt` (symlinks to the top-level files).
- `multi-file/` = `episode-1.ts` (→ offset.ts, file 0) + `episode-2.mkv` (→ sample.mkv, file 1,
  largest) + `extras.wmv` (fake, unsupported) + `readme.txt`. `<FIXTURE_BASE>/<name>.torrent` is the
  .torrent for any fixture (for upload tests).
- `offset.ts`: 10 s 320×180 H.264 + AAC MPEG-TS whose first frame is at ~1.4 s. The player maps
  every file onto a 0-based element timeline (`src/lib/player/timeline.ts`): `timestampOffset =
k − startTime`, seeks look up the keyframe at `t + startTime`. Small holes in front of the
  playhead are skipped (`gapJumpTarget`), because the browser waits on any gap forever.
- **Audio switch keeps the old track buffered** (ADR 0003): never `remove()` audio ahead of the
  playhead to make room for a new track. The new pipeline's first fragment can take seconds
  (transcoder start), and an empty buffer stalls the element. Let the new appends overwrite it.
  Back-pressure then follows `Pipeline.writtenTo`, not `sb.buffered`. The e2e asserts no
  _underrun_ (`waiting` with < 0.5 s buffered). A busy machine can fire a `waiting` with seconds
  buffered, which says nothing about the player.
- **Relay (opt-in, ADR 0006).** The setting is `localStorage['webtor:relay-url']` (normalised base);
  `#relay=<url>` (the relay's printed Open link) saves it and is stripped with `replaceState`. With a
  relay set, the controller fetches `metainfo` from the relay, then `client.add(bytes, {announce,
urlList: [webseed]})`; `/stats` is polled every 2 s and merged into the peer count. No relay set =
  the original path, untouched. Never log or show the relay URL: the token is a password.
- Relay e2e: `relayStack()` (e2e/support/fixtures.ts) returns a magnet that only a TCP seeder on
  loopback has (no `xs=`/`ws=`) and the URL of a webtor-relay that reaches it
  (`e2e/support/relay-stack.mjs`, builds both Go commands). Relay test hooks: `relay-button`,
  `relay-dialog`, `relay-url`, `relay-test` (`data-state`), `relay-peers`.
- Web seeds need CORS that allows the `Range` and `Cache-Control` request headers (WebTorrent sends
  both).
