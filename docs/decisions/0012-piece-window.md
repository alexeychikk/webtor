# 0012 — Piece storage: a bounded window around the playhead, in memory

Date: 2026-11-05 · Status: accepted · Supersedes the storage part of 0002 (torrent engine)

## Context

On an iPad, a 12 GB MKV stopped downloading after ~14 min of playback, with no notice. After a
reload, a seek forward froze the page. Pieces went to WebTorrent's default store, OPFS: one file
per piece, kept until the torrent was destroyed. A reload never destroys it, so the files were left
behind. The likely causes, all from OPFS on WebKit:

- **Every write starts a Worker.** The `createWritable` polyfill runs one Worker per piece write.
- **The store grows without bound.** A long watch fills the origin's quota (~1–1.5 GB on iOS).
  After that, a put fails or never settles, so its piece is never verified. Its reader then waits
  forever. The watchdog only looked at `torrent.downloaded`, and other pieces kept that growing,
  so it stayed silent.
- **Leftovers are hashed again on startup.** After a reload, WebTorrent re-reads and SHA-1-hashes
  every piece left in the store (`_verifyPiecesUsingHash`). That is gigabytes of work, competing
  with the seek.

Only the bytes around the playhead are ever needed again: the pipelines re-read from the torrent
after a seek.

## Decision

- **One store everywhere: `MemoryChunkStore`** (`src/lib/torrent/memory-store.ts`).
  - It is passed with `storeCacheSlots: 0`, so no cache sits in front of it.
  - It registers itself per torrent (`storeOf`), counts its `bytes` and can `delete(index)`.
  - The first client clears what an earlier version left in OPFS (`clearOpfs`), so nothing is
    hashed again on startup.
  - OPFS is no longer used for pieces.
- **The window: the bytes playback still needs.** `ByteWindow` (`src/lib/player/byte-window.ts`,
  pure) works out the range in file bytes; `MsePlayer.keepRange()` exposes it.
  - **Sampling.** `MsePlayer` wraps the file's `ByteSource` and records every demuxer read. Each
    fragment produced by a local pipeline gives a sample: (furthest `writtenTo`, end of the
    latest read).
  - **Start.** The byte of the latest sample of this run (since the last seek) at least
    `KEEP_BEHIND_S` (10 s) behind the playhead, minus `READ_AHEAD_SLACK` (16 MiB). Mediabunny's
    'network' prefetch reads up to 8 MiB beyond what it demuxed.
    - Until this run has such a sample, the lowest read since the seek, or lower where an earlier
      run's sample says so. An earlier run's cursor can be far past its media (the demuxer read
      ahead), so alone it never sets the start. It did, and after a far seek back or forward the
      window began past the playhead's bytes: the pieces the pipelines were reading were evicted,
      and seeks stalled (MPEG-TS never completed one).
    - Before this run's first fragment, from 0: a keyframe search (MPEG-TS without an index)
      probes all over the file, and shrinking the window between its reads evicted the probes.
      The probes since the seek then stay kept for `KEEP_BEHIND_S`.
  - **End.** The furthest sample since the last seek (or the latest read, if further), plus the
    slack, capped at the furthest read.
    A one-off read far away, such as Matroska Cues at the end of the file, does not stretch the
    window. Before the first sample, the end is the furthest read.
  - **Reset.** A seek (`restartAt`) resets the run, and so does `MsePlayer.open` after the header
    and duration reads, so a resume's window starts at its resume point from the first tick.
  - **Reads in flight are always inside** (`trackedSource` pins a read until its promise settles or
    its stream delivered its bytes, ends or is cancelled). Every read of the playing file goes
    through the window: the pipelines' (`demux`), the subtitle scan's (`scan`, via
    `MsePlayer.windowed`; its Cluster reads only, the Cues it looks up go through a `once` source)
    and the Matroska header and font attachment reads (`once`, pinned only). WebTorrent drops a stream's selection once its pieces are
    all in, and a `done` file reads straight from the store without one; a piece missing from the
    store then destroys the stream.
- **Eviction.** The controller's 1 s `tick` (`TICK_MS`) calls `evictPieces(torrent, keep)` (`client.ts`). For
  every stored piece outside the window (`piecesToEvict`, `src/lib/torrent/piece-window.ts`):
  - it deletes the piece from the store;
  - `_markUnverified(i)` clears the bitfield bit, makes a fresh `Piece` and resets `file.done`;
  - it sets `_critical[i] = false`;
  - if the torrent was done, it calls `_checkDone()`. A done torrent ignores new peers, and this
    restarts the trackers.

  The effects:
  - An evicted piece is not "have" and is never uploaded. WebTorrent drops a peer's request for
    it without an answer while `pieces[i]` is set (`if (this.pieces[index]) return`, `torrent.js`),
    so the peer's request times out.
  - A seek back downloads it again.
  - **Pieces under a selection are never evicted** either: what a `file.stream` still waits for.

- **Downloading stays selective.** It is unchanged from ADR 0002: the torrent is added deselected,
  and only the pipelines' stream reads select pieces. The window drops what is behind; it never
  selects anything.
- **Budget: feature detection only.** `windowBudget(navigator.deviceMemory)` is device memory / 16,
  clamped to 128–768 MB. Without `deviceMemory` (Safari, Firefox) it is 256 MB.
  `navigator.storage.estimate()` doesn't apply, because nothing goes to disk. The buffer-ahead
  target (60 s) is cut so the window fits the budget at the file's mean byte rate (`aheadWithin`),
  but never below 20 s (`MIN_AHEAD_S`).
- **The watchdog counts `verifiedBytes`** (`client.ts`: `downloaded` plus the evicted bytes, only
  grows). `downloaded` now drops when pieces are evicted, and `received` is no substitute: it also
  counts protocol bytes, which a failing web seed's retries keep adding.

### Seek bar

The seek bar draws the held pieces of the playing file ("downloaded", under "buffered") on its
**time** axis. Byte fractions are not time: in a VBR file (low-bitrate credits), the window
around the playhead was drawn far right of it, with a gap. So `byte-time.ts` maps each held byte
range (`downloadedBytes`, seek.ts: pieces → file bytes, through the file's offset in the torrent)
to element time, piecewise-linear through points where the file says which time sits at which
byte (`MsePlayer.byteTimeIndex()`):

- **MKV/WebM:** the Cues (`readCuePoints`, read once through a `once` window source), cluster
  start → cue time − `startTime`. The whole index: bytes after the last cue run on to the end of
  the media (the Cues or Attachments after the last Cluster, else the Segment's end) = duration.
- **AVI:** the video's keyframe offsets (`AviDemuxer.byteTimeIndex()`); whole once its index is
  complete, still growing during a `movi` scan.
- **Anything else (MP4, MPEG-TS, MKV without Cues):** what the reads learned, `ByteWindow`'s
  (fragment start time, read cursor) samples, plus (furthest read ever, duration) once every
  pipeline appended through the end. The cursor is past its fragment's media, so these points
  place bytes early, never late: the layer may start a little before the playhead, never after it.
  `learnedPoints` reduces them: once Mediabunny's cache holds the data the cursor stops while the
  times go on, so of the samples at one byte the latest time counts (an index's point at a byte
  keeps its earliest time instead); where a seek's new run disagrees with older samples, the
  newest run wins.

Byte 0 is time 0 (the header). Without a whole index, bytes past the last point are left out
rather than guessed; with no points at all the layer is empty. Ranges re-map every tick, so
evicted ones disappear and re-downloaded ones come back at their times after any seek.
`byte-time.test.ts` covers the mapping; `e2e/seek-downloaded.spec.ts` (chromium + webkit) checks
that the layer covers the playhead after keys, seek-bar clicks and drags, far jumps, touch
skips and a resume, and that evicted ranges go, through the Cues and without an index (`offset.ts`,
`vbr.mp4`).

## Consequences

- Memory stays at about the budget, however long the file and however long the watch. A reload
  starts with an empty store and nothing to verify.
- A seek back more than ~10 s (plus slack) beyond the window downloads again. With few peers, that
  is slower than before.
- Nothing is kept across reloads. Resume (ADR 0009) downloads from the saved position.
- **WebTorrent internals.** `_markUnverified`, `_critical`, `_selections` and `_checkDone` are
  internals of webtorrent 3.0.21, the version they were checked against. `client.test.ts` covers `evictPieces` against a fake torrent;
  `e2e/piece-window.spec.ts` covers the real one.
  - When upgrading WebTorrent, keep that e2e green.
  - Without `_markUnverified`, nothing is evicted.
- **e2e and the small fixtures.** Mediabunny reads and caches the whole small fixture at once. To
  exercise eviction, the e2e therefore shrinks the reads:
  - `localStorage['webtor:read-cache-bytes']` sets Mediabunny's `maxCacheSize` with
    `prefetchProfile: 'none'`;
  - `localStorage['webtor:read-slack-bytes']` sets the slack;
  - it reads `window.__webtorStoredBytes`.
