<script lang="ts">
  import { PLAYBACK_ERROR_MESSAGES } from '../player/errors';
  import { formatSubtitleDelay, SUBTITLE_DELAY_STEP_S } from './cue';
  import type { SubtitleManager } from './manager.svelte';
  import { SUBTITLE_EXTENSIONS } from './parse';
  import { groupSubtitleTracks, subtitleTrackText } from './tracks';

  let { subtitles }: { subtitles: SubtitleManager } = $props();

  const groups = $derived(groupSubtitleTracks(subtitles.tracks));

  function upload(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Clear it, so picking the same file again still fires `change`.
    input.value = '';
    if (file) void subtitles.addFile(file);
  }
</script>

<div class="subtitles">
  <label>
    Subtitles
    <select
      data-testid="subtitles"
      bind:value={() => subtitles.selected ?? '', (key) => void subtitles.select(key || null)}
    >
      <option value="">Off</option>
      {#each groups as group (group.kind)}
        <optgroup label={group.label}>
          {#each group.tracks as track (track.key)}
            <option value={track.key} disabled={track.unsupported}>
              {subtitleTrackText(track)}{track.unsupported ? ' (unsupported)' : ''}
            </option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </label>
  <span class="delay" role="group" aria-label="Subtitle delay">
    Delay
    <button
      type="button"
      data-testid="subtitle-delay-minus"
      title="Show subtitles {SUBTITLE_DELAY_STEP_S} s earlier"
      aria-label="Subtitles {SUBTITLE_DELAY_STEP_S} s earlier"
      disabled={subtitles.selected === null}
      onclick={() => void subtitles.nudgeDelay(-1)}>−</button
    >
    <output data-testid="subtitle-delay" data-delay={subtitles.delay}
      >{formatSubtitleDelay(subtitles.delay)}</output
    >
    <button
      type="button"
      data-testid="subtitle-delay-plus"
      title="Show subtitles {SUBTITLE_DELAY_STEP_S} s later"
      aria-label="Subtitles {SUBTITLE_DELAY_STEP_S} s later"
      disabled={subtitles.selected === null}
      onclick={() => void subtitles.nudgeDelay(1)}>+</button
    >
    {#if subtitles.delay !== 0}
      <button
        type="button"
        data-testid="subtitle-delay-reset"
        onclick={() => void subtitles.setDelay(0)}>Reset</button
      >
    {/if}
  </span>
  {#if subtitles.loading}<span class="hint" data-testid="subtitles-loading">Loading subtitles…</span
    >{/if}
  <label class="upload">
    Add subtitle file…
    <input
      type="file"
      accept={SUBTITLE_EXTENSIONS.join(',')}
      data-testid="subtitle-upload"
      onchange={upload}
    />
  </label>
  <span class="hint">or drop an SRT, VTT, ASS or SSA file on the video</span>
</div>
{#if subtitles.notice}
  <p class="notice" data-testid="notice" data-code={subtitles.notice.code}>
    {PLAYBACK_ERROR_MESSAGES[subtitles.notice.code]}
    {#if subtitles.notice.detail}<span class="detail">({subtitles.notice.detail})</span>{/if}
  </p>
{/if}

<style>
  .subtitles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
  select {
    margin-left: 0.25rem;
    max-width: min(24rem, 100%);
  }
  .subtitles > label:first-child {
    max-width: 100%;
  }
  .delay {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
  }
  .delay output {
    min-width: 3.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .delay button {
    min-width: 2em;
  }
  .upload {
    cursor: pointer;
    text-decoration: underline;
  }
  .upload input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .upload:focus-within {
    outline: 2px solid currentColor;
  }
  .hint,
  .detail {
    opacity: 0.75;
  }
  .notice {
    padding: 0.5rem 0.75rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, orange 18%, transparent);
  }
</style>
