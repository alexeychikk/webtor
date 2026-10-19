<script lang="ts">
  /**
   * Content of the files drawer (docs/decisions/0008 §4): the torrent's video files, the current
   * one marked, unsupported ones disabled. Picking another file closes the drawer.
   */
  import Film from '@lucide/svelte/icons/film';
  import Play from '@lucide/svelte/icons/play';
  import { formatBytes } from '../player/format';
  import type { VideoFileListEntry } from './files';

  let {
    files,
    selected,
    onselect,
  }: {
    files: readonly VideoFileListEntry[];
    selected: number | null;
    onselect: (index: number) => void;
  } = $props();
</script>

<ul data-testid="file-list" aria-label="Files in this torrent">
  {#each files as f (f.index)}
    {@const current = f.index === selected}
    <li>
      <button
        type="button"
        data-menu-item
        data-testid="file"
        data-index={f.index}
        data-kind={f.kind}
        aria-current={current ? 'true' : undefined}
        disabled={f.kind !== 'playable'}
        onclick={() => onselect(f.index)}
      >
        <span class="icon" class:current aria-hidden="true">
          {#if current}<Play size={16} />{:else}<Film size={16} />{/if}
        </span>
        <span class="text">
          <span class="name">{f.name}</span>
          {#if f.kind !== 'playable'}<span class="sub">Can’t play in the browser</span>{/if}
        </span>
        <span class="size">{formatBytes(f.length)}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    min-height: 3rem;
    padding: var(--space-2) var(--space-4);
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  @media (hover: hover) {
    button:hover:not(:disabled):not([aria-current='true']) {
      background: rgb(255 255 255 / 0.08);
    }
  }
  button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  button[aria-current='true'] {
    background: var(--accent-soft);
  }
  button:disabled {
    color: var(--text-faint);
    cursor: default;
  }
  .icon {
    display: inline-grid;
    flex: none;
    place-items: center;
    color: var(--text-muted);
  }
  .icon.current {
    color: var(--accent-fg);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    display: -webkit-box;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .sub {
    font-size: var(--text-xs);
  }
  .size {
    flex: none;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
