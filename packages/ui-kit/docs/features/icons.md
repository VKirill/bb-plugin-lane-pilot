---
title: UI Kit Icons
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [ui-kit, icons, react]
sources:
  - packages/ui-kit/src/ui/icon.tsx
  - packages/ui-kit/src/ui/icon-registry.ts
  - packages/ui-kit/src/ui/icon-extended.tsx
  - packages/ui-kit/src/index.ts
  - packages/ui-kit/package.json
---

# UI Kit Icons

TL;DR: The `Icon` component resolves names from a built-in set, a lazily loaded extended set, or an app registry, and renders a fallback when a name or custom renderer fails.

## Purpose

The icon API gives UI code one `Icon` component for core Hugeicons, an extended icon set, and app-provided React components ((packages/ui-kit/src/ui/icon.tsx:110-173; packages/ui-kit/src/ui/icon.tsx:225-275)). The root barrel exports the icon renderer, name lists, and registry functions (packages/ui-kit/src/index.ts:14-16).

## How it works

1. A caller supplies `name`, with optional `fallback`, `className`, `style`, and accessibility props (packages/ui-kit/src/ui/icon.tsx:194-201).
2. `Icon` checks the app registry and built-in name set; an unknown name resolves to `fallback`, whose default is `Zap` (packages/ui-kit/src/ui/icon.tsx:225-240).
3. Registered app icons render as a component inside a span; built-in core icons render directly; extended icons subscribe to the registry and trigger `preloadExtendedIcons()` when absent ((packages/ui-kit/src/ui/icon.tsx:249-275; packages/ui-kit/src/ui/icon.tsx:278-337)).
4. `icon-extended.tsx` imports the extended icon definitions and registers the complete map at module evaluation ((packages/ui-kit/src/ui/icon-extended.tsx:1-3), (packages/ui-kit/src/ui/icon-extended.tsx:200-268)).
5. A custom icon rendering error is caught by `IconErrorBoundary` and replaced with builtin `Zap`; a failed extended import resets the cached promise so a later preload can retry (packages/ui-kit/src/ui/icon.tsx:180-189; packages/ui-kit/src/ui/icon.tsx:210-223; packages/ui-kit/src/ui/icon.tsx:249-267).

### Modes

| Name source | Input | Rendering path | Failure output | Evidence |
|---|---|---|---|---|
| Core builtin | Name in `CORE_ICON_MAP` | `HugeiconsIcon` receives the mapped SVG data | Unknown names use fallback first | (packages/ui-kit/src/ui/icon.tsx:110-161; packages/ui-kit/src/ui/icon.tsx:278-307) |
| Extended builtin | Name in `EXTENDED_ICON_NAMES` | `HugeiconsIcon` receives registered SVG data; missing map triggers async preload | Empty SVG data with `data-icon-pending` until registration | (packages/ui-kit/src/ui/icon.tsx:170-190; packages/ui-kit/src/ui/icon.tsx:309-337) |
| App icon | Name in `setAppIcons` map | Component receives `className="size-full"` inside a span | Render exception gives builtin `Zap` | (packages/ui-kit/src/ui/icon-registry.ts:136-153), (packages/ui-kit/src/ui/icon.tsx:249-267) |
| Unknown name | Any other string | Resolves to `fallback` (`Zap` by default) | If fallback is also unknown, builtin branch uses `Zap` | (packages/ui-kit/src/ui/icon.tsx:225-240; packages/ui-kit/src/ui/icon.tsx:270-275) |

### Failures

An extended import rejection is swallowed by `ExtendedIcon` for the current render; `preloadExtendedIcons` clears its promise cache on rejection, allowing a later call to retry ((packages/ui-kit/src/ui/icon.tsx:180-189; packages/ui-kit/src/ui/icon.tsx:323-326)). A custom component render exception is handled by the error boundary and displays `Zap` ((packages/ui-kit/src/ui/icon.tsx:210-223; packages/ui-kit/src/ui/icon.tsx:249-267)).

## Business rules

- Built-in names are the keys in `CORE_ICON_MAP` followed by `EXTENDED_ICON_NAMES`; `IconName` itself remains any string, so runtime resolution performs the check (packages/ui-kit/src/ui/icon.tsx:163-176).
- `registerExtendedIcons` replaces the map and notifies subscribers unless the same map object is already registered (packages/ui-kit/src/ui/icon-registry.ts:116-127).
- `setAppIcons` replaces the whole app map and notifies all app icon subscribers (packages/ui-kit/src/ui/icon-registry.ts:136-153).
- App icon definitions provide a component and key; the key is used as the error boundary’s React key ((packages/ui-kit/src/ui/icon-registry.ts:136-149), (packages/ui-kit/src/ui/icon.tsx:249-255)).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `Icon`, `IconProps`, `IconName` | Render a named icon; `IconName` is a string | (packages/ui-kit/src/ui/icon.tsx:165-169; packages/ui-kit/src/ui/icon.tsx:194-201; packages/ui-kit/src/ui/icon.tsx:225-276) |
| `BuiltinIconName`, `ICON_NAMES`, `isBuiltinIconName` | Built-in name type, list, and membership test | (packages/ui-kit/src/ui/icon.tsx:165-173; packages/ui-kit/src/ui/icon.tsx:206-208) |
| `preloadExtendedIcons` | Load extended icon module | (packages/ui-kit/src/ui/icon.tsx:180-190) |
| `EXTENDED_ICON_NAMES`, `ExtendedIconName`, `ExtendedIconMap` | Extended icon name set and map type | (packages/ui-kit/src/ui/icon-registry.ts:4-6; packages/ui-kit/src/ui/icon-registry.ts:110-114) |
| `registerExtendedIcons`, `getExtendedIcons`, `subscribeExtendedIcons` | Manage extended icon map and subscriptions | (packages/ui-kit/src/ui/icon-registry.ts:116-134) |
| `setAppIcons`, `getAppIcon`, `subscribeAppIcons` | Replace, read, and subscribe to app icon definitions | (packages/ui-kit/src/ui/icon-registry.ts:136-160) |
| `EXTENDED_ICON_MAP` | Concrete lazy module icon map | (packages/ui-kit/src/ui/icon-extended.tsx:209-268) |

## Dependencies

Core and extended SVG data come from `@hugeicons/core-free-icons`; rendering uses `@hugeicons/react`; app icons use React `ComponentType` ((packages/ui-kit/src/ui/icon.tsx:1-8), (packages/ui-kit/src/ui/icon-extended.tsx:1-3), (packages/ui-kit/src/ui/icon-registry.ts:1-2)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Primitives](primitives.md)
- [UI Kit — Overview](../overview.md)
