<script lang="ts">
  /**
   * The centre of the picture (docs/decisions/0008 §3.4): the paused play circle (Replay when
   * ended), a short flash of the new state on each toggle, the spinner (with a caption while
   * connecting or opening the file; buffering only after 500 ms), and on touch the
   * `[back] (play/pause) [forward]` row while the controls show.
   */
  import FastForward from '@lucide/svelte/icons/fast-forward';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import Rewind from '@lucide/svelte/icons/rewind';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import IconButton from '../ui/IconButton.svelte';
  import type { Phase } from './controller.svelte';
  import type { MediaState } from './media-state.svelte';
  import { centreState, type Flash } from './centre';
  import { SEEK_STEP_S } from './shortcuts';

  let {
    media,
    phase,
    viaRelay,
    touch,
    shown,
    covered = false,
    flash,
    ontoggleplay,
    onseek,
  }: {
    media: MediaState;
    phase: Phase;
    viaRelay: boolean;
    touch: boolean;
    /** The control layer is shown (the touch row comes and goes with it). */
    shown: boolean;
    /** A state card covers the picture: the spinner hides under it (the card has its own). */
    covered?: boolean;
    /** The last play/pause toggle, to flash its new state; `null` before the first. */
    flash: Flash | null;
    ontoggleplay: () => void;
    onseek: (by: number) => void;
  } = $props();

  const BUFFERING_DELAY_MS = 500;
  let bufferingLong = $state(false);

  $effect(() => {
    if (phase !== 'buffering') {
      bufferingLong = false;
      return;
    }
    const timer = setTimeout(() => (bufferingLong = true), BUFFERING_DELAY_MS);
    return () => clearTimeout(timer);
  });

  const view = $derived(
    centreState({
      phase,
      paused: media.paused,
      ended: media.ended,
      bufferingLong,
      touch,
      shown,
    }),
  );
  const caption = $derived(
    phase === 'connecting'
      ? viaRelay
        ? 'Relay is finding peers…'
        : 'Looking for peers…'
      : phase === 'metadata'
        ? 'Opening video…'
        : '',
  );
</script>

<div class="centre" class:covered data-testid="centre" data-state={view}>
  {#if view === 'loading' || view === 'buffering'}
    <div class="loading" role="presentation">
      <span class="spinner" aria-hidden="true"><LoaderCircle size={40} strokeWidth={2} /></span>
      {#if caption}<p class="caption">{caption}</p>{/if}
    </div>
  {:else if view !== 'none'}
    <div class="row" data-player-controls>
      {#if touch}
        <IconButton
          class="side"
          testid="seek-back"
          icon={Rewind}
          label="Back {SEEK_STEP_S} s"
          iconSize={24}
          onclick={() => onseek(-SEEK_STEP_S)}
        />
      {/if}
      <IconButton
        class="circle"
        testid="centre-button"
        icon={view === 'replay' ? RotateCcw : view === 'pause' ? Pause : Play}
        label={view === 'replay' ? 'Replay' : view === 'pause' ? 'Pause video' : 'Play video'}
        shortcut={touch ? undefined : 'Space'}
        iconSize={32}
        onclick={ontoggleplay}
      />
      {#if touch}
        <IconButton
          class="side"
          testid="seek-forward"
          icon={FastForward}
          label="Forward {SEEK_STEP_S} s"
          iconSize={24}
          onclick={() => onseek(SEEK_STEP_S)}
        />
      {/if}
    </div>
  {/if}

  {#if flash && !touch && view === 'none'}
    {#key flash.n}
      <span class="flash" aria-hidden="true">
        {#if flash.playing}<Play size={28} strokeWidth={2} />{:else}<Pause
            size={28}
            strokeWidth={2}
          />{/if}
      </span>
    {/key}
  {/if}
</div>

<style>
  .centre {
    position: absolute;
    inset: 0;
    z-index: var(--z-state);
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .centre.covered {
    visibility: hidden;
  }
  .centre > * {
    grid-area: 1 / 1;
  }
  .row {
    display: flex;
    gap: var(--space-6);
    align-items: center;
  }
  .row :global(.icon-button) {
    pointer-events: auto;
    background: var(--glass);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
  }
  .row :global(.icon-button.circle) {
    width: 72px;
    height: 72px;
    border-radius: 50%;
  }
  .row :global(.icon-button.side) {
    width: 48px;
    height: 48px;
    border-radius: 50%;
  }
  .row :global(.icon-button:hover) {
    background: rgb(40 44 56 / 0.85);
  }
  .loading {
    display: grid;
    justify-items: center;
    gap: var(--space-3);
  }
  .spinner {
    display: grid;
    color: var(--text);
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.6));
    animation: spin 0.9s linear infinite;
  }
  .caption {
    margin: 0;
    padding: 0 var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  }
  .flash {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--glass);
    color: var(--text);
    opacity: 0;
  }
  @media (prefers-reduced-motion: no-preference) {
    .flash {
      animation: flash 400ms var(--ease-out);
    }
  }
  @keyframes flash {
    from {
      opacity: 1;
      transform: scale(1);
    }
    to {
      opacity: 0;
      transform: scale(1.25);
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
