---
title: UI Kit Gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [ui-kit, gotchas, browser]
sources:
  - packages/ui-kit/src/ui/hooks/use-media-query.ts
  - packages/ui-kit/src/ui/panel-layout.ts
  - packages/ui-kit/src/ui/overlay-trigger.ts
  - packages/ui-kit/src/ui/icon.tsx
  - packages/ui-kit/src/ui/icon-registry.ts
  - packages/ui-kit/src/ui/tooltip.tsx
  - packages/ui-kit/src/ui/icon-extended.tsx
  - packages/ui-kit/package.json
---

# UI Kit Gotchas

TL;DR: Several UI kit behaviors depend on browser APIs, import-time side effects, or explicit fallback paths that affect server rendering and bundling.

## Critical

## High

### Media queries render false on the server

**Problem:** `useMediaQuery` supplies `false` as the server snapshot and also returns `false` when `window.matchMedia` is missing (packages/ui-kit/src/ui/hooks/use-media-query.ts:53-65).

**Risk:** A server-rendered initial view can differ from the browser snapshot after subscription.

**Workaround:** Treat the initial server value as false when choosing markup that depends on the query (packages/ui-kit/src/ui/hooks/use-media-query.ts:60-65).

### Importing overlay-trigger installs global listeners

**Problem:** When a document exists, module evaluation adds capturing `keydown` and `pointerdown` listeners on `document` (packages/ui-kit/src/ui/overlay-trigger.ts:63-80). The package marks this module as side-effectful for bundlers (packages/ui-kit/package.json:8-12).

**Risk:** Importing this module changes the page-wide last-input-modality state used by tooltip focus behavior ((packages/ui-kit/src/ui/tooltip.tsx:15-27), (packages/ui-kit/src/ui/overlay-trigger.ts:82-84)).

**Workaround:** Keep the module in bundles whenever UI-kit tooltip behavior is imported; package metadata lists it under `sideEffects` (packages/ui-kit/package.json:8-12).

## Medium

### Measured panel widths require ResizeObserver for later updates

**Problem:** `useObservedWidth` reads the element once, then constructs and observes with `ResizeObserver`; it has no observer fallback path (packages/ui-kit/src/ui/panel-layout.ts:24-39).

**Risk:** Without the browser API, later element resizes do not update the width-driven layout flags.

**Workaround:** Use this hook where `ResizeObserver` exists, or pass a width from another measurement path to the pure threshold helpers ((packages/ui-kit/src/ui/panel-layout.ts:8-14; packages/ui-kit/src/ui/panel-layout.ts:24-39)).

### Extended icons show an empty glyph while loading

**Problem:** If extended icon data is missing, the renderer starts a preload and renders empty SVG data with `data-icon-pending`; failed imports are caught for that render (packages/ui-kit/src/ui/icon.tsx:309-337).

**Risk:** The first render may contain no visible icon until registry notification triggers a later render ((packages/ui-kit/src/ui/icon-registry.ts:119-133), (packages/ui-kit/src/ui/icon-extended.tsx:209-268)).

**Workaround:** Call `preloadExtendedIcons()` before displaying UI that must have extended glyphs at first render; rejected loads clear the cached promise and can be retried (packages/ui-kit/src/ui/icon.tsx:180-189).

## Low

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Kit — Overview](overview.md)
