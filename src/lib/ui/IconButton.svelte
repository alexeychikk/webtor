<script lang="ts">
  /**
   * Icon-only button (docs/decisions/0008): a Lucide icon, an `aria-label` and our own tooltip
   * (label plus shortcut chip), never a `title`. The tooltip shows after 400 ms of mouse hover or at
   * once on keyboard focus, and goes on pointerdown, Esc, blur, leave or when the controls hide.
   * Touch never shows it. It is `aria-hidden`: the label already names the button.
   */
  import type { Component } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { clampShift, controlsShown } from './tooltip-context';

  let {
    icon: Icon,
    label,
    shortcut,
    pressed,
    testid,
    onclick,
    iconSize = 20,
    class: className = '',
    ...rest
  }: {
    icon: Component<{
      size?: number | string;
      strokeWidth?: number | string;
      'aria-hidden'?: 'true' | 'false' | boolean;
    }>;
    label: string;
    /** Key shown in the tooltip's chip, e.g. `F` or `Space`. */
    shortcut?: string;
    /** Toggle state (`aria-pressed`); leave undefined for a plain button. */
    pressed?: boolean;
    testid?: string;
    onclick?: (event: MouseEvent) => void;
    /** Icon size in px (20 in bars; larger in the centre circle). */
    iconSize?: number;
    class?: string;
  } & Omit<HTMLButtonAttributes, 'onclick' | 'title' | 'class'> = $props();

  const HOVER_DELAY_MS = 400;
  const shown = controlsShown();

  let button = $state<HTMLButtonElement>();
  let tip = $state<HTMLSpanElement>();
  let tipShown = $state(false);
  let shift = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** After a press, the tooltip waits until the pointer leaves and comes back. */
  let pressedSinceEnter = false;

  function show() {
    clearTimeout(timer);
    shift = 0;
    tipShown = true;
  }

  function hide() {
    clearTimeout(timer);
    tipShown = false;
  }

  function onPointerEnter(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    pressedSinceEnter = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!pressedSinceEnter) show();
    }, HOVER_DELAY_MS);
  }

  function onPointerDown() {
    pressedSinceEnter = true;
    hide();
  }

  function onFocus() {
    if (button?.matches(':focus-visible')) show();
  }

  $effect(() => {
    if (!shown()) hide();
  });

  $effect(() => {
    if (!tipShown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Clamp the tooltip to the player screen (or the viewport outside a player).
  $effect(() => {
    if (!tip || !button) return;
    const area = button.closest('[data-tooltip-bounds]')?.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    shift = clampShift(r.left, r.right, area?.left ?? 0, area?.right ?? window.innerWidth);
  });

  $effect(() => () => clearTimeout(timer));
</script>

<button
  bind:this={button}
  type="button"
  class="icon-button {className}"
  aria-label={label}
  aria-pressed={pressed}
  data-testid={testid}
  {onclick}
  onpointerenter={onPointerEnter}
  onpointerleave={hide}
  onpointerdown={onPointerDown}
  onfocus={onFocus}
  onblur={hide}
  {...rest}
>
  <Icon size={iconSize} strokeWidth={2} aria-hidden="true" />
  {#if tipShown}
    <span
      bind:this={tip}
      class="tooltip"
      data-testid="tooltip"
      aria-hidden="true"
      style:--shift="{shift}px"
      >{label}{#if shortcut}<kbd>{shortcut}</kbd>{/if}</span
    >
  {/if}
</button>

<style>
  .icon-button {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--hit);
    height: var(--hit);
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  @media (pointer: coarse) {
    .icon-button {
      width: var(--hit-touch);
      height: var(--hit-touch);
    }
  }
  @media (hover: hover) {
    .icon-button:hover {
      background: rgb(255 255 255 / 0.12);
    }
  }
  /* A menu trigger while its menu is open. */
  .icon-button[aria-expanded='true'] {
    background: rgb(255 255 255 / 0.16);
  }
  .icon-button:active {
    transform: scale(0.94);
  }
  .icon-button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px rgb(0 0 0 / 0.5);
  }
  @media (prefers-reduced-motion: no-preference) {
    .icon-button {
      transition:
        background-color var(--dur-fast) var(--ease-out),
        transform var(--dur-fast) var(--ease-out);
    }
  }
  .tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    z-index: 1;
    display: flex;
    gap: var(--space-2);
    align-items: center;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    background: rgb(0 0 0 / 0.85);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: var(--leading-tight);
    white-space: nowrap;
    pointer-events: none;
    transform: translateX(calc(-50% + var(--shift, 0px)));
  }
  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-family: inherit;
    font-size: inherit;
    color: var(--text-muted);
  }
</style>
