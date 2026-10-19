<script lang="ts">
  /**
   * Content of the audio menu (docs/decisions/0008 §4): one option per track, `label · lang` and
   * a codec line (or why it can't play). Its accessible name is `audioOptionText`. Picking closes.
   */
  import Check from '@lucide/svelte/icons/check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { audioOptionText, audioTrackDetail, audioTrackTitle } from './audio-options';
  import type { AudioTrackInfo } from './types';

  let {
    tracks,
    selected,
    onselect,
  }: {
    tracks: readonly AudioTrackInfo[];
    /** `null`: muted, nothing playable. */
    selected: number | null;
    onselect: (id: number) => void;
  } = $props();
</script>

{#if selected === null}
  <p class="muted"><TriangleAlert size={16} aria-hidden="true" /> No playable audio track</p>
{/if}
<div role="listbox" aria-label="Audio track">
  {#each tracks as t (t.id)}
    {@const disabled = selected === null || t.playback === 'unsupported'}
    <!-- Keys: Menu.svelte (Enter/Space click the focused option, arrows move). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="option"
      role="option"
      data-menu-item
      data-testid="audio-option"
      data-value={t.id}
      aria-label={audioOptionText(t)}
      aria-selected={t.id === selected}
      aria-disabled={disabled}
      tabindex={t.id === selected ? 0 : -1}
      onclick={() => !disabled && onselect(t.id)}
    >
      <span class="mark" aria-hidden="true">
        {#if t.id === selected}<Check size={16} />{/if}
      </span>
      <span class="text" aria-hidden="true">
        <span>{audioTrackTitle(t)}</span>
        <span class="sub">{audioTrackDetail(t)}</span>
      </span>
    </div>
  {/each}
</div>

<style>
  .muted {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-4);
    color: var(--warning);
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--hit);
    padding: var(--space-2) var(--space-4);
    cursor: pointer;
  }
  .option[aria-selected='true'] {
    background: var(--accent-soft);
  }
  .option[aria-disabled='true'] {
    color: var(--text-faint);
    cursor: default;
  }
  @media (hover: hover) {
    .option:not([aria-disabled='true']):not([aria-selected='true']):hover {
      background: rgb(255 255 255 / 0.08);
    }
  }
  .option:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .mark {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 16px;
    color: var(--accent-fg);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .option[aria-disabled='true'] .sub {
    color: var(--text-faint);
  }
</style>
