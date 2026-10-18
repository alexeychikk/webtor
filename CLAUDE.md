# webtor

Stream torrents in the browser with **no backend**: paste a magnet → the video plays, with audio-track
and subtitle selection. Everything runs in the tab: WebTorrent (WebRTC peers) → Mediabunny (demux,
remux, audio transcode) → MSE `<video>`. Static site on GitHub Pages.

## Hard limits (say them plainly in UI and docs)

- **Peers must speak WebRTC.** Browsers can't reach TCP/UDP peers, DHT or UDP trackers. Most public
  torrents have zero WebRTC peers and will not start. Web seeds (`ws=`) and `xs=` .torrent URLs
  help. See `docs/decisions/0002-torrent-engine.md`.
- **Video is never transcoded.** HEVC and 10-bit H.264 play only where the browser decodes them.
  Audio the browser can't play (AC-3, E-AC-3, DTS, Vorbis…) is transcoded in-browser to Opus/AAC.
  TrueHD and bitmap subtitles (PGS) are unsupported.

## Stack

Vite 8 · Svelte 5 (runes) · TypeScript 6 (not 7: svelte-check) · pnpm 12 · Vitest 5 ·
Playwright 1.64 (Chromium). SPA without SvelteKit. Decisions: `docs/decisions/` (0001 stack & hosting,
0002 torrent engine, 0003 media pipeline, 0004 subtitles).

## Commands

```sh
pnpm install
pnpm dev            # http://localhost:5173
pnpm check          # svelte-check (types, Svelte)
pnpm test           # vitest unit tests (src/**/*.test.ts)
pnpm test:e2e       # playwright: builds, serves on :4173, starts e2e fixture server (:9000, :8000)
pnpm format         # prettier (CI runs format:check)
pnpm build          # → dist/
pnpm run deploy:pages      # build main and publish dist/ to gh-pages (scripts/deploy-pages.sh)
scripts/make-fixtures.sh   # regenerate e2e/fixtures/sample.mkv (needs ffmpeg)
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

## Layout

```
src/App.svelte                 shell: input → player
src/lib/torrent/               WebTorrent client, trackers, file classification
  webtorrent.d.ts              typings for the WebTorrent API subset we use; extend as needed
src/lib/player/                MSE session, Mediabunny conversions, codec decisions
  types.ts                     contracts between torrent layer, pipeline and UI
  errors.ts                    PlaybackError codes + user-facing copy
  mse-player.ts                Input → per-SourceBuffer Conversion → MSE; back-pressure, seek restart
  controller.svelte.ts         torrent → file pick → MsePlayer; phase/stats/notices for the UI
  codecs.ts buffer.ts watchdog.ts   pure decisions (codec copy, buffer math, no-peers/stalled)
src/lib/subtitles/             MKV subtitle extractor, SRT/VTT parsing, JASSUB glue
e2e/                           Playwright specs; e2e/support/fixture-server.mjs; e2e/fixtures/
docs/decisions/                ADRs
```

## Conventions

- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); shared reactive state in
  `*.svelte.ts` modules, no Svelte 4 stores. Components in PascalCase, modules in kebab-case.
- Import WebTorrent as `import WebTorrent from 'webtorrent/dist/webtorrent.min.js'` (prebuilt browser
  ESM; no Node polyfills). Never import `webtorrent` bare in browser code.
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
- UI test hooks: `data-testid` `video`, `status` (with `data-phase`), `error` and `notice` (with
  `data-code` = the `PlaybackErrorCode`).
- `sample.mkv`: 12 s 640×360 H.264 · audio 1 "English AAC" (eng, default) · audio 2 "Russian AC3" (rus) ·
  subtitles SRT (eng) and ASS (rus). `sidecar.en.srt` is a standalone SRT.
- `offset.ts`: 10 s 320×180 H.264 + AAC MPEG-TS whose first frame is at ~1.4 s. The player maps
  every file onto a 0-based element timeline (`src/lib/player/timeline.ts`): `timestampOffset =
k − startTime`, seeks look up the keyframe at `t + startTime`. Small holes in front of the
  playhead are skipped (`gapJumpTarget`), because the browser waits on any gap forever.
- Web seeds need CORS that allows the `Range` and `Cache-Control` request headers (WebTorrent sends
  both).
