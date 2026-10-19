# 0008 — UI: dark icon-first design system, every player control inside the player

Date: 2026-10-19 · Status: accepted (implementation pending) · Extends 0004 (fullscreen, ASS overlay)

## Context

The first UI was a page of form controls: native `<video controls>`, then selects, text buttons and
panels below the video. The owner asked for a modern redesign: everything that belongs to playback
inside the player, as little text as possible, icons first, intuitive on phones. Outside the player
only the link input, the relay and help remain.

## Decision

- **Dark only.** One theme, tokens in `src/styles/tokens.css` (colour, type, space, radius,
  elevation, motion, player layers). Components use the custom properties, never literal colours.
  Text tokens keep at least 4.5:1 against the background. System fonts only, no web fonts.
- **Icons: Lucide, through `@lucide/svelte`** (ISC licence, Svelte 5 components). Import each icon
  from its own module, `import Play from '@lucide/svelte/icons/play'`, so the bundle only carries
  the icons in use. No icon font, sprite or CDN. Icons draw with `currentColor` at `--icon` (20 px),
  stroke 2.
- **Icon-only buttons** always have an `aria-label` and our own tooltip (label plus its shortcut
  key). We don't use `title`: native tooltips lag, look foreign and doubled ours. Text appears only
  where an icon can't carry the meaning: state and error messages, track and file names, menu rows
  in the phone sheet, dialogs.
- **Our control layer on every platform**, iOS included. It overlays the picture in windowed and in
  fullscreen mode and hides with the cursor 1 s after the pointer stops while playing (sooner when
  the pointer leaves). It stays while paused, loading, a menu is open or the pointer is on a control.
  Fullscreen keeps the ADR 0004 split: the player container where it can go fullscreen (the ASS
  canvas stays over the picture), `webkitEnterFullscreen` on the bare `<video>` on iPhone (native
  fullscreen UI, text subtitles), no fullscreen button where neither exists.
- **Menus are panels inside the player's screen container**, positioned by us above the control
  bar. Not the Popover API or CSS anchor positioning: the screen element is what goes fullscreen,
  so anything outside it disappears there, and anchor positioning is not in every browser we
  support. When the screen is too short for a panel (a phone in portrait, not fullscreen), the same
  menu opens as a bottom sheet (`<dialog>` at the bottom of the page). Page dialogs (relay, help)
  opened from inside the player leave fullscreen first.
- **States are shown in the player**: loading, no peers, errors and notices are cards, toasts or
  the spinner over the video, not text below it. Every state keeps its `PlaybackErrorCode`. The
  long copy in `errors.ts` stays available inside the card; a short title per code leads it.

## Consequences

- One look for Chrome, Firefox and WebKit, but we own keyboard, focus and touch behaviour that
  native controls gave us for free. Volume can't be set from script on iOS, so phones show mute only.
- Firefox can't move native text cues (`::-webkit-media-text-track-container`), so while the
  control bar shows it can cover the lowest subtitle line there. It hides after 1 s of playback.
