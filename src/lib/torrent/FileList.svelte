<script lang="ts">
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

<!-- Only worth showing when there is a choice (series, extras, an AVI next to the MKV). -->
{#if files.length > 1}
  <nav class="files" aria-label="Files in this torrent">
    <ul data-testid="file-list">
      {#each files as f (f.index)}
        <li>
          <button
            type="button"
            data-testid="file"
            data-index={f.index}
            data-kind={f.kind}
            aria-current={f.index === selected ? 'true' : undefined}
            disabled={f.kind !== 'playable'}
            title={f.kind === 'playable'
              ? f.path
              : `${f.path} — this format cannot be opened in the browser`}
            onclick={() => f.index !== selected && onselect(f.index)}
          >
            <span class="name">{f.name}</span>
            <span class="size">{formatBytes(f.length)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </nav>
{/if}

<style>
  ul {
    list-style: none;
    margin: 0.75rem 0;
    padding: 0;
    max-height: 14rem;
    overflow-y: auto;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 0.25rem;
  }
  button {
    display: flex;
    width: 100%;
    gap: 1rem;
    justify-content: space-between;
    padding: 0.4rem 0.75rem;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
  button[aria-current='true'] {
    background: color-mix(in srgb, royalblue 25%, transparent);
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    flex: none;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
</style>
