---
title: UI Kit — Overview
type: overview
created: 2026-10-10
updated: 2026-10-10
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
  - src/rooms/core/server/realtime.ts
  - src/rooms/ui-shell/ui/use-lp-realtime.ts
  - packages/ui-kit/src/ui/button.tsx
  - packages/ui-kit/src/lib/utils.ts
---

# UI Kit — Overview

TL;DR: `@lane-pilot/ui-kit` provides the shared React UI components, layout helpers, icons, and realtime channel contract imported by the Lane Pilot app.

## What it is

The workspace is a private ESM TypeScript package named `@lane-pilot/ui-kit`; its package root and type entry point both resolve to `src/index.ts`, while `./realtime-channel` resolves to `src/realtime-channel.ts` (packages/ui-kit/package.json:1-18). The main entry re-exports UI components, hooks, utility functions, layout helpers, and icon APIs (packages/ui-kit/src/index.ts:1-32).

The package root exposes React components such as `Surface` (packages/ui-kit/src/ui/surface.tsx:1-19), while the realtime subpath exposes the shared signal contract (packages/ui-kit/src/realtime-channel.ts:1-22). See [UI Primitives](features/primitives.md) and [Realtime Signals](features/realtime-signals.md) for their behavior. Server code imports the realtime subpath directly (src/rooms/workflow/server/workflow.ts:1-2; src/rooms/core/server/realtime.ts:1-2).

## Stack

- The root package declares React 19, Radix primitives, Hugeicons, `class-variance-authority`, `clsx`, and `tailwind-merge`; the UI kit package metadata has no `dependencies` field (package.json:1-22; packages/ui-kit/package.json:1-18; packages/ui-kit/src/ui/button.tsx:1-6; packages/ui-kit/src/lib/utils.ts:1-2).
- TypeScript source is exposed directly through package exports; this package declares no build script (packages/ui-kit/package.json:1-18).
- Tailwind class aliases are set in the repository `components.json`, with UI source at `packages/ui-kit/src/ui`, utilities at `packages/ui-kit/src/lib`, and hooks at `packages/ui-kit/src/ui/hooks` (components.json:1-20).

## Quick start

Import a component from the package root, or the shared server/client signal types and functions from the dedicated subpath:

1. Import UI exports from `@lane-pilot/ui-kit` ((packages/ui-kit/package.json:13-18), (packages/ui-kit/src/index.ts:1-32)).
2. Import realtime exports from `@lane-pilot/ui-kit/realtime-channel` (packages/ui-kit/package.json:16-18).
3. Pass component props and compose the primitive parts in React; for example, app screens compose `Surface`, `SurfaceBody`, and `SurfaceHeader` (src/rooms/workflow/ui/workflow-actions.tsx:6-10).

## Public entry points

| Import | Contents | Evidence |
|---|---|---|
| `@lane-pilot/ui-kit` | Components, hooks, utility functions, icon registry, layout and sizing constants | (packages/ui-kit/package.json:13-18); (packages/ui-kit/src/index.ts:1-32) |
| `@lane-pilot/ui-kit/realtime-channel` | Realtime kinds, signal type, channel helper, parser, and poll intervals | (packages/ui-kit/package.json:16-18); (packages/ui-kit/src/realtime-channel.ts:1-22) |

The package export list is documented in the [Primitives](features/primitives.md); capability details live on [Icons](features/icons.md), [Responsive Layout](features/responsive-layout.md), and [Realtime Signals](features/realtime-signals.md).

## Configuration

`components.json` maps the shadcn-style aliases to this workspace’s source paths and names `app.css` for CSS configuration (components.json:1-20). The package metadata retains `src/ui/icon-extended.tsx` and `src/ui/overlay-trigger.ts` as side-effect files for bundlers (packages/ui-kit/package.json:8-12).

## Consumers

The app imports the root entry from workflow UI and the realtime subpath from UI and server code (src/rooms/workflow/ui/workflow-actions.tsx:6-10; src/rooms/ui-shell/ui/use-lp-realtime.ts:1-3; src/rooms/workflow/server/workflow.ts:1-2).

## Where to look next

- [Primitives](features/primitives.md) — component families and root exports.
- [Icons](features/icons.md) — builtin, extended, and app-registered icons.
- [Responsive Layout](features/responsive-layout.md) — measured panel layout and media-query helpers.
- [Realtime Signals](features/realtime-signals.md) — channel naming and signal parsing.
- [Gotchas](gotchas.md) — runtime and integration edge cases.
