---
title: Responsive Layout Helpers
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [ui-kit, responsive, layout]
sources:
  - packages/ui-kit/src/ui/panel-layout.ts
  - packages/ui-kit/src/ui/coarse-pointer-sizing.ts
  - packages/ui-kit/src/ui/control-row.ts
  - packages/ui-kit/src/ui/hooks/use-media-query.ts
  - packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx
  - packages/ui-kit/src/ui/hooks/use-pointer-coarse.ts
  - packages/ui-kit/src/index.ts
---

# Responsive Layout Helpers

TL;DR: Responsive helpers expose panel-width thresholds, measured widths, viewport and pointer media queries, and shared coarse-pointer CSS class tokens.

## Purpose

These helpers let app UI adapt based on the measured width of its shell or content column, browser media queries, and pointer modality ((packages/ui-kit/src/ui/panel-layout.ts:3-39), (packages/ui-kit/src/ui/hooks/use-media-query.ts:46-70)).

## How it works

1. `useObservedWidth(ref)` initializes width to zero, measures the element on effect, then observes its content width with `ResizeObserver`; cleanup disconnects the observer (packages/ui-kit/src/ui/panel-layout.ts:24-39).
2. Call `chromeIsCompact(shellWidth)` or `contentStacksControls(contentWidth)` to convert measured widths into the layout flags (packages/ui-kit/src/ui/panel-layout.ts:3-15).
3. Provide those flags through `PanelLayoutContext`; consumers read them with `usePanelLayout`, whose default flags are both false (packages/ui-kit/src/ui/panel-layout.ts:16-23).
4. For viewport and device media, `useMediaQuery` subscribes through `useSyncExternalStore`; specialized hooks supply compact viewport, coarse pointer, or reduced-motion queries ((packages/ui-kit/src/ui/hooks/use-media-query.ts:46-70), (packages/ui-kit/src/ui/hooks/use-pointer-coarse.ts:1-7), (packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx:10-36)).
5. Add the exported coarse-pointer class tokens to elements whose dimensions or text size need CSS adaptation ((packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-66), (packages/ui-kit/src/ui/control-row.ts:1-4)).

### Modes and thresholds

| Helper or class group | Input or condition | Output | Evidence |
|---|---|---|---|
| `chromeIsCompact` | Width `> 0` and `<= 448` px | `true`; otherwise `false` | (packages/ui-kit/src/ui/panel-layout.ts:3-10) |
| `contentStacksControls` | Width `> 0` and `<= 350` px | `true`; otherwise `false` | (packages/ui-kit/src/ui/panel-layout.ts:5-14) |
| `useIsCompactViewport` | Viewport at most 767 px unless provider override exists | Media-query result or explicit boolean override | (packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx:10-36) |
| `usePointerCoarse` | `(pointer: coarse)` media query | Boolean media-query snapshot | (packages/ui-kit/src/ui/hooks/use-pointer-coarse.ts:3-7) |
| `usePrefersReducedMotion` | `(prefers-reduced-motion: reduce)` | Boolean media-query snapshot | (packages/ui-kit/src/ui/hooks/use-media-query.ts:3-4; packages/ui-kit/src/ui/hooks/use-media-query.ts:68-70) |
| Coarse-pointer class tokens | CSS `max-md:pointer-coarse` variant | Larger text, icons, row heights, or touch targets as defined per token | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-66) |

### Failures

When `ResizeObserver` is not available, `useObservedWidth` has no fallback path after its initial `getBoundingClientRect()` measurement; if the ref has no node, it returns its initial width without observing (packages/ui-kit/src/ui/panel-layout.ts:24-39). If `window` or `matchMedia` is unavailable, media query snapshots return `false` and subscriptions are no-ops ((packages/ui-kit/src/ui/hooks/use-media-query.ts:13-15; packages/ui-kit/src/ui/hooks/use-media-query.ts:46-65)).

## Business rules

- Width predicates reject zero and negative widths; the initial zero reading therefore yields false for both layout flags ((packages/ui-kit/src/ui/panel-layout.ts:8-14; packages/ui-kit/src/ui/panel-layout.ts:24-26)).
- The shell compact threshold is 448 CSS pixels and the content stack threshold is 350 CSS pixels (packages/ui-kit/src/ui/panel-layout.ts:3-14).
- The compact viewport hook uses an explicit provider value whenever the context is non-null, including `false` ((packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx:12-17; packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx:30-36)).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `SHELL_COMPACT_MAX`, `CONTENT_STACK_MAX`, `chromeIsCompact`, `contentStacksControls`, `PanelLayout`, `PanelLayoutContext`, `usePanelLayout`, `useObservedWidth` | Panel measurement and layout state | (packages/ui-kit/src/ui/panel-layout.ts:4-39) |
| `COARSE_POINTER_TEXT_BASE_CLASS`, `COARSE_POINTER_TEXT_SM_CLASS`, `COARSE_POINTER_ICON_SIZE_CLASS`, `COARSE_POINTER_ICON_SIZE_SHRINK_CLASS`, `COARSE_POINTER_COMPACT_ICON_SIZE_CLASS`, `COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS`, `COARSE_POINTER_DOT_SIZE_CLASS`, `COARSE_POINTER_GLYPH_BOX_CLASS`, `COARSE_POINTER_CHECK_SLOT_CLASS`, `COARSE_POINTER_HEADER_ICON_BUTTON_CLASS`, `COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS`, `COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS`, `COARSE_POINTER_CHILD_ICON_BUTTON_CLASS`, `COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS`, `COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS`, `COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS`, `COARSE_POINTER_PROMPT_COMBO_BUTTON_CLASS`, `COARSE_POINTER_INPUT_HEIGHT_CLASS`, `COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS`, `COARSE_POINTER_ROW_HEIGHT_CLASS`, `COARSE_POINTER_PROVIDER_TAB_SIZE_CLASS`, `COARSE_POINTER_ROW_ACTION_SIZE_CLASS` | CSS class strings for text, icon, input, row, and action sizing | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-66) |
| `CONTROL_H` | Alias for the coarse-pointer input height class | (packages/ui-kit/src/ui/control-row.ts:1-4) |
| `COMPACT_VIEWPORT_QUERY`, `CompactViewportOverrideProvider`, `useIsCompactViewport` | Compact viewport signal and test/host override | (packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx:10-36) |
| `DARK_COLOR_SCHEME_QUERY`, `REDUCED_MOTION_QUERY`, `subscribeMediaQuery`, `getMediaQuerySnapshot`, `useMediaQuery`, `usePrefersReducedMotion` | General media-query subscription API and convenience hook | (packages/ui-kit/src/ui/hooks/use-media-query.ts:3-4; packages/ui-kit/src/ui/hooks/use-media-query.ts:46-70) |
| `POINTER_COARSE_QUERY`, `usePointerCoarse` | Coarse-pointer query and hook | (packages/ui-kit/src/ui/hooks/use-pointer-coarse.ts:3-7) |

## Dependencies

Panel measurement uses React effects and `ResizeObserver`; media-query subscriptions use React `useSyncExternalStore` and the browser `window.matchMedia` API ((packages/ui-kit/src/ui/panel-layout.ts:1; packages/ui-kit/src/ui/panel-layout.ts:24-39), (packages/ui-kit/src/ui/hooks/use-media-query.ts:1; packages/ui-kit/src/ui/hooks/use-media-query.ts:13-65)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Kit — Overview](../overview.md)
