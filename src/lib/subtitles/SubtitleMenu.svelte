<script lang="ts">
  /**
   * Content of the subtitles menu (docs/decisions/0008 §4): Off and the tracks by group (a
   * listbox), "Add subtitle file…" (clicks the player's hidden `subtitle-upload` input) and the
   * delay row. Picking a track closes the menu; the delay buttons don't.
   */
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Upload from '@lucide/svelte/icons/upload';
  import IconButton from '../ui/IconButton.svelte';
  import { formatSubtitleDelay, SUBTITLE_DELAY_STEP_S } from './cue';
  import type { SubtitleManager } from './manager.svelte';
  import { groupSubtitleTracks, subtitleTrackText } from './tracks';

  let {
    subtitles,
    onpicked,
    onupload,
  }: {
    subtitles: SubtitleManager;
    /** A track (or Off) was picked: the menu closes. */
    onpicked: () => void;
    /** "Add subtitle file…": opens the file chooser. */
    onupload: () => void;
  } = $props();

  const groups = $derived(groupSubtitleTracks(subtitles.tracks));
  const selected = $derived(subtitles.selected ?? '');
  let root = $state<HTMLElement>();

  function pick(key: string) {
    void subtitles.select(key || null);
    onpicked();
  }

  function resetDelay() {
    void subtitles.setDelay(0);
    // The reset button goes away: keep the focus in the menu.
    root?.querySelector<HTMLElement>('[data-testid="subtitle-delay-plus"]')?.focus();
  }
</script>

{#snippet option(key: string, kind: string, text: string, unsupported = false)}
  <!-- Keys: Menu.svelte (Enter/Space click the focused option, arrows move). -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="option"
    role="option"
    data-menu-item
    data-testid="subtitle-option"
    data-value={key}
    data-kind={kind}
    aria-selected={key === selected}
    aria-disabled={unsupported}
    tabindex={key === selected ? 0 : -1}
    onclick={() => !unsupported && pick(key)}
  >
    <span class="mark" aria-hidden="true">
      {#if key === selected}
        {#if subtitles.loading && key !== ''}
          <span class="spin" data-testid="subtitles-loading"><LoaderCircle size={16} /></span>
        {:else}<Check size={16} />{/if}
      {/if}
    </span>
    <span class="text">
      <span>{text}</span>
      {#if unsupported}<span class="sub">Unsupported</span>{/if}
    </span>
    {#if unsupported}<Ban size={16} aria-hidden="true" />{/if}
  </div>
{/snippet}

<div bind:this={root} class="subtitles">
  <div class="list" role="listbox" aria-label="Subtitle track">
    {@render option('', 'off', 'Off')}
    {#each groups as group (group.kind)}
      <div role="group" aria-label={group.label}>
        <div class="group-label" aria-hidden="true">{group.label}</div>
        {#each group.tracks as track (track.key)}
          {@render option(track.key, track.kind, subtitleTrackText(track), track.unsupported)}
        {/each}
      </div>
    {/each}
  </div>
  <hr />
  <button type="button" class="row upload" onclick={onupload}>
    <Upload size={20} aria-hidden="true" />
    <span class="text">
      <span>Add subtitle file…</span>
      <span class="sub">or drop it on the video</span>
    </span>
  </button>
  <hr />
  <div class="row delay" role="group" aria-label="Subtitle delay">
    <span class="delay-label">Delay</span>
    <IconButton
      icon={Minus}
      testid="subtitle-delay-minus"
      label="Subtitles {SUBTITLE_DELAY_STEP_S} s earlier"
      disabled={subtitles.selected === null}
      onclick={() => void subtitles.nudgeDelay(-1)}
    />
    <output data-testid="subtitle-delay" data-delay={subtitles.delay}
      >{formatSubtitleDelay(subtitles.delay)}</output
    >
    <IconButton
      icon={Plus}
      testid="subtitle-delay-plus"
      label="Subtitles {SUBTITLE_DELAY_STEP_S} s later"
      disabled={subtitles.selected === null}
      onclick={() => void subtitles.nudgeDelay(1)}
    />
    {#if subtitles.delay !== 0}
      <IconButton
        icon={RotateCcw}
        testid="subtitle-delay-reset"
        label="Reset subtitle delay"
        onclick={resetDelay}
      />
    {/if}
  </div>
</div>

<style>
  .option,
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    min-height: var(--hit);
    padding: var(--space-2) var(--space-4);
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
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
    .option:not([aria-disabled='true']):not([aria-selected='true']):hover,
    .upload:hover {
      background: rgb(255 255 255 / 0.08);
    }
  }
  .option:focus-visible,
  .row:focus-visible {
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
    flex: 1;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .group-label {
    padding: var(--space-3) var(--space-4) var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  hr {
    margin: var(--space-2) 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .delay {
    gap: var(--space-1);
    cursor: default;
  }
  .delay-label {
    flex: 1;
  }
  .delay output {
    min-width: 4em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .delay :global(.icon-button:disabled) {
    color: var(--text-faint);
    cursor: default;
  }
  .spin {
    display: inline-grid;
  }
  /* The spinner turns even under reduced motion (ADR 0008). */
  .spin {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
