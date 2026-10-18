# 0001 — Stack, tooling and hosting

Date: 2026-10-18 · Status: accepted

## Decision

- **Vite 8 + Svelte 5 (runes) + TypeScript, single-page app — no SvelteKit.** The app is one screen
  (input → player). SvelteKit's router, SSR/prerender and adapter add nothing here and complicate
  workers/wasm assets. App state that should survive a reload or be shareable goes in the URL hash
  (`#magnet=…&file=…`), which works on static hosting without rewrites.
- **TypeScript 6.0.x**, not 7: `svelte-check` 4.7 supports only `^5 || ^6`. Revisit when it supports 7.
- **pnpm 12** (pinned via `packageManager`). Native addons that webtorrent's Node paths pull in
  (`node-datachannel`, `utp-native`, …) are denied in `pnpm-workspace.yaml`; nothing we run needs them.
- **Vitest 5** for unit tests (pure logic: parsers, codec decisions, track mapping);
  **Playwright 1.64 (Chromium)** for e2e against the production build (`vite preview`).
- **Hosting: GitHub Pages**, built by `.github/workflows/ci.yml` and pushed to the `gh-pages` branch on
  every green `main`. `base: './'` so the same build works under `/webtor/` and at a domain root.
- **No service worker, no COOP/COEP.** Nothing in the design needs `SharedArrayBuffer`: Mediabunny and
  its AC-3/DTS wasm extensions are single-threaded; JASSUB falls back to single-threaded rendering
  when not cross-origin isolated. So the GitHub Pages limitation (no custom headers) does not bite, and
  we avoid `coi-serviceworker`, whose `require-corp` would also break cross-origin `.torrent`/web-seed
  fetches that don't send CORP headers.

## Consequences

- Only Chromium is automated in CI. Firefox/Safari behaviour (codec support, `ManagedMediaSource`) is
  checked by hand and handled by feature detection, never UA sniffing.
- If a future feature needs threads (e.g. multi-threaded ffmpeg), revisit hosting (Cloudflare Pages
  or Netlify can set headers) before reaching for `coi-serviceworker`.
