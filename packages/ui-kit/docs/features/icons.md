---
title: UI Kit Icons
type: component
created: 2026-10-10
updated: 2026-11-08
status: active
confidence: medium
tags: [ui-kit, icons, react]
sources:
  - packages/ui-kit/src/ui/icon.tsx
  - packages/ui-kit/src/ui/icon-registry.ts
  - packages/ui-kit/src/ui/icon-extended.tsx
  - packages/ui-kit/src/index.ts
  - packages/ui-kit/package.json
---

# UI Kit Icons

TL;DR: The `Icon` component resolves names from a core built-in set or a lazily loaded extended set, and renders a fallback icon when a name is unknown.

## Purpose

The icon API gives UI code one `Icon` component, resolving names from `CORE_ICON_MAP` and an extended icon set (packages/ui-kit/src/ui/icon.tsx:102-153; packages/ui-kit/src/ui/icon.tsx:201-209).
The root barrel exports the icon renderer, name lists, and registry functions (packages/ui-kit/src/index.ts:11-13).

## How it works

1. A caller supplies name, with optional fallback, class, style, and accessibility props to `IconProps` (packages/ui-kit/src/ui/icon.tsx:186-193).
2. `Icon` checks `isBuiltinIconName`; an unknown name resolves to fallback, which defaults to `Zap` (packages/ui-kit/src/ui/icon.tsx:197-209).
3. Core built-in icons match `CORE_ICON_MAP` and render directly via `BuiltinIcon` (packages/ui-kit/src/ui/icon.tsx:102-153; packages/ui-kit/src/ui/icon.tsx:211-230).
4. Extended icons match `EXTENDED_ICON_NAMES` and delegate to `ExtendedIcon`, which reads `getExtendedIcons` and subscribes via `subscribeExtendedIcons`; missing icon data triggers `preloadExtendedIcons()` and renders an empty icon placeholder with `data-icon-pending` (packages/ui-kit/src/ui/icon-registry.ts:3-107; packages/ui-kit/src/ui/icon.tsx:172-182; packages/ui-kit/src/ui/icon.tsx:242-271).
5. The extended module registers `EXTENDED_ICON_MAP` via `registerExtendedIcons` at evaluation (packages/ui-kit/src/ui/icon-extended.tsx:209-315); a failed preload clears `extendedIconsLoad` so a later call retries (packages/ui-kit/src/ui/icon.tsx:172-182).

### Modes

| Name source | Input | Rendering path | Failure output | Evidence |
|---|---|---|---|---|
| Core builtin | Name in `CORE_ICON_MAP` | `BuiltinIcon` receives `CORE_ICON_LOOKUP` | Unknown names use fallback first | (packages/ui-kit/src/ui/icon.tsx:102-153; packages/ui-kit/src/ui/icon.tsx:211-230) |
| Extended builtin | Name in `EXTENDED_ICON_NAMES` | `ExtendedIcon` receives `getExtendedIcons` data; missing map triggers `preloadExtendedIcons` | Empty SVG data with `data-icon-pending` until registration | (packages/ui-kit/src/ui/icon-registry.ts:3-107; packages/ui-kit/src/ui/icon.tsx:172-182; packages/ui-kit/src/ui/icon.tsx:242-271) |
| Unknown name | Any other string | `Icon` resolves to fallback (`Zap` by default) | If fallback is also unknown, `BuiltinIcon` uses `Zap` | (packages/ui-kit/src/ui/icon.tsx:201-209; packages/ui-kit/src/ui/icon.tsx:211-230) |

### Failures

An extended import rejection is caught by `ExtendedIcon` for the current render (packages/ui-kit/src/ui/icon.tsx:242-271).
The function `preloadExtendedIcons` clears its cached promise on rejection, allowing a later call to retry (packages/ui-kit/src/ui/icon.tsx:172-182).
When neither the requested name nor fallback resolves to a known built-in name, `Icon` renders `Zap` (packages/ui-kit/src/ui/icon.tsx:201-209).

## Business rules

- Built-in names are the keys in `CORE_ICON_MAP` followed by `EXTENDED_ICON_NAMES`; `isBuiltinIconName` tests membership against `ICON_NAMES` (packages/ui-kit/src/ui/icon.tsx:162-165; packages/ui-kit/src/ui/icon.tsx:197-199).
- `registerExtendedIcons` replaces `extendedIcons` and notifies subscribers unless the same map object is already registered (packages/ui-kit/src/ui/icon-registry.ts:118-122).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `Icon`, `IconProps`, `IconName` | Render a named icon; `IconName` is a string | (packages/ui-kit/src/ui/icon.tsx:158; packages/ui-kit/src/ui/icon.tsx:186-193; packages/ui-kit/src/ui/icon.tsx:201-209) |
| `BuiltinIconName`, `ICON_NAMES`, `isBuiltinIconName` | Built-in name type, list, and membership test | (packages/ui-kit/src/ui/icon.tsx:157; packages/ui-kit/src/ui/icon.tsx:162-165; packages/ui-kit/src/ui/icon.tsx:197-199) |
| `preloadExtendedIcons` | Load extended icon module | (packages/ui-kit/src/ui/icon.tsx:172-182) |
| `EXTENDED_ICON_NAMES`, `ExtendedIconName`, `ExtendedIconMap` | Extended icon name set and map type | (packages/ui-kit/src/ui/icon-registry.ts:3-107; packages/ui-kit/src/ui/icon-registry.ts:109-113) |
| `registerExtendedIcons`, `getExtendedIcons`, `subscribeExtendedIcons` | Manage extended icon map and subscriptions | (packages/ui-kit/src/ui/icon-registry.ts:118-132) |
| `EXTENDED_ICON_MAP` | Concrete lazy module icon map | (packages/ui-kit/src/ui/icon-extended.tsx:209-313) |

## Dependencies

- Core and extended SVG data come from `@hugeicons/core-free-icons` and `@hugeicons/react` (packages/ui-kit/src/ui/icon-registry.ts:1).
- `BuiltinIcon` renders core SVG icons through `HugeiconsIcon` (packages/ui-kit/src/ui/icon.tsx:211-230).
- `ExtendedIcon` renders extended SVG icons through `HugeiconsIcon` (packages/ui-kit/src/ui/icon.tsx:242-271).
- Extended icon dataset defines `EXTENDED_ICON_MAP` (packages/ui-kit/src/ui/icon-extended.tsx:209-313).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Primitives](primitives.md)
- [UI Kit — Overview](../overview.md)
