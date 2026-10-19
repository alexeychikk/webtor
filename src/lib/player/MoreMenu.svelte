<script lang="ts">
  /**
   * Content of the compact bar's More menu (docs/decisions/0008 §3.6): Sound switch, Audio ›,
   * Files ›, Stats › (each swaps in that menu, with a Back row) and Copy share link.
   */
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Link from '@lucide/svelte/icons/link';
  import ListVideo from '@lucide/svelte/icons/list-video';
  import Users from '@lucide/svelte/icons/users';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import VolumeX from '@lucide/svelte/icons/volume-x';
  import type { ShareLink } from './share-link.svelte';

  type Sub = 'audio' | 'files' | 'stats';

  let {
    silent,
    ontogglemute,
    rows,
    share,
    onopen,
    onshare,
  }: {
    silent: boolean;
    ontogglemute: () => void;
    /** The › rows to show, with their value text. */
    rows: readonly { id: Sub; value: string }[];
    /** Absent without a magnet. */
    share: ShareLink | null;
    onopen: (id: Sub) => void;
    onshare: () => void;
  } = $props();

  const ROW = {
    audio: { icon: AudioLines, label: 'Audio' },
    files: { icon: ListVideo, label: 'Files' },
    stats: { icon: Users, label: 'Stats' },
  } as const;
</script>

<div class="more">
  <button
    type="button"
    class="row"
    role="switch"
    aria-checked={!silent}
    data-menu-item
    data-testid="more-sound"
    onclick={ontogglemute}
  >
    {#if silent}<VolumeX size={20} aria-hidden="true" />{:else}<Volume2
        size={20}
        aria-hidden="true"
      />{/if}
    <span class="label">Sound</span>
    <span class="switch" class:on={!silent} aria-hidden="true"></span>
  </button>
  {#each rows as row (row.id)}
    {@const Icon = ROW[row.id].icon}
    <button
      type="button"
      class="row"
      data-menu-item
      data-testid="more-{row.id}"
      aria-label="{ROW[row.id].label}: {row.value}"
      onclick={() => onopen(row.id)}
    >
      <Icon size={20} aria-hidden="true" />
      <span class="label">{ROW[row.id].label}</span>
      <span class="value">{row.value}</span>
      <ChevronRight size={20} aria-hidden="true" />
    </button>
  {/each}
  {#if share}
    <button
      type="button"
      class="row"
      data-menu-item
      data-testid="share-link"
      data-state={share.state}
      onclick={onshare}
    >
      {#if share.state === 'copied'}<span class="ok"><Check size={20} aria-hidden="true" /></span
        >{:else}<Link size={20} aria-hidden="true" />{/if}
      <span class="label">{share.state === 'copied' ? 'Link copied' : 'Copy share link'}</span>
    </button>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    min-height: 3rem;
    padding: 0 var(--space-4);
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  @media (hover: hover) {
    .row:hover {
      background: rgb(255 255 255 / 0.08);
    }
  }
  .row:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .label {
    flex: 1;
  }
  .value {
    overflow: hidden;
    max-width: 50%;
    color: var(--text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ok {
    display: inline-grid;
    color: var(--success);
  }
  .switch {
    position: relative;
    width: 2.25rem;
    height: 1.25rem;
    border-radius: var(--radius-pill);
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--border-strong);
  }
  .switch::after {
    position: absolute;
    top: 2px;
    left: 2px;
    width: calc(1.25rem - 4px);
    height: calc(1.25rem - 4px);
    border-radius: 50%;
    background: var(--text-muted);
    content: '';
  }
  .switch.on {
    background: var(--accent);
  }
  .switch.on::after {
    left: auto;
    right: 2px;
    background: var(--on-accent);
  }
</style>
