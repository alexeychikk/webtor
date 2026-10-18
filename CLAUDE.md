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
scripts/make-fixtures.sh   # regenerate e2e/fixtures/sample.mkv (needs ffmpeg)
```

CI (`.github/workflows/ci.yml`): check + unit + build, e2e, then on `main` deploy `dist/` to the
`gh-pages` branch (GitHub Pages).

## Layout

```
src/App.svelte                 shell: input → player
src/lib/torrent/               WebTorrent client, trackers, file classification
  webtorrent.d.ts              typings for the WebTorrent API subset we use; extend as needed
src/lib/player/                MSE session, Mediabunny conversions, codec decisions
  types.ts                     contracts between torrent layer, pipeline and UI
  errors.ts                    PlaybackError codes + user-facing copy
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
- `sample.mkv`: 12 s 640×360 H.264 · audio 1 "English AAC" (eng, default) · audio 2 "Russian AC3" (rus) ·
  subtitles SRT (eng) and ASS (rus). `sidecar.en.srt` is a standalone SRT.
- Web seeds need CORS that allows the `Range` and `Cache-Control` request headers (WebTorrent sends
  both).
