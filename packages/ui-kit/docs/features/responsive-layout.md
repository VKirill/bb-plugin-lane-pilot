---
title: Responsive Layout Helpers
type: component
created: 2026-10-10
updated: 2026-11-08
status: active
confidence: high
tags: [ui-kit, responsive, layout]
sources:
  - packages/ui-kit/src/ui/panel-layout.ts
  - packages/ui-kit/src/ui/coarse-pointer-sizing.ts
  - packages/ui-kit/src/ui/hooks/use-media-query.ts
  - packages/ui-kit/src/ui/control-row.ts
  - packages/ui-kit/src/index.ts
---

# Responsive Layout Helpers

TL;DR: Responsive helpers expose panel-width thresholds, measured widths, media query subscriptions, and shared coarse-pointer CSS class tokens.

## Purpose

These helpers let app UI adapt based on the measured width of its shell or content column, browser media queries, and touch pointer sizing ((packages/ui-kit/src/ui/panel-layout.ts:4-39), (packages/ui-kit/src/ui/hooks/use-media-query.ts:45-65)).

## How it works

1. `useObservedWidth` initializes width to zero, measures the element on effect, then observes its content width with `ResizeObserver`; cleanup disconnects the observer (packages/ui-kit/src/ui/panel-layout.ts:24-39).
2. Call `chromeIsCompact` or `contentStacksControls` to convert measured widths into layout flags (packages/ui-kit/src/ui/panel-layout.ts:8-14).
3. Provide layout flags through `PanelLayoutContext`; consumers read them with `usePanelLayout`, whose default flags are false (packages/ui-kit/src/ui/panel-layout.ts:18-22).
4. For browser media queries, `useMediaQuery` subscribes through `useSyncExternalStore` using cached `createMediaQueryRef` entries, returning boolean snapshots (packages/ui-kit/src/ui/hooks/use-media-query.ts:12-43; packages/ui-kit/src/ui/hooks/use-media-query.ts:59-65).
5. Add exported coarse-pointer class tokens such as `COARSE_POINTER_TEXT_BASE_CLASS` or `COARSE_POINTER_INPUT_HEIGHT_CLASS` to elements whose text size or input height needs touch adaptation ((packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-5), (packages/ui-kit/src/ui/control-row.ts:1-4)).

### Modes and thresholds

| Helper or constant | Input or condition | Output | Evidence |
|---|---|---|---|
| `chromeIsCompact` | Width `> 0` and `<= 448` px (`SHELL_COMPACT_MAX`) | `true`; otherwise `false` | (packages/ui-kit/src/ui/panel-layout.ts:4-10) |
| `contentStacksControls` | Width `> 0` and `<= 350` px (`CONTENT_STACK_MAX`) | `true`; otherwise `false` | (packages/ui-kit/src/ui/panel-layout.ts:6-14) |
| `DARK_COLOR_SCHEME_QUERY` | Media query `"(prefers-color-scheme: dark)"` | Constant query string | (packages/ui-kit/src/ui/hooks/use-media-query.ts:3) |
| `COARSE_POINTER_TEXT_BASE_CLASS` | CSS `max-md:pointer-coarse` text variant | `"text-sm max-md:pointer-coarse:text-base"` | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-2) |
| `COARSE_POINTER_INPUT_HEIGHT_CLASS` | CSS `max-md:pointer-coarse` height variant | `"h-9 max-md:pointer-coarse:h-10"` | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:4-5) |
| `CONTROL_H` | Alias of `COARSE_POINTER_INPUT_HEIGHT_CLASS` | Matches standard control height | (packages/ui-kit/src/ui/control-row.ts:1-4) |

### Failures

When `ResizeObserver` is not available, `useObservedWidth` has no fallback path after its initial measurement; if the ref has no node, it returns its initial width without observing (packages/ui-kit/src/ui/panel-layout.ts:24-39).
If browser APIs are unavailable, `getMediaQuerySnapshot` returns false and `subscribeMediaQuery` returns a no-op cleanup (packages/ui-kit/src/ui/hooks/use-media-query.ts:45-56).

## Business rules

- Width predicates `chromeIsCompact` and `contentStacksControls` reject zero and negative widths; the initial zero reading from `useObservedWidth` yields false for both layout flags ((packages/ui-kit/src/ui/panel-layout.ts:8-14; packages/ui-kit/src/ui/panel-layout.ts:24-26)).
- The shell compact threshold `SHELL_COMPACT_MAX` is 448 CSS pixels and the content stack threshold `CONTENT_STACK_MAX` is 350 CSS pixels (packages/ui-kit/src/ui/panel-layout.ts:4-6).
- The helper `subscribeMediaQuery` shares one event listener per query across subscribers and cleans up cached query refs when listener count reaches zero (packages/ui-kit/src/ui/hooks/use-media-query.ts:45-51).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `SHELL_COMPACT_MAX`, `CONTENT_STACK_MAX`, `chromeIsCompact`, `contentStacksControls`, `PanelLayout`, `PanelLayoutContext`, `usePanelLayout`, `useObservedWidth` | Panel measurement and layout state | (packages/ui-kit/src/ui/panel-layout.ts:4-39) |
| `COARSE_POINTER_TEXT_BASE_CLASS`, `COARSE_POINTER_INPUT_HEIGHT_CLASS` | CSS class strings for text size and control height | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-5) |
| `CONTROL_H` | Alias for the coarse-pointer input height class | (packages/ui-kit/src/ui/control-row.ts:1-4) |
| `DARK_COLOR_SCHEME_QUERY`, `subscribeMediaQuery`, `getMediaQuerySnapshot`, `useMediaQuery` | Media-query subscription API and React hook | (packages/ui-kit/src/ui/hooks/use-media-query.ts:3; packages/ui-kit/src/ui/hooks/use-media-query.ts:45-65) |

## Dependencies

- Panel measurement uses React effects and `ResizeObserver` (packages/ui-kit/src/ui/panel-layout.ts:24-39).
- Media query subscriptions use `useSyncExternalStore` and browser APIs (packages/ui-kit/src/ui/hooks/use-media-query.ts:12-65).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Kit — Overview](../overview.md)
