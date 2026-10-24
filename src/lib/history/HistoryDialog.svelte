<script lang="ts">
  /**
   * The watch history popup (docs/decisions/0010): a modal page `<dialog>`, an anchored panel under
   * the header button on wide viewports and a bottom sheet on phones. One row per video, newest
   * first; picking one reopens it (App does that), the × forgets it (with Undo), Clear history
   * forgets them all (inline confirmation). The rules live in history.ts.
   */
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Film from '@lucide/svelte/icons/film';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcwClock from '@lucide/svelte/icons/rotate-ccw-clock';
  import Trash from '@lucide/svelte/icons/trash';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import X from '@lucide/svelte/icons/x';
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import type { PlayerController } from '../player/controller.svelte';
  import { WATCH_PREFIX, defaultStorage } from '../player/watch-state';
  import IconButton from '../ui/IconButton.svelte';
  import { menuKeyTarget } from '../ui/menu';
  import { showPageDialog } from '../ui/page-dialog';
  import {
    clearHistory,
    entryProgress,
    entryState,
    entryTimes,
    entryTitle,
    historyEntryLabel,
    lastWatchedText,
    listHistory,
    removeEntry,
    torrentFileHashes,
    undoRemove,
    type HistoryEntry,
    type RemovedEntry,
  } from './history';
  import { historyDialog } from './history-dialog.svelte';
  import { pruneTorrentFiles } from './torrent-files';

  let {
    controller,
    onpick,
  }: { controller: PlayerController; onpick: (entry: HistoryEntry) => void } = $props();

  /** An Undo stays this long (or until another removal, Clear or close). */
  const UNDO_MS = 8000;
  const BUTTON_ID = 'history-button';

  let dialog = $state<HTMLDialogElement>();
  let list = $state<HTMLUListElement>();
  let cancelButton = $state<HTMLButtonElement>();
  let entries = $state<HistoryEntry[]>([]);
  let available = $state(true);
  let now = $state(Date.now());
  let confirming = $state(false);
  let undo = $state<{ removed: RemovedEntry; title: string } | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let top = $state(68);
  let right = $state(8);

  const viewState = $derived(!available ? 'unavailable' : entries.length ? 'list' : 'empty');

  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The row of the file open now. */
  function isPlaying(entry: HistoryEntry): boolean {
    const phase = controller.phase;
    return (
      phase !== 'idle' &&
      phase !== 'error' &&
      entry.infoHash === controller.infoHash &&
      entry.source.index === controller.fileIndex
    );
  }

  function reload() {
    available = defaultStorage() !== null;
    entries = listHistory();
    now = Date.now();
  }

  /** Panel mode: 4 px under the header button, right edge on its right edge. */
  function place() {
    const r = document.getElementById(BUTTON_ID)?.getBoundingClientRect();
    if (!r) return;
    top = Math.round(r.bottom + 4);
    right = Math.max(8, Math.round(window.innerWidth - r.right));
  }

  /** Stored .torrent files of videos no longer listed go (the one playing stays). */
  function prune() {
    const keep = torrentFileHashes(listHistory());
    if (controller.infoHash) keep.add(controller.infoHash);
    void pruneTorrentFiles(keep);
  }

  function dropUndo() {
    clearTimeout(undoTimer);
    if (!undo) return;
    undo = null;
    prune();
  }

  const entryButtons = () =>
    [...(list?.querySelectorAll<HTMLButtonElement>('[data-testid="history-entry"]') ?? [])].filter(
      (b) => !b.closest('[data-leaving]'),
    );

  const closeButton = () => dialog?.querySelector<HTMLElement>('[data-testid="history-close"]');
  /** `data-key` of a row: `<infohash>:<path>`. */
  const dataKey = (key: string) => key.slice(WATCH_PREFIX.length);

  /** Focus on the row of `key`, else on Close. */
  function focusEntry(key: string | undefined) {
    const button = key && entryButtons().find((b) => b.dataset.key === dataKey(key));
    (button || closeButton())?.focus();
  }

  $effect(() => {
    if (!dialog) return;
    if (historyDialog.open && !dialog.open) {
      reload();
      place();
      prune();
      const d = dialog;
      void showPageDialog(d, () => historyDialog.open).then(async () => {
        place();
        await tick();
        if (d.open) focusEntry(entries[0]?.key);
      });
    } else if (!historyDialog.open && dialog.open) dialog.close();
  });

  $effect(() => {
    if (!historyDialog.open) return;
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  function close() {
    historyDialog.open = false;
  }

  function onClose() {
    historyDialog.open = false;
    confirming = false;
    dropUndo();
    const to = historyDialog.returnTo ?? document.getElementById(BUTTON_ID);
    historyDialog.returnTo = null;
    if (to?.isConnected) to.focus();
  }

  /** A click on the backdrop lands on the dialog itself (its content fills it). */
  function onDialogClick(event: MouseEvent) {
    if (event.target === dialog) close();
  }

  function pick(entry: HistoryEntry) {
    close();
    onpick(entry);
  }

  async function remove(entry: HistoryEntry) {
    dropUndo();
    confirming = false;
    const i = entries.findIndex((e) => e.key === entry.key);
    if (isPlaying(entry)) controller.forget();
    const removed = removeEntry(entry.key);
    entries = entries.filter((e) => e.key !== entry.key);
    if (removed) {
      undo = { removed, title: entryTitle(entry) };
      undoTimer = setTimeout(dropUndo, UNDO_MS);
    } else {
      prune();
    }
    await tick();
    focusEntry((entries[i] ?? entries[i - 1])?.key);
  }

  async function undoRemoval() {
    const u = undo;
    if (!u) return;
    clearTimeout(undoTimer);
    undo = null;
    undoRemove(u.removed);
    reload();
    await tick();
    focusEntry(u.removed.key);
  }

  async function askClear() {
    dropUndo();
    confirming = true;
    await tick();
    cancelButton?.focus();
  }

  async function cancelClear() {
    confirming = false;
    await tick();
    (dialog?.querySelector<HTMLElement>('[data-testid="history-clear"]') ?? closeButton())?.focus();
  }

  async function confirmClear() {
    clearHistory();
    controller.forget();
    void pruneTorrentFiles(new Set());
    confirming = false;
    entries = [];
    await tick();
    closeButton()?.focus();
  }

  /** ↑/↓/Home/End move between the rows' main buttons (a remove button counts as its row). */
  function onListKey(event: KeyboardEvent) {
    const buttons = entryButtons();
    const row = (event.target as Element | null)?.closest('li');
    const current = buttons.findIndex((b) => b.closest('li') === row);
    const next = menuKeyTarget(event.key, current, buttons.length);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  /** The row's height collapses as it goes (not under reduced motion). */
  function collapse(node: Element) {
    node.setAttribute('data-leaving', '');
    return slide(node, { duration: reducedMotion() ? 0 : 200 });
  }
</script>

<dialog
  bind:this={dialog}
  class="history"
  data-testid="history-dialog"
  data-state={viewState}
  aria-labelledby="history-title"
  style:--top="{top}px"
  style:--right="{right}px"
  onclose={onClose}
  onclick={onDialogClick}
>
  <div class="grabber" aria-hidden="true"></div>
  <div class="head">
    <h2 id="history-title">Watch history</h2>
    <IconButton testid="history-close" icon={X} label="Close" onclick={close} />
  </div>
  {#if viewState === 'list'}
    <!-- Arrow keys move between the rows' buttons (the keys reach the list from them). -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <ul class="body" bind:this={list} data-testid="history-list" onkeydown={onListKey}>
      {#each entries as entry (entry.key)}
        {@const playing = isPlaying(entry)}
        {@const state = entryState(entry, playing)}
        {@const progress = entryProgress(entry)}
        <li out:collapse>
          <button
            type="button"
            class="entry"
            class:playing
            data-testid="history-entry"
            data-key={dataKey(entry.key)}
            data-state={state}
            data-position={Math.round(entry.position ?? 0)}
            aria-label={historyEntryLabel(entry, playing, now)}
            onclick={() => pick(entry)}
          >
            <span class="tile {state}" aria-hidden="true">
              {#if state === 'playing'}<Play size={20} />{:else if state === 'watched'}<CircleCheck
                  size={20}
                />{:else}<Film size={20} />{/if}
            </span>
            <span class="lines">
              <span class="title">{entryTitle(entry)}</span>
              {#if entry.source.multi}<span class="file">{entry.source.file}</span>{/if}
              {#if state !== 'watched' && progress !== null}
                <span class="bar" aria-hidden="true"
                  ><span class="played" style:width="{progress * 100}%"></span></span
                >
              {/if}
              <span class="meta">
                {#if state === 'watched'}
                  <span class="watched"><CircleCheck size={14} aria-hidden="true" />Watched</span>
                {:else}
                  {entryTimes(entry)}
                {/if}
                ·
                {#if state === 'playing'}Now playing{:else}<time
                    datetime={new Date(entry.updated).toISOString()}
                    >{lastWatchedText(entry.updated, now)}</time
                  >{/if}
              </span>
            </span>
          </button>
          <IconButton
            class="remove"
            testid="history-remove"
            icon={X}
            label="Remove from history"
            onclick={() => void remove(entry)}
          />
        </li>
      {/each}
    </ul>
  {:else}
    <div class="body empty" data-testid="history-empty">
      <RotateCcwClock size={32} aria-hidden="true" />
      {#if viewState === 'unavailable'}
        <p class="empty-title">History isn’t available</p>
        <p>History isn’t available: this browser blocks site storage.</p>
      {:else}
        <p class="empty-title">Nothing watched yet</p>
        <p>Videos you play show up here, so you can pick up where you stopped.</p>
        <p class="kept">Kept only in this browser.</p>
      {/if}
    </div>
  {/if}
  {#if viewState === 'list' || undo}
    <div class="foot">
      {#if confirming}
        <p class="note" id="history-clear-text">
          Forget all {entries.length}
          {entries.length === 1 ? 'video' : 'videos'} and where you stopped?
        </p>
        <button
          bind:this={cancelButton}
          type="button"
          class="btn btn-ghost"
          data-testid="history-clear-cancel"
          onclick={() => void cancelClear()}>Cancel</button
        >
        <button
          type="button"
          class="btn btn-danger-fill"
          data-testid="history-clear-confirm"
          aria-describedby="history-clear-text"
          onclick={() => void confirmClear()}>Clear</button
        >
      {:else}
        <p class="note" role="status">
          {#if undo}
            <span class="removed">Removed “{undo.title}”</span>
            <button
              type="button"
              class="text-button"
              data-testid="history-undo"
              onclick={() => void undoRemoval()}><Undo2 size={16} aria-hidden="true" />Undo</button
            >
          {:else}
            Kept only in this browser
          {/if}
        </p>
        {#if entries.length}
          <button
            type="button"
            class="btn btn-danger"
            data-testid="history-clear"
            onclick={() => void askClear()}
            ><Trash size={18} aria-hidden="true" />Clear history</button
          >
        {/if}
      {/if}
    </div>
  {/if}
</dialog>

<style>
  dialog.history {
    position: fixed;
    inset: var(--top) var(--right) auto auto;
    box-sizing: border-box;
    width: min(26rem, calc(100vw - 16px));
    max-width: none;
    max-height: min(36rem, calc(100dvh - var(--top) - 16px));
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--text);
    box-shadow: var(--shadow-2);
    overflow: hidden;
  }
  dialog.history[open] {
    display: flex;
    flex-direction: column;
  }
  dialog.history::backdrop {
    background: transparent;
  }
  @media (prefers-reduced-motion: no-preference) {
    dialog.history[open] {
      animation: history-rise var(--dur-base) var(--ease-out);
    }
  }
  @keyframes history-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  .grabber {
    display: none;
    flex: none;
    width: 2.5rem;
    height: 4px;
    margin: var(--space-2) auto 0;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .head {
    display: flex;
    flex: none;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  }
  .head h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 0 var(--space-2) var(--space-2);
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }
  li {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    overflow: hidden;
  }
  .entry {
    display: flex;
    flex: 1;
    gap: var(--space-3);
    align-items: center;
    min-width: 0;
    min-height: 4.5rem;
    padding: var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  @media (hover: hover) {
    .entry:hover {
      background: rgb(255 255 255 / 0.06);
    }
  }
  .entry.playing {
    background: var(--accent-soft);
  }
  .entry:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .tile {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .tile.watched {
    color: var(--success);
  }
  .tile.playing {
    background: var(--accent-soft);
    color: var(--accent-fg);
  }
  .lines {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title,
  .file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }
  .file {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .bar {
    display: block;
    height: 3px;
    margin: 3px 0 1px;
    border-radius: var(--radius-pill);
    background: var(--seek-track);
    overflow: hidden;
  }
  .played {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--seek-played);
  }
  .meta {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .watched {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    vertical-align: bottom;
  }
  .watched :global(svg) {
    color: var(--success);
  }
  li :global(.remove) {
    color: var(--text-faint);
  }
  li:focus-within :global(.remove) {
    color: var(--text);
  }
  @media (hover: hover) {
    li:hover :global(.remove) {
      color: var(--text);
    }
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-5) var(--space-5) var(--space-6);
    color: var(--text-faint);
    text-align: center;
  }
  .empty p {
    max-width: 18rem;
    margin: var(--space-1) 0 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .empty .empty-title {
    margin-top: var(--space-3);
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }
  .empty .kept {
    margin-top: var(--space-3);
    color: var(--text-faint);
    font-size: var(--text-xs);
  }
  .foot {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-end;
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border-top: 1px solid var(--border);
  }
  .note {
    display: flex;
    flex: 1 1 10rem;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
    margin: 0;
    color: var(--text-faint);
    font-size: var(--text-xs);
  }
  .removed {
    overflow: hidden;
    color: var(--text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text-button {
    display: inline-flex;
    flex: none;
    gap: 4px;
    align-items: center;
    min-height: var(--hit);
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--accent-fg);
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .text-button:focus-visible {
    outline: 2px solid var(--focus);
  }
  @media (hover: hover) {
    .text-button:hover {
      background: rgb(255 255 255 / 0.08);
    }
  }
  .btn-ghost {
    border-color: transparent;
  }
  .btn-danger-fill {
    border-color: transparent;
    background: var(--danger);
    color: var(--bg);
  }
  @media (pointer: coarse) {
    .entry {
      min-height: 4.75rem;
    }
    .text-button {
      min-height: var(--hit-touch);
    }
  }

  /* Phone: a bottom sheet (like the player's menu sheet, ADR 0008 §4). */
  @media (max-width: 40rem) {
    dialog.history {
      inset: auto 0 0 0;
      width: 100%;
      max-height: 80dvh;
      border-bottom: 0;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    }
    dialog.history::backdrop {
      background: rgb(0 0 0 / 0.6);
    }
    .grabber {
      display: block;
    }
    @media (prefers-reduced-motion: no-preference) {
      dialog.history[open] {
        animation: history-sheet var(--dur-slow) var(--ease-out);
      }
    }
  }
  @keyframes history-sheet {
    from {
      transform: translateY(100%);
    }
  }
</style>
