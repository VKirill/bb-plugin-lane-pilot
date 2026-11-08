---
title: UI Kit — Overview
type: overview
created: 2026-10-10
updated: 2026-11-08
status: active
confidence: high
tags: [ui-kit, react, components]
sources:
  - packages/ui-kit/package.json
  - package.json
  - packages/ui-kit/src/index.ts
  - packages/ui-kit/src/realtime-channel.ts
  - components.json
  - packages/ui-kit/src/ui/surface.tsx
  - src/rooms/workflow/ui/workflow-actions.tsx
  - src/rooms/workflow/server/workflow.ts
  - src/rooms/platform/server/realtime.ts
  - src/rooms/ui-shell/ui/use-lp-realtime.ts
  - packages/ui-kit/src/ui/button.tsx
  - packages/ui-kit/src/ui/segments.tsx
  - packages/ui-kit/src/lib/utils.ts
---

# UI Kit — Overview

TL;DR: The workspace provides shared React UI components, layout helpers, icons, and realtime channel contracts imported by the Lane Pilot app.

## What it is

The workspace is a private ESM package named @lane-pilot/ui-kit; its package root and type entry point both resolve to src/index.ts, while realtime-channel resolves to src/realtime-channel.ts (packages/ui-kit/package.json:14-17).
The main entry re-exports UI components, utility functions, layout helpers, and icon APIs (packages/ui-kit/src/index.ts:1-31).

The package root exposes React components such as `Surface` (packages/ui-kit/src/ui/surface.tsx:4-27) and `Segments` (packages/ui-kit/src/ui/segments.tsx:9-36).
The realtime subpath exposes the shared signal contract `LpRealtimeSignal` (packages/ui-kit/src/realtime-channel.ts:1-22).
The `Segments` component presents a controlled item set as a select in compact mode or pressed buttons in wide mode (packages/ui-kit/src/ui/segments.tsx:9-36).
See [UI Primitives](features/primitives.md) and [Realtime Signals](features/realtime-signals.md) for their behavior.
Server code imports `LP_ALL_PROJECTS` from the realtime subpath directly (src/rooms/workflow/server/workflow.ts:4).
The channel helper `lpChannel` formats project signal channels (packages/ui-kit/src/realtime-channel.ts:9-10).

## Stack

- Root package dependencies declare `react` 19 along with Radix and Hugeicons packages (package.json:35-49).
- Package metadata defines the private package exports without a build step (packages/ui-kit/package.json:1-18).
- Button component styles are defined using `buttonVariants` with Radix Slot (packages/ui-kit/src/ui/button.tsx:8-59).
- The class name helper `cn` merges utility classes (packages/ui-kit/src/lib/utils.ts:4-7).
- Path aliases are configured in `components.json` for components, UI, and library paths (components.json:1-20).

## Quick start

Import a component from the package root, or the shared server/client signal types and functions from the dedicated subpath:

1. Import UI exports from @lane-pilot/ui-kit (packages/ui-kit/package.json:14-18).
2. Import realtime exports from @lane-pilot/ui-kit/realtime-channel (packages/ui-kit/src/realtime-channel.ts:1-22).
3. Pass component props and compose primitive parts such as `Surface`, `SurfaceBody`, and `SurfaceHeader` (src/rooms/workflow/ui/workflow-actions.tsx:6-10).

## Public entry points

| Import | Contents | Evidence |
|---|---|---|
| @lane-pilot/ui-kit | Components, hooks, utility functions, icon registry, layout and sizing constants | (packages/ui-kit/package.json:14-18); (packages/ui-kit/src/index.ts:1-31) |
| @lane-pilot/ui-kit/realtime-channel | Realtime kinds, signal type, channel helper, parser, and poll intervals | (packages/ui-kit/src/realtime-channel.ts:1-22) |

The package export list is documented in the [Primitives](features/primitives.md); capability details live on [Icons](features/icons.md), [Responsive Layout](features/responsive-layout.md), and [Realtime Signals](features/realtime-signals.md).

## Configuration

The configuration file `components.json` maps shadcn-style aliases to workspace source paths and names app.css for CSS configuration (components.json:1-20).
The package metadata retains icon-extended and overlay-trigger as `sideEffects` files for bundlers (packages/ui-kit/package.json:8-12).

## Consumers

Workflow screens compose `Button`, `Input`, and `Surface` from the package root (src/rooms/workflow/ui/workflow-actions.tsx:6-10).
The shell hook `useLpRealtime` consumes channel signals (src/rooms/ui-shell/ui/use-lp-realtime.ts:1-10).
Server workflows import `LP_ALL_PROJECTS` (src/rooms/workflow/server/workflow.ts:4).
Platform realtime broadcasts through `createRealtime` using `lpChannel` (src/rooms/platform/server/realtime.ts:21-48).

## Where to look next

- [Primitives](features/primitives.md) — component families and root exports.
- [Icons](features/icons.md) — core and extended Hugeicons with fallback resolution.
- [Responsive Layout](features/responsive-layout.md) — measured panel layout and media-query helpers.
- [Realtime Signals](features/realtime-signals.md) — channel naming and signal parsing.
- [Gotchas](gotchas.md) — runtime and integration edge cases.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](../../../docs/architecture.md)
- [Lane Pilot overview](../../../docs/overview.md)
- [Shared packages](../../../docs/packages.md)
