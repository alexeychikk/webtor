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
design system: dark, Lucide icons, every player control inside the player, 0009 per-video watch
state: remembered tracks and resume).

## Commands

```sh
pnpm install
pnpm dev            # http://localhost:5173
pnpm check          # svelte-check (types, Svelte)
pnpm test           # vitest unit tests (src/**/*.test.ts)
pnpm test:e2e       # playwright: builds, serves on :4173, starts e2e fixture server (:9000, :8000)
                    #   and the relay stack (:9100, relay :7882; needs Go, first build is slow).
                    #   Projects: chromium runs every spec; firefox runs smoke.spec.ts, webkit smoke + seek-end + seek-tail + start-stress
                    #   (`--project=chromium` to skip them; `playwright install firefox webkit` once)
pnpm format         # prettier (CI runs format:check)
pnpm build          # → dist/
pnpm run deploy:pages      # build main and publish dist/ to gh-pages (scripts/deploy-pages.sh)
scripts/release-relay.sh <version> [all|binaries|image|build]   # relay release, see below
scripts/make-fixtures.sh   # regenerate e2e/fixtures/sample.mkv (needs ffmpeg)
node scripts/make-icons.mjs   # public/favicon-32.png + apple-touch-icon.png from public/favicon.svg (Playwright)
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
(`relay/internal/webapp/dist`, placeholder restored on exit), cross-compiles `CGO_ENABLED=0`
binaries for linux/darwin amd64+arm64 and windows/amd64 into `relay/dist/` with the version in
`-ldflags` (checked with `-version`), writes `SHA256SUMS`, and runs `gh release create
relay-v<version> --latest`. Asset names carry no version, so `releases/latest/download/<name>` links
(relay README, the app's relay dialog → `releases/latest`) stay valid. Relay releases must stay the
repository's only "latest" releases. It then pushes the base
`ghcr.io/alexeychikk/webtor-relay-base:<ffmpeg version>` (distroless + the static ffmpeg pinned in
`scripts/relay-ffmpeg.sh`, one layer per arch, joined with `crane`) and, on it,
`ghcr.io/alexeychikk/webtor-relay:<version>` and `:latest` (linux amd64+arm64) with `ko`
(`relay/.ko.yaml`; no Docker daemon), then smoke-tests the exported image (`transcode.available`).
`scripts/release-relay.sh <version> image --dry-run` does all that against a throwaway loopback
registry (no login). `relay/Dockerfile` builds the same image with Docker (context: repository
root). ffmpeg is GPL: it ships as a separate executable with `/licenses/ffmpeg/`, never in the
release binaries. Container builds set `main.defaultListen` (`0.0.0.0:7881`) and
`main.defaultDataDir` (`/home/nonroot/webtor-relay`) via `-ldflags`; keep the two in step. The image
push needs a token that can write packages (`ko login ghcr.io`, which crane reads too); if it fails
after the binaries are out, run the `image` step alone. Re-releasing a version: `gh release delete
relay-v<version> --cleanup-tag` first.

## Layout

```
src/App.svelte                 shell: hero (phase idle: mark, tagline, pill input) → watch (64 px header, player);
                               paste-to-play, page-wide .torrent drop, wordmark = home (stops, clears the hash)
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
  append.ts                    appendBuffer with back-pressure: QuotaExceededError waits, never fails (ADR 0003)
  codec-extensions.ts          lazy import + register of @mediabunny/ac3, dts, aac-encoder
  remote-video.ts              relay-converted video (ADR 0007 §2): RemoteVideo, MIME, slow/resume rules
  PlayerControls.svelte        control layer over the picture: scrims, title strip, seek bar (track, downloaded,
                               buffered, played; hover time), play, volume, time, the one fullscreen icon
  PlayerStates.svelte states.ts   in-player states (ADR 0008): error card (Retry, relay CTA),
                               no-peers card (spinner keeps going), toasts (hide with the controls, dismissable);
                               `playerStates`/`errorActions` are the pure rules, titles in `PLAYBACK_ERROR_TITLES`
  PlayerCentre.svelte centre.ts   centre of the picture: play/pause/replay circle, toggle flash, loading/buffering
                               spinner, touch ±5 s (`centreState` is the pure rule)
  media-state.svelte.ts seek.ts   `<video>` state as runes; `downloadedRanges` (piece bitfield → file fractions)
  avi/                         AVI demuxer (ADR 0007): `createAviFormat` = Mediabunny `InputFormat` subclass
                               on its internal demuxer/track-backing API; riff.ts (hdrl, idx1), h264.ts (POC → PTS),
                               audio.ts (re-framing MP3/AC-3/DTS/PCM/AAC), fourcc.ts (codec names for `video-needs-relay`)
  shortcuts.ts                 keyboard shortcuts (key → action, SHORTCUTS for the help); Player.svelte runs them
  AudioMenu.svelte StatsPanel.svelte MoreMenu.svelte   menu contents (audio-options.ts: option text)
  share-link.svelte.ts         "Copy share link" state (`shareUrl`, idle/copied/failed)
src/lib/ui/IconButton.svelte   icon-only button + our tooltip (400 ms hover / focus-visible, kbd chip, clamped
                               to `[data-tooltip-bounds]`, hidden with the controls); tooltip-context.ts
  page-dialog.ts               `showPageDialog`: leave fullscreen, then `showModal()` (help, relay dialogs)
  menu.ts Menu.svelte          player menus: panel (inside the screen) or bottom sheet, listbox keys
src/lib/help/WhyDialog.svelte  "Why won't my torrent play?" (WebRTC-only peers, WebTorrent Desktop, relay;
                               last section: keyboard shortcuts, opened scrolled there by `?`);
                               open state in help-dialog.svelte.ts (header button, no-peers/stalled notices)
  fullscreen.ts                capabilities (styled ASS, container/video fullscreen), fullscreen method,
                               `controlsFor` (always `own` now: no native controls anywhere),
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
- AVI scope: H.264 video (non-H.264 → `video-needs-relay`, naming the format). Indexes (`avi/index.ts`):
  OpenDML `indx` → `ix##` (any number of `RIFF AVIX`) wins over `idx1`; each `ix##` loads lazily, in
  order, when reads or seeks reach it. No usable index (no `AVIF_HASINDEX`/`idx1`, entries outside
  `movi`, truncated file) → `movi` scan while playing, notice `avi-no-index`, `MsePlayer` clamps
  seeks to `AviDemuxer.seekLimit()`, duration from the headers. Backings keep growing tables
  (`sync`/`growUntil`); scan-mode lookups by time never scan ahead. PTS comes from POC type 0 ranks
  within a GOP (open GOPs and POC type 1 are approximated). MP3 is copied as `mp4a.6b`.
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
  `localStorage['webtor:sb-quota-bytes']` gives every SourceBuffer a Safari-like byte quota
  (`simulateQuota`: 5 % of it until an init segment went in, like WebKit; hits counted in
  `window.__webtorQuotaHits`, and in the video's `data-quota-hits` and the stats panel's
  `stats-buffer` with `data-ahead`/`data-target`/`data-quota-hits` for real quotas too).
  `QuotaExceededError` is back-pressure, never a failure (ADR 0003): keep every append going
  through `appendChunk`, which sends an init segment alone and the rest in pieces (WebKit's
  pre-init 5 % was the iPad failure). Any pipeline's `relieve()` may `remove()` on another's
  SourceBuffer at any await, so every `remove`/`abort`/`changeType`/`timestampOffset` goes through
  `whenIdle` (`resetFrom`, `startAt` in `append.ts`): check idle and stale, then write in one task.
- Icons live in `public/` (`favicon.svg` = the header mark; PNGs rendered by `scripts/make-icons.mjs`),
  linked from `index.html` with root paths that Vite rewrites to the relative base.
- **Files.** `#magnet=<encoded>&file=<n>`: `n` is the index into `torrent.files` of the file playing
  (`readFileFromHash`; an unplayable or missing `n` falls back to the largest playable video). The
  hash follows the controller (`magnet`, `fileIndex`) with `replaceState`. `controller.selectFile(n)`
  destroys the MsePlayer and subtitle sources and opens a new one on the same torrent; after a fatal
  error it reloads the torrent on that file. An opened/dropped `.torrent` (`TorrentInput` =
  `Uint8Array`) goes straight to WebTorrent (no relay); its `magnetURI` then goes into the hash.
- UI test hooks: `data-testid` `torrent-file` (the .torrent input), `video`, `status` (sr-only live
  region "<phase> · <file name>", with `data-phase`), `error` and `notice` (with `data-code` = the
  `PlaybackErrorCode`), `subtitle-upload` (hidden file input, always in the screen), `screen` (the
  container our fullscreen button, the `f` shortcut and a double-click on the video fullscreen),
  `title` (file name, top strip), `controls` (our control bar; class `shown`) with `play-pause` (not
  on touch), `seek` (`seek-downloaded`, `seek-buffered`: one child per range; `seek-hover` time
  chip), `time`, `mute`, `volume` and `fullscreen` (the icon button, `aria-pressed`, `aria-label`
  "Fullscreen" / "Exit fullscreen"; absent without any fullscreen), `tooltip` (inside an icon button
  while shown), `centre` (`data-state` `loading|buffering|play|pause|replay|none`) with
  `centre-button` and, on touch, `seek-back` / `seek-forward`, `seek-streak` (double-tap overlay),
  and `ass-canvas` (the JASSUB overlay; exists only while an ASS track is drawn styled). Read its pixels with `drawImage` onto a 2D canvas
  after a paused seek. The video carries `data-audio-codec` (Mediabunny codec fed to MSE: `aac`,
  `opus`…; empty when muted) and `data-audio-track` (the selected `AudioTrackInfo.id`). Polish
  hooks: `why-button` (header), `why-link` (in no-peers/stalled notices), `why-dialog`, `why-relay`;
  `shortcuts-help` (last section of the help dialog; `?` opens it, also while idle). States: `error`
  is the card (`role=alert`) with `retry` (same file again) and "Relay settings"/"Set up a relay";
  `notice[data-code=no-peers]` is a card, every other notice a toast (`role=status`, `notice-dismiss`)
  that hides with the controls: assert toasts with `toBeAttached`/`toContainText` while playing.
  Drops: `page-drop` (a .torrent anywhere outside the player) and `drop-overlay` (on the player:
  subtitles or a .torrent). Dialogs (`page-dialog`, `src/lib/ui/page-dialog.ts`) leave fullscreen
  before `showModal()`. Check shown cues through `video.textTracks` (`mode === 'showing'`,
  `activeCues`) after a paused seek.
- **Menu hooks (ADR 0008 §4).** Bar triggers (`aria-haspopup`, `aria-expanded`): `subtitles`
  (`data-value`: `sidecar:<file index>`, `upload:<n>`, `""` = Off), `audio-track` (`data-value` = track
  id), `files-button` (2+ video files), `stats-button` (chip), `share-link` (`data-state`
  `idle|copied|failed`); under 40rem of player width `more-button` replaces audio/files/stats/share.
  Menus exist only while open, one at a time, as `[data-player-menu]` with `data-presentation`
  `panel|sheet` (`menuPresentation`, `src/lib/ui/menu.ts`; `Menu.svelte`): `subtitles-menu`
  (`subtitle-option` with `data-value`/`data-kind`, `subtitles-loading`, `subtitle-delay`
  (`data-delay` in s), `subtitle-delay-minus|plus|reset`), `audio-menu` (`audio-option`,
  `data-value`, accessible name `audioOptionText`), `files-panel` (`file-list` / `file` with
  `data-index`, `data-kind`, `aria-current`), `stats-panel` (`stats` with `stats-peers`,
  `relay-peers`, `stats-download`, `stats-upload`, `stats-buffer`, `stats-progress`), `share-panel` (`share-url`,
  only after a refused copy), `more-menu` (`more-sound`, `more-audio|files|stats`, `share-link`). In
  e2e use `e2e/support/player.ts`: `openMenu(page, trigger)`, `closeMenu`, `selectSubtitle` /
  `selectAudio(page, {label} | {value})`, `subtitleGroup`.
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
  **Per-video watch state (ADR 0009, `watch-state.ts`)**: `localStorage['webtor:watch:<infohash>:<path>']`
  keeps the user's audio track, subtitle track (or Off), delay and position (uploads ≤ 1 M chars, ≤ 1.5 M all
  together, in `webtor:watch-upload:…`); it wins over the language preferences, which stay the fallback. Resume
  starts the pipelines at the keyframe before the saved position (`MsePlayer` `startAt`), not under
  10 s or in the last 5 % (≤ 60 s); toast `resume-toast` with `start-over`.
  **Subtitle delay** (`SubtitleManager.delay`, ±0.5 s, reset per file) re-fills the showing track
  with `shiftCues` (pure, `cue.ts`); embedded tracks refill from `source.live`, and `appendCues` shifts
  new cues by the track's delay. The JASSUB overlay gets unshifted events and renders with
  `timeOffset = −delay` (`AssOverlay.setDelay`). Any renderer must draw cues shifted by it. Note: a disabled
  `TextTrack` returns `cues === null`, so `clearTrack` unhides it before removing cues.
- Keyboard shortcuts (`shortcuts.ts`) are ignored in form controls, buttons, links, dialogs and with
  Ctrl/Meta/Alt; they act only while a file is open (not idle/error). On our control bar
  (`[data-player-controls]`) they work, except arrows on its sliders. Player.svelte handles them in
  the window's capture phase (preventDefault + stopPropagation, keyup of a handled Space too, no
  auto-repeat except seeks and volume), so a focused button or native control never toggles a second time. Inside an open menu
  (`[data-player-menu]`) only the menu handles keys: Esc closes it first (focus back on the
  trigger), and Enter/Space/↓ on an `aria-haspopup` trigger open it. An open menu pins the controls.
- **Player controls (ADR 0004, 0008).** The `<video>` never has `controls`: `PlayerControls.svelte`
  overlays the picture, windowed and fullscreen (text cues are lifted above it via
  `::-webkit-media-text-track-container`). `shown = !playing || menuOpen || pointerOnControls ||
activity`: any move, key or touch shows them for `hideDelay` (`auto-hide.ts`: `HIDE_DELAY_MS` 5 s
  windowed; in fullscreen 1 s, 3 s after a touch; a fullscreen change re-times the running timer),
  leaving the player or window hides them at once; focus does not keep them. Touch (and pen): a tap
  on the picture toggles them (never play/pause; play/pause and ±5 s sit in the centre).
  **Double-tap seek** (`touch-seek.ts`, pure `onTap`): a double-tap (2nd tap ≤ `DOUBLE_TAP_MS` 300 ms)
  on the left/right third seeks −/+5 s; each further same-side tap ≤ `SEEK_STREAK_MS` 700 ms after
  the last doubles the step (10, 20, 40 s…, ≤ 5 min); the other side mid-streak starts a new 5 s
  streak there. A first side tap waits 300 ms before acting as a plain tap (no flicker); seek taps
  are summed and sent as one `currentTime` write `SEEK_COALESCE_MS` after the last; a side
  double-tap's `dblclick` is ignored (the middle's still fullscreens). Overlay `seek-streak`
  (`data-side` `back|forward`, `data-total` s). The screen has `touch-action: manipulation`.
  Hidden = opacity 0, then `visibility: hidden` (Playwright `toBeHidden`), no pointer events, `cursor: none`. No "Exit
  fullscreen" text anywhere (aria-label/tooltip only). Click on the picture = play/pause,
  double-click = fullscreen; while paused the centre button covers the middle, so e2e clicks the
  picture at an offset (`{ position: { x: 80, y: 120 } }`). iPhone (video-only fullscreen): the same
  controls, the fullscreen icon calls `webkitEnterFullscreen`; no fullscreen at all = no icon.
  Under 40rem of player width (container query `screen`) the bar is compact.
- AVI fixtures (ADR 0007): `avi-h264-mp3.avi` (12 s 640×360 H.264 High with B-frames + VBR MP3; plays
  in the browser), `avi-h264-noidx.avi` (the same without `idx1`: the scan path), `avi-xvid-mp3.avi`
  and `avi-xvid-ac3.avi` (12 s 320×180 Xvid; need the relay). Synthetic RIFFs (OpenDML, AVIX, `rec `,
  truncation) are built in `src/lib/player/avi/index.test.ts`.
- `short-audio.mkv`: 12 s 320×180 H.264 whose audio tracks ("English AAC", "Russian AC3") end at 6 s.
- `sample.mkv`: 12 s 640×360 H.264 · audio 1 "English AAC" (eng, default) · audio 2 "Russian AC3" (rus) ·
  subtitles SRT (eng) and ASS (rus). `sidecar.en.srt` is a standalone SRT.
- A directory in `e2e/fixtures/` is served as a multi-file torrent named after it (web seed = the
  server root). `with-sidecar/` = `sample.mkv` + `sidecar.en.srt` (symlinks to the top-level files).
- `multi-file/` = `episode-1.ts` (→ offset.ts, file 0) + `episode-2.mkv` (→ sample.mkv, file 1,
  largest) + `extras.wmv` (fake, unsupported) + `readme.txt`. `<FIXTURE_BASE>/<name>.torrent` is the
  .torrent for any fixture (for upload tests).
- `resume/` = `movie.mkv` (40 s 320×180; audio "English AAC" + "Russian AC3"; subtitles `embedded:4`
  "English", `embedded:5` "English SDH", `embedded:6` "Russian") + `extra.mkv` (→ sample.mkv).
- `offset.ts`: 10 s 320×180 H.264 + AAC MPEG-TS whose first frame is at ~1.4 s. The player maps
  every file onto a 0-based element timeline (`src/lib/player/timeline.ts`): `timestampOffset =
k − startTime`, seeks look up the keyframe at `t + startTime`. Small holes in front of the
  playhead are skipped (`gapJumpTarget`), because the browser waits on any gap forever.
- **The end of the media (WebKit/GStreamer, `e2e/seek-end.spec.ts` on Chromium + WebKit).** GStreamer
  (Playwright WebKit; iPad Safari uses AVFoundation, unverified) fails seeks near an EOS, so:
  - A seek at or past the last frame never restarts (`MsePlayer.seekNeedsRestart`, `bufferedToEnd`):
    a pipeline that appended through the end (`done`), its last range reaching the duration, has
    nothing left to append. A restart (remove + re-append the last GOP into an `ended`
    MediaSource) is fatal there ("Failed to push buffer"). The debounced restart re-checks: the
    seek wakes the appends, and they can reach the end within `SEEK_DEBOUNCE_MS`.
  - `endOfStream()` waits for the playhead: appends done and, while playing, `EOS_AHEAD_S` (0.1 s)
    before the end of the buffered media, on a timer armed by `timeupdate` (`armEndOfStream`,
    `endOfStreamIn`); else at a stall or a seek there (`maybeEndOfStream`, `atBufferedEnd`).
    Called as soon as the appends were done, GStreamer drained the EOS through its decoder in the
    last ~0.3 s, and any seek after that failed ("No valid frames decoded before end of stream") or
    froze. Called only at the stall, GStreamer resumes its paused pipeline asynchronously; a short
    tail (audio past the last video frame) can end the element first, and WebKit then replays from 0
    (`mediaPlayerPlaybackStateChanged` → `playInternal` on an ended element; ~1 run in 12).
  - A seek into the last `END_SNAP_S` (0.25 s, counted from where the video ends if that is
    earlier), short of `duration`, goes back to its start (`endSnap`): GStreamer drops every frame
    of a segment past the last frame's start, then errors at the EOS. A seek to `duration` (or
    past it) stays and just ends the video.
  - Our controls (keys, double-tap, centre ±5 s, seek bar) go through `seekVideo`, which skips a
    seek to the end while the video is there already (`endSeekRedundant`: ended, last moment,
    seeking there). A script setting `currentTime` to the end again and again can still hit it.
  - Between `endOfStream()` and `ended` (≤ `EOS_AHEAD_S` of media while playing) GStreamer can't
    seek at all: its decoder drained the EOS, so any seek errors ("No valid frames decoded before
    end of stream") or never completes, reopened MediaSource or not. `MsePlayer` puts an own
    `currentTime` accessor on the element (`interceptSeeks`; every write, ours or a script's, passes
    it before the element queues the seek, and `seeking` comes too late). It holds a seek made in
    that window until `ended` (`holdSeek`; a paused element plays the rest to get there, at most
    `HELD_SEEK_MAX_MS`), then runs it and plays on if it was playing (`releaseSeek`). Any other
    seek on an ended MediaSource reopens it first (`reopen`: `remove()` of nothing past the end);
    the stream ends again at the end.
  - **A track that ends early** (audio shorter than the video; `e2e/seek-tail.spec.ts`,
    `short-audio.mkv`). A conversion trimmed past its track's last packet outputs media the browser
    rejects, which emptied the element: a (re)start past it begins 1 s before the track's end
    (`startOf`, `trackStart`; `Pipeline.end`). After the track's last media the pipeline appends
    silence up to the duration (`fillSilence`), because GStreamer can't seek where one
    SourceBuffer has no samples, even after `endOfStream()` stretched its ranges. Copied AAC-LC gets
    silent frames under its own decoder config (`silence.ts`): another init segment (e.g. from
    an encoder) is a caps change that hangs a paused seek there. Other codecs are encoded
    (`silencePlans`: the same codec and layout, else `changeType` to the transcode target).
    Without either, the pipeline just ends (`trackEndedBefore`): MSE stretches its last range
    once the stream ends, which Chromium plays.
- **The start (WebKit/GStreamer, `e2e/start-stress.spec.ts`).** WebKit places a B-frame H.264
  video's fMP4 (Mediabunny writes trun v1 with negative composition offsets) ~2 frames (0.084 s)
  after its `timestampOffset`; Chromium places it at 0. The audio starts at 0, so the start needs a
  gap-jump seek, and ~1 open in 20–50 never gets `seeked` (re-seeking, nudging, pause/play don't
  help), errors, or blocks the page's main thread. It happens whenever the jump is made: before
  the metadata, after it with the audio held back, or with both buffered. A new MediaSource on the
  same element nearly always starts. So:
  - The other pipelines append only their init segments (also when a chunk is nothing else,
    `initSegmentBytes`) until the video's first media is in and the jump is issued (`startGate`,
    ≤ 5 s). The jump waits for `loadedmetadata`: a `currentTime` write before it is a seek inside
    WebKit's own load, and WebKit's `buffered` then ignores a SourceBuffer without media.
    `jumpGap` never runs before the metadata or while the gate is closed (it would seek without
    `initialSeek`, and `onSeeking` would restart every pipeline).
  - A seek still pending after every SourceBuffer holds its target (`START_STUCK_SEEK_MS` 1.5 s
    for the start's jump, else `STUCK_SEEK_MS` 4 s) makes the controller open the file again at
    that time in a new MsePlayer (`onStuckSeek` → `reopenFile`), up to `MAX_REOPENS` (3) in a
    row, then `playback-failed` (Retry). A reopened player that completes a seek or plays on ends
    the row (`nextReopen`, `watchdog.ts`).
  - Removing the shift instead (re-append the video earlier) makes the video end before the audio,
    and GStreamer then fails a seek to `duration` ("No valid frames decoded before end of
    stream"); `endSnap` would have to cover that.
  - Stress check: `STRESS_OPENS=120 pnpm exec playwright test --project=webkit start-stress`
    (prints the log of every open that needed a reopen).
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
- Relay e2e: `relayStack()` (e2e/support/fixtures.ts) returns magnets that only a TCP seeder on
  loopback has (no `xs=`/`ws=`): `magnet` (sample.mkv), `aviMagnet` (avi-xvid-ac3.avi), plus
  `relayUrl` (a webtor-relay that reaches it) and `noTranscodeRelayUrl` (same, `-no-transcode`)
  (`e2e/support/relay-stack.mjs`, builds both Go commands). The relays find ffmpeg through
  `WEBTOR_RELAY_FFMPEG` or `PATH`; without it the conversion spec skips. Relay test hooks:
  `relay-button` (aria-label "Connect a relay" / "Relay: on", `data-active`), `relay-dialog`, `relay-url`, `relay-test` (`data-state`), `relay-peers`,
  `relay-transcode` (`data-available`).
- **Relay video conversion (ADR 0007 §2).** An AVI whose video codec is null (DivX/Xvid) plays
  only with a relay whose `/v1/info` has `transcode.available`: `MsePlayer`'s video pipeline then
  streams the relay's `transcode` fMP4 into the video SourceBuffer (`remote-video.ts`), and audio
  and subtitles stay local. A seek aborts the fetch and requests `?start=t` (element time,
  `timestampOffset` from `appendOffset`, no keyframe lookup). An opened .torrent is POSTed to the
  relay's `metainfo` first. A transcode 404 "torrent not added" (relay restart, idle drop) registers
  the torrent again (magnet GET / .torrent POST) and retries once. `relay-transcode-slow` counts its
  5 s warm-up from the relay's answer, not the request (headers wait for ffmpeg's first bytes).
- Web seeds need CORS that allows the `Range` and `Cache-Control` request headers (WebTorrent sends
  both).
