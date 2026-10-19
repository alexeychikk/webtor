<script lang="ts">
  /**
   * Errors and notices inside the player (docs/decisions/0008 §5): one centred card (a fatal error,
   * or no-peers while the search goes on) and a stack of toasts at the top for everything else.
   * Toasts come and go with the controls; cards stay.
   */
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import SearchX from '@lucide/svelte/icons/search-x';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Waypoints from '@lucide/svelte/icons/waypoints';
  import X from '@lucide/svelte/icons/x';
  import { helpDialog } from '../help/help-dialog.svelte';
  import { relaySettings } from '../torrent/relay-settings.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { PLAYBACK_ERROR_TITLES, playbackErrorMessage, type PlaybackErrorCode } from './errors';
  import { errorActions, type StateCard, type StateToast } from './states';

  let {
    card,
    toasts,
    message,
    viaRelay,
    shown,
    onretry,
    ondismiss,
  }: {
    card: StateCard | null;
    toasts: readonly StateToast[];
    /** The fatal error's full message (with its detail). */
    message: string;
    viaRelay: boolean;
    /** The controls show: toasts hide with them. */
    shown: boolean;
    onretry: () => void;
    ondismiss: (code: PlaybackErrorCode) => void;
  } = $props();

  let moreOpen = $state(false);
  let expanded = $state<PlaybackErrorCode | null>(null);
  const actions = $derived(card?.kind === 'error' ? errorActions(card.code) : null);
</script>

<div class="states" class:carded={card !== null}>
  {#if toasts.length}
    <div class="toasts" class:hidden={!shown}>
      {#each toasts as t (t.code)}
        {@const open = expanded === t.code}
        <div class="toast" class:open data-testid="notice" data-code={t.code} role="status">
          <div class="toast-row">
            <span class="toast-icon"><TriangleAlert size={18} aria-hidden="true" /></span>
            <span class="toast-title">{PLAYBACK_ERROR_TITLES[t.code]}</span>
            <IconButton
              class="small"
              icon={ChevronDown}
              label={open ? 'Hide details' : 'Details'}
              aria-expanded={open}
              onclick={() => (expanded = open ? null : t.code)}
            />
            {#if t.code === 'stalled'}
              <IconButton
                class="small"
                testid="why-link"
                icon={CircleQuestionMark}
                label="Why won’t it play?"
                onclick={() => helpDialog.show()}
              />
            {/if}
            <IconButton
              class="small"
              testid="notice-dismiss"
              icon={X}
              label="Dismiss"
              onclick={() => ondismiss(t.code)}
            />
          </div>
          <p class="toast-message" hidden={!open}>{playbackErrorMessage(t.code, t.detail)}</p>
        </div>
      {/each}
    </div>
  {/if}

  {#if card}
    <div class="scrim"></div>
    <div class="card-area">
      {#if card.kind === 'error'}
        <div class="card" role="alert" data-testid="error" data-code={card.code}>
          <span class="card-icon danger"><CircleAlert size={32} aria-hidden="true" /></span>
          <h2>{PLAYBACK_ERROR_TITLES[card.code]}</h2>
          <p class="message">{message}</p>
          <div class="ctas">
            {#if actions?.relay === 'settings'}
              <button type="button" class="btn" onclick={() => relaySettings.openDialog()}>
                <Settings2 size={18} aria-hidden="true" />Relay settings
              </button>
            {:else if actions?.relay === 'setup'}
              <button type="button" class="btn" onclick={() => relaySettings.openDialog()}>
                <Waypoints size={18} aria-hidden="true" />Set up a relay
              </button>
            {/if}
            {#if actions?.retry}
              <button type="button" class="btn btn-primary" data-testid="retry" onclick={onretry}>
                <RotateCw size={18} aria-hidden="true" />Retry
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="card" data-testid="notice" data-code={card.code}>
          <span class="card-icon warning"><SearchX size={32} aria-hidden="true" /></span>
          <h2>{PLAYBACK_ERROR_TITLES[card.code]}</h2>
          <p class="message" class:clamped={!moreOpen} id="no-peers-message">
            {playbackErrorMessage(card.code)}
          </p>
          <button
            type="button"
            class="more"
            aria-expanded={moreOpen}
            aria-controls="no-peers-message"
            onclick={() => (moreOpen = !moreOpen)}
          >
            {moreOpen ? 'Less' : 'More'}
            <span class="chevron" class:up={moreOpen}
              ><ChevronDown size={16} aria-hidden="true" /></span
            >
          </button>
          <div class="ctas">
            <button
              type="button"
              class="btn"
              data-testid="why-link"
              onclick={() => helpDialog.show()}
            >
              <CircleQuestionMark size={18} aria-hidden="true" />Why won’t it play?
            </button>
            {#if !viaRelay}
              <button
                type="button"
                class="btn btn-primary"
                onclick={() => relaySettings.openDialog()}
              >
                <Waypoints size={18} aria-hidden="true" />Connect a relay
              </button>
            {/if}
          </div>
        </div>
        <p class="searching">
          <span class="spinner"><LoaderCircle size={20} aria-hidden="true" /></span>Still searching…
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .states {
    position: absolute;
    inset: 0;
    z-index: var(--z-toast);
    pointer-events: none;
  }
  .toasts {
    position: absolute;
    top: 2.75rem;
    left: 50%;
    display: grid;
    gap: var(--space-2);
    justify-items: center;
    width: min(32rem, 90%);
    transform: translateX(-50%);
  }
  .toasts.hidden {
    opacity: 0;
    visibility: hidden;
  }
  @media (prefers-reduced-motion: no-preference) {
    .toasts {
      transition:
        opacity var(--dur-base) var(--ease-out),
        visibility 0s linear;
    }
    .toasts.hidden {
      transition:
        opacity var(--dur-base) var(--ease-out),
        visibility 0s linear var(--dur-base);
    }
  }
  .toast {
    box-sizing: border-box;
    max-width: 100%;
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
    border-radius: calc(var(--hit) / 2 + var(--space-1));
    background: var(--glass);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    box-shadow: var(--shadow-2);
    pointer-events: auto;
  }
  .toast.open {
    border-radius: var(--radius-lg);
  }
  .toast-row {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    min-width: 0;
  }
  .toast-icon {
    display: inline-grid;
    flex: none;
    margin-right: var(--space-1);
    color: var(--warning);
  }
  .toast-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .toast-message {
    margin: 0 var(--space-3) var(--space-3) 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .toast :global(.icon-button.small) {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
  }
  .toast :global(.icon-button[aria-expanded='true'] svg) {
    transform: rotate(180deg);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
  }
  .card-area {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: center;
    justify-content: center;
    padding: var(--space-3);
    overflow: auto;
  }
  .card {
    box-sizing: border-box;
    width: 100%;
    max-width: 28rem;
    margin: auto 0;
    padding: var(--space-5);
    border-radius: var(--radius-lg);
    background: var(--glass);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    box-shadow: var(--shadow-2);
    pointer-events: auto;
  }
  .card-area:has(.searching) .card {
    margin-bottom: 0;
  }
  .card-icon {
    display: inline-grid;
  }
  .card-icon.danger {
    color: var(--danger);
  }
  .card-icon.warning {
    color: var(--warning);
  }
  h2 {
    margin: var(--space-2) 0 var(--space-1);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
  }
  .message {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .message.clamped {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .more {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    margin-top: var(--space-1);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-fg);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .chevron {
    display: inline-grid;
  }
  .chevron.up {
    transform: rotate(180deg);
  }
  .ctas {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
  .searching {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0 0 auto;
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  }
  .spinner {
    display: inline-grid;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
