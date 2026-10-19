<script lang="ts">
  /**
   * A player menu (docs/decisions/0008 §4). `panel`: a glass panel inside the player screen, 8 px
   * above the control bar and right-aligned under its trigger (`drawer`: the files drawer, along
   * the right edge). `sheet`: a modal bottom `<dialog>` with a grabber, title and Close.
   *
   * Keyboard: ↑/↓/Home/End move the focus between `[data-menu-item]`s without selecting; Enter or
   * Space activates the focused item (options of a listbox are `role=option` elements); Esc closes
   * and gives the focus back to the trigger. A pointerdown outside or the focus leaving a panel
   * closes it too. On open the focus goes to the selected item (`aria-selected`/`aria-current`).
   */
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import X from '@lucide/svelte/icons/x';
  import { tick, type Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';
  import { menuKeyTarget, panelRight, type MenuPresentation } from './menu';

  let {
    title,
    testid,
    presentation,
    drawer = false,
    screen,
    anchor,
    onclose,
    onback,
    children,
  }: {
    title: string;
    testid: string;
    presentation: MenuPresentation;
    /** Panel mode as a right-side drawer of the screen's height (the files list). */
    drawer?: boolean;
    /** The player screen: panels are placed and clamped inside it. */
    screen: HTMLElement;
    /** The trigger: the panel sits above it, a press on it is not "outside", Esc refocuses it. */
    anchor: HTMLElement | null;
    /** `refocus`: give the focus back to the trigger (Esc, Close, a pick). */
    onclose: (refocus: boolean) => void;
    /** A Back row in the header (a menu opened from More). */
    onback?: () => void;
    children: Snippet;
  } = $props();

  let root = $state<HTMLElement>();
  let dialog = $state<HTMLDialogElement>();
  let place = $state<{ right: number; bottom: number; maxHeight: number } | null>(null);
  /** A press on the trigger: its click toggles the menu, so the focus moving there doesn't close it. */
  let anchorPress = false;

  const ITEMS = "[data-menu-item]:not([aria-disabled='true']):not(:disabled)";

  function items(): HTMLElement[] {
    return root ? [...root.querySelectorAll<HTMLElement>(ITEMS)] : [];
  }

  function focusInitial() {
    const el =
      root?.querySelector<HTMLElement>(
        `${ITEMS}[aria-selected='true'], ${ITEMS}[aria-current='true']`,
      ) ??
      items()[0] ??
      root;
    el?.focus({ preventScroll: true });
  }

  /** Panel and drawer placement, from the trigger, the control bar and the screen. */
  function measure() {
    if (presentation !== 'panel' || !root) return;
    const s = screen.getBoundingClientRect();
    const bar = screen.querySelector('[data-player-controls]')?.getBoundingClientRect();
    const bottom = (bar ? s.bottom - bar.top : 72) + 8;
    const a = anchor?.getBoundingClientRect();
    const right = drawer || !a ? 8 : panelRight(a.right - s.left, root.offsetWidth, s.width);
    place = { right, bottom, maxHeight: Math.max(120, s.height - bottom - 8) };
  }

  $effect(() => {
    if (presentation === 'sheet') {
      if (!dialog) return;
      dialog.showModal();
      focusInitial();
      return () => dialog?.close();
    }
    measure();
    // Once placed: the panel is `visibility: hidden` until then, and can't take the focus.
    void tick().then(focusInitial);
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    return () => observer.disconnect();
  });

  // A pointerdown outside closes the menu (the sheet's backdrop: see onDialogClick).
  $effect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || root?.contains(target)) return;
      if (anchor?.contains(target)) {
        anchorPress = true;
        return;
      }
      onclose(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  function onFocusOut() {
    if (presentation !== 'panel') return;
    setTimeout(() => {
      const active = document.activeElement;
      const pressed = anchorPress;
      anchorPress = false;
      // A file chooser (subtitle upload) takes the window's focus; a removed button drops it on
      // the body: neither leaves the menu.
      if (!root?.isConnected || !document.hasFocus() || !active || active === document.body) return;
      if (root.contains(active) || (pressed && anchor?.contains(active))) return;
      onclose(false);
    });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose(true);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const list = items();
    const current = list.indexOf(document.activeElement as HTMLElement);
    const focused = list[current];
    if (
      (event.key === 'Enter' || event.key === ' ') &&
      focused?.getAttribute('role') === 'option'
    ) {
      event.preventDefault();
      focused.click();
      return;
    }
    // Arrows move between items only from an item (not from the delay buttons or a slider).
    if (current < 0 && document.activeElement !== root) return;
    const next = menuKeyTarget(event.key, current, list.length);
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  }

  /** A click on the sheet's backdrop (the dialog element itself, outside its content). */
  function onDialogClick(event: MouseEvent) {
    if (event.target === dialog) onclose(false);
  }

  function onCancel(event: Event) {
    event.preventDefault();
    onclose(true);
  }
</script>

{#snippet header(sheet: boolean)}
  {#if onback || sheet}
    <div class="header">
      {#if onback}
        <button type="button" class="back" data-menu-item aria-label="Back" onclick={onback}>
          <ChevronLeft size={20} aria-hidden="true" />
          {title}
        </button>
      {:else}
        <h2 class="title">{title}</h2>
      {/if}
      {#if sheet}
        <IconButton icon={X} label="Close" onclick={() => onclose(true)} />
      {/if}
    </div>
  {/if}
{/snippet}

{#if presentation === 'sheet'}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <dialog
    bind:this={dialog}
    class="sheet"
    aria-label={title}
    data-player-menu
    data-presentation="sheet"
    onclick={onDialogClick}
    oncancel={onCancel}
  >
    <div
      bind:this={root}
      class="sheet-body"
      data-testid={testid}
      tabindex="-1"
      role="presentation"
      onkeydown={onKeyDown}
    >
      <div class="grabber" aria-hidden="true"></div>
      {@render header(true)}
      <div class="content">{@render children()}</div>
    </div>
  </dialog>
{:else}
  <div
    bind:this={root}
    class="panel"
    class:drawer
    class:placed={place !== null}
    data-testid={testid}
    data-player-menu
    data-presentation="panel"
    role="dialog"
    aria-label={title}
    tabindex="-1"
    style:right={place ? `${place.right}px` : undefined}
    style:bottom={place ? `${place.bottom}px` : undefined}
    style:max-height={place ? `${place.maxHeight}px` : undefined}
    onkeydown={onKeyDown}
    onfocusout={onFocusOut}
  >
    {@render header(false)}
    {#if drawer}<h2 class="title drawer-title">{title}</h2>{/if}
    <div class="content">{@render children()}</div>
  </div>
{/if}

<style>
  .panel {
    position: absolute;
    right: 8px;
    bottom: 80px;
    z-index: var(--z-menu);
    display: flex;
    flex-direction: column;
    width: 20rem;
    max-width: calc(100% - 16px);
    border-radius: var(--radius-lg);
    background: var(--glass);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-sm);
    overflow: hidden;
    visibility: hidden;
  }
  .panel.placed {
    visibility: visible;
  }
  .panel.drawer {
    top: 8px;
    width: min(24rem, 90%);
    max-height: none !important;
  }
  .panel:focus {
    outline: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    .panel.placed {
      animation: rise var(--dur-base) var(--ease-out);
    }
    .sheet[open] {
      animation: slide-up var(--dur-slow) var(--ease-out);
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @keyframes slide-up {
    from {
      transform: translateY(100%);
    }
  }
  .content {
    flex: 1;
    min-height: 0;
    padding: var(--space-2) 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2) 0 var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
  }
  .drawer-title {
    flex: none;
    padding: var(--space-3) var(--space-4) var(--space-1);
  }
  .back {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--hit);
    margin-left: calc(-1 * var(--space-2));
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-weight: var(--weight-bold);
    cursor: pointer;
  }
  .back:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }

  .sheet {
    position: fixed;
    inset: auto 0 0;
    width: 100%;
    max-width: 100%;
    max-height: 70vh;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--text-sm);
    box-shadow: var(--shadow-2);
  }
  .sheet::backdrop {
    background: rgb(0 0 0 / 0.5);
  }
  .sheet-body {
    display: flex;
    flex-direction: column;
    max-height: 70vh;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .sheet-body:focus {
    outline: none;
  }
  .grabber {
    flex: none;
    width: 2.5rem;
    height: 4px;
    margin: var(--space-2) auto 0;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .sheet .header {
    padding-top: 0;
  }
</style>
