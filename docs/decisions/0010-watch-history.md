# 0010 — Watch history: on the watch entry, opened .torrent files in IndexedDB

Date: 2026-10-24 · Status: accepted · Extends 0009 (per-video watch state), 0008 (UI)

## Context

Users want to get back to what they watched: a list of videos, newest first, each reopening the
torrent and file at the position it stopped. Positions are already kept per video (ADR 0009).

## Decision

- **History rides on the watch entry.** `webtor:watch:<infohash>:<path>` gets a `source`
  `{ name, file, multi, index, magnet, fromFile? }` (`WatchSource`, watch-state.ts), written with
  the first position save of an open (the first `playing`) and again only when it changes. The
  history (`src/lib/history/history.ts`, pure, Vitest) is every watch entry with a `source`,
  sorted by `updated` (= last watched). No second store and no second eviction: the 200-entry LRU
  of the watch entries bounds both, so history and resume never diverge. Entries without `source`
  (older ones, a track picked before the first frame) are not listed.
- **`magnet`** is what the user gave (magnet with its `tr=`/`ws=`/`xs=`, or an info hash), or an
  opened .torrent's `magnetURI`. Over 2 000 characters `boundedMagnet` keeps `xt`, `dn`, every
  `xs`/`ws` and as many `tr` as fit.
- **Opened .torrent files** have no `xs=`, so their magnet can't get the metadata without a peer.
  Their bytes go to IndexedDB (db `webtor`, store `torrent-files`, key = info hash,
  `{ bytes, updated }`, `src/lib/history/torrent-files.ts`) when they parse; at most 20 files and
  16 MB (`torrentFilesToEvict`). The async read is fine on a click (unlike resume, ADR 0009). Files
  no listed entry needs are pruned when the popup opens and after a removal's Undo expires; every
  IndexedDB error is ignored and the entry falls back to its magnet.
- **Remove = instant with Undo (8 s), Clear = inline confirmation.** Both forget the whole watch
  state (`webtor:watch:*`, `webtor:watch-upload:*`) and nothing else (relay URL, language
  preferences stay). Removing the file open now calls `controller.forget()`, so its next position
  save doesn't bring it back during this open (a stuck-seek reopen of the same file included);
  its Undo calls `controller.remember(key)`, which saves it again from the current position.
- **UI**: header button (`rotate-ccw-clock`, shortcut `H`, also while idle) opening a modal page
  `<dialog>` (`HistoryDialog.svelte`): an anchored panel under the button, a bottom sheet at
  ≤ 40rem. Picking the file open now does nothing, another file of the loaded torrent is a
  `selectFile`, anything else a `load` (stored bytes or magnet) with `pushState`; resume does the
  rest, a watched video (`isWatched`, the tail `resumePoint` skips) starts from 0.

## Rejected

- **A separate history list key:** two stores to bound and evict consistently, for the same data.
- **One row per torrent with nested files:** the position is per file; nesting adds a second
  keyboard level for no gain.
- **.torrent bytes in localStorage:** up to 16 MB × base64 would crowd out the ~5 M origin quota.
