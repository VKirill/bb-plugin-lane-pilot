---
title: UI Primitives
type: component
created: 2026-10-10
updated: 2026-11-08
status: active
confidence: high
tags: [ui-kit, react, components]
sources:
  - packages/ui-kit/src/index.ts
  - packages/ui-kit/src/ui/button.tsx
  - packages/ui-kit/src/ui/select.tsx
  - packages/ui-kit/src/ui/popover.tsx
  - packages/ui-kit/src/ui/alert-dialog.tsx
  - packages/ui-kit/src/ui/disclosure.tsx
  - packages/ui-kit/src/ui/tooltip.tsx
  - packages/ui-kit/src/ui/overlay-trigger.ts
  - packages/ui-kit/src/ui/badge.tsx
  - packages/ui-kit/src/ui/alert.tsx
  - packages/ui-kit/src/ui/tabs.tsx
  - packages/ui-kit/src/ui/input.tsx
  - packages/ui-kit/src/ui/switch.tsx
  - packages/ui-kit/src/ui/coarse-pointer-sizing.ts
  - packages/ui-kit/src/ui/control-row.ts
  - packages/ui-kit/src/ui/icon.tsx
  - packages/ui-kit/src/ui/card.tsx
  - packages/ui-kit/src/ui/surface.tsx
  - packages/ui-kit/src/ui/separator.tsx
  - packages/ui-kit/src/ui/skeleton.tsx
  - packages/ui-kit/src/ui/slider.tsx
  - packages/ui-kit/src/ui/label.tsx
  - packages/ui-kit/src/lib/portal-scope.ts
  - packages/ui-kit/src/lib/utils.ts
  - packages/ui-kit/package.json
  - packages/ui-kit/src/ui/help-sup.tsx
  - packages/ui-kit/src/ui/hooks/use-media-query.ts
  - packages/ui-kit/src/ui/icon-extended.tsx
  - packages/ui-kit/src/ui/icon-registry.ts
  - packages/ui-kit/src/ui/motion.ts
  - packages/ui-kit/src/ui/table.tsx
  - packages/ui-kit/src/ui/panel-layout.ts
  - packages/ui-kit/src/ui/segments.tsx
---

# UI Primitives

TL;DR: The root UI kit entry exports styled React building blocks for controls, overlays, content layout, and small status or helper elements.

## Purpose

The primitives provide common visual and interaction elements used by room UIs, including controls, tabs, tables, notices, disclosures, popovers, tooltips, and surfaces (packages/ui-kit/src/index.ts:1-31). Most primitive wrappers compose Radix primitives or native elements with shared Tailwind class merging ((packages/ui-kit/src/ui/button.tsx:1-6), (packages/ui-kit/src/ui/tabs.tsx:1-5)).

## How it works

1. Import the component or helper from `@lane-pilot/ui-kit`; `src/index.ts` is the package root complete barrel ((packages/ui-kit/package.json:13-18), (packages/ui-kit/src/index.ts:1-31)).
2. Compose controls and compound widgets from their exported parts, such as `Select`, `SelectTrigger`, `SelectContent`, and `SelectItem` ((packages/ui-kit/src/ui/select.tsx:9-15), (packages/ui-kit/src/ui/select.tsx:70-99)).
3. Supply standard element or Radix props and custom classes; wrappers merge styles using `cn` (packages/ui-kit/src/lib/utils.ts:4-6; packages/ui-kit/src/ui/button.tsx:45-54).
4. For portaled content, wrappers attach plugin scoping data attributes; `usePortalScopeProps` adds `data-bb-portaled-overlay`, `data-bb-plugin-root`, `data-bb-ru-skip`, and a compile-time plugin id when defined ((packages/ui-kit/src/lib/portal-scope.ts:3-16), (packages/ui-kit/src/ui/popover.tsx:25-39)).

### Variants and modes

| Family | Modes or defaults | Result | Evidence |
|---|---|---|---|
| `Button` | `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`; sizes `default`, `sm`, `lg`, `icon` | Button classes vary by intent and size; defaults are `default` / `default`; `asChild` renders Radix `Slot` | (packages/ui-kit/src/ui/button.tsx:8-35; packages/ui-kit/src/ui/button.tsx:45-54) |
| `Badge` | `default`, `secondary`, `destructive`, `outline`, `success` | Status-style class set; default is `default` | (packages/ui-kit/src/ui/badge.tsx:6-21) |
| `Alert` | `default`, `destructive` | Semantic `role="alert"` with selected styling | (packages/ui-kit/src/ui/alert.tsx:6-33) |
| `Disclosure` | `compact` true/false; optional controlled `open` | Native `<details>`; compact changes row and body spacing; `onToggle` reports current open state | (packages/ui-kit/src/ui/disclosure.tsx:5-27; packages/ui-kit/src/ui/disclosure.tsx:29-45) |
| `Select` | `position="popper"` default; Radix supports other positions | Portaled dropdown; popper mode sizes viewport to trigger dimensions | (packages/ui-kit/src/ui/select.tsx:70-99) |
| `Popover` | `align="center"`, collision avoidance true, padding 8, side offset 4 | Portaled content with overridable alignment and collision props | (packages/ui-kit/src/ui/popover.tsx:12-42) |
| `Tooltip` | Collision avoidance true, padding 8, side offset 4 | Portaled content; pointer-origin focus does not open it, keyboard-origin focus can | (packages/ui-kit/src/ui/tooltip.tsx:12-27; packages/ui-kit/src/ui/tooltip.tsx:31-59) |
| `Input` | Native input types | Sets `autoComplete="off"` before spreading caller props, so a supplied `autoComplete` overrides it | (packages/ui-kit/src/ui/input.tsx:13-24) |
| `Switch` | `size="sm"` default or `default`; controlled `checked` boolean | Calls `onCheckedChange(!checked)` after click unless prevented | (packages/ui-kit/src/ui/switch.tsx:5-12; packages/ui-kit/src/ui/switch.tsx:14-45) |
| `Segments` | `compact` true/false; optional `badge` values keyed by item id | Compact mode renders a labeled select; wide mode renders pressed ghost buttons; nonzero badge values append to item labels | (packages/ui-kit/src/ui/segments.tsx:9-36) |
| Layout and display | Composite cards, surfaces, tables, tabs, labels, separators, skeletons, sliders, and helper elements | Native or Radix composition with local classes | (packages/ui-kit/src/index.ts:1-31) |

### Icon resolution

1. `Icon` checks `isBuiltinIconName`. If not built in, it resolves to fallback, which defaults to `Zap` (packages/ui-kit/src/ui/icon.tsx:197-209).
2. If the resolved name is not a built-in icon either, `BuiltinIcon` falls back to `Zap` (packages/ui-kit/src/ui/icon.tsx:203-207).
3. Core built-in icons match `CORE_ICON_MAP` and render directly via `BuiltinIcon` (packages/ui-kit/src/ui/icon.tsx:102-153; packages/ui-kit/src/ui/icon.tsx:211-230).
4. Extended icons delegate to `ExtendedIcon`, which subscribes to `getExtendedIcons` and triggers `preloadExtendedIcons()` when an icon definition is missing, rendering an empty placeholder with `data-icon-pending` until registered (packages/ui-kit/src/ui/icon.tsx:172-182; packages/ui-kit/src/ui/icon.tsx:242-271).

| Icon case | Input or condition | Output or failure behavior | Evidence |
|---|---|---|---|
| Core built-in | Resolved name is in `CORE_ICON_MAP` | `BuiltinIcon` renders through `HugeiconsIcon` using the core map entry | (packages/ui-kit/src/ui/icon.tsx:102-153; packages/ui-kit/src/ui/icon.tsx:211-230) |
| Extended built-in | Name is in `EXTENDED_ICON_NAMES` | Reads registered map; missing definition renders empty icon with `data-icon-pending` while `preloadExtendedIcons` loads | (packages/ui-kit/src/ui/icon-registry.ts:3-107; packages/ui-kit/src/ui/icon.tsx:172-182; packages/ui-kit/src/ui/icon.tsx:242-271) |
| Unknown name | Not in built-in set | Resolves to fallback (`Zap` by default); if fallback is also unknown, `BuiltinIcon` renders `Zap` | (packages/ui-kit/src/ui/icon.tsx:201-209; packages/ui-kit/src/ui/icon.tsx:211-230) |

### Failures

- An unknown icon name used inside a primitive resolves through the icon fallback behavior; see [Icons](icons.md) for resolution and load failure details (packages/ui-kit/src/ui/icon.tsx:201-209; packages/ui-kit/src/ui/icon.tsx:242-271).
- `TooltipTrigger` preserves a caller onFocus handler; it suppresses focus only when the event remains unprevented and `isLastInputKeyboard()` returns false ((packages/ui-kit/src/ui/tooltip.tsx:15-27), (packages/ui-kit/src/ui/overlay-trigger.ts:20-22)).
- `Segments` passes `value` and `onChange` to the select in compact mode and derives each wide button pressed state from `value`; it does not validate that `value` matches an item id (packages/ui-kit/src/ui/segments.tsx:18-32).

## Business rules

- The helper `buttonVariants` supplies disabled pointer and opacity styling and focus-visible styling across variants (packages/ui-kit/src/ui/button.tsx:8-10).
- `Switch` is controlled: the caller supplies `checked`; clicking requests the opposite value through `onCheckedChange` and does not mutate internal state (packages/ui-kit/src/ui/switch.tsx:14-45).
- `Disclosure` uses native details state unless the caller supplies `open`, and invokes `onToggle` with the DOM element’s resulting state (packages/ui-kit/src/ui/disclosure.tsx:23-27).
- `Segments` requires the caller to supply the controlled `value`, `onChange`, `compact` mode, and item list; badge text appears only for non-null, nonzero values (packages/ui-kit/src/ui/segments.tsx:9-24).
- Portaled popover, select, tooltip, and alert dialog content receives the plugin scope attributes defined in (packages/ui-kit/src/lib/portal-scope.ts:3-16) ((packages/ui-kit/src/ui/select.tsx:70-78), (packages/ui-kit/src/ui/tooltip.tsx:44-50), (packages/ui-kit/src/ui/alert-dialog.tsx:14-45)).

## Public API

Every export from `src/index.ts` is listed below, grouped by source file. The `realtime-channel` subpath is separate and covered in [Realtime Signals](realtime-signals.md) (packages/ui-kit/package.json:13-18).

| Import names | Source |
|---|---|
| `Disclosure` | (packages/ui-kit/src/ui/disclosure.tsx:5-47) |
| `HelpSup` | (packages/ui-kit/src/ui/help-sup.tsx:8-24) |
| `Surface`, `SurfaceHeader`, `SurfaceBody` | (packages/ui-kit/src/ui/surface.tsx:4-27) |
| `AlertDialog`, `AlertDialogPortal`, `AlertDialogOverlay`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogFooter`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` | (packages/ui-kit/src/ui/alert-dialog.tsx:130-142) |
| `Alert`, `AlertTitle`, `AlertDescription` | (packages/ui-kit/src/ui/alert.tsx:22-57) |
| `Badge`, `badgeVariants`, `BadgeProps` | (packages/ui-kit/src/ui/badge.tsx:24-35) |
| `Button`, `buttonVariants`, `ButtonProps` | (packages/ui-kit/src/ui/button.tsx:38-59) |
| `Card`, `CardHeader`, `CardFooter`, `CardTitle`, `CardDescription`, `CardContent` | (packages/ui-kit/src/ui/card.tsx:76-83) |
| `COARSE_POINTER_TEXT_BASE_CLASS`, `COARSE_POINTER_INPUT_HEIGHT_CLASS` | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-5) |
| `DARK_COLOR_SCHEME_QUERY`, `subscribeMediaQuery`, `getMediaQuerySnapshot`, `useMediaQuery` | (packages/ui-kit/src/ui/hooks/use-media-query.ts:3; packages/ui-kit/src/ui/hooks/use-media-query.ts:45-65) |
| `EXTENDED_ICON_MAP` | (packages/ui-kit/src/ui/icon-extended.tsx:209-313) |
| `EXTENDED_ICON_NAMES`, `registerExtendedIcons`, `getExtendedIcons`, `subscribeExtendedIcons`, `ExtendedIconName`, `ExtendedIconMap` | (packages/ui-kit/src/ui/icon-registry.ts:3-107; packages/ui-kit/src/ui/icon-registry.ts:109-132) |
| `ICON_NAMES`, `preloadExtendedIcons`, `isBuiltinIconName`, `Icon`, `BuiltinIconName`, `IconName`, `IconProps` | (packages/ui-kit/src/ui/icon.tsx:157-165; packages/ui-kit/src/ui/icon.tsx:172-182; packages/ui-kit/src/ui/icon.tsx:186-209) |
| `Input` | (packages/ui-kit/src/ui/input.tsx:10-30) |
| `Label` | (packages/ui-kit/src/ui/label.tsx:6-21) |
| `CONTROL_HOVER_TRANSITION`, `LIST_HOVER_TRANSITION` | (packages/ui-kit/src/ui/motion.ts:1-4) |
| `isLastInputKeyboard` | (packages/ui-kit/src/ui/overlay-trigger.ts:20-22) |
| `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverAnchor`, `PopoverClose` | (packages/ui-kit/src/ui/popover.tsx:7-46) |
| `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel` | (packages/ui-kit/src/ui/select.tsx:149-160) |
| `Separator` | (packages/ui-kit/src/ui/separator.tsx:6-29) |
| `Skeleton` | (packages/ui-kit/src/ui/skeleton.tsx:4-14) |
| `Slider` | (packages/ui-kit/src/ui/slider.tsx:6-26) |
| `Switch` | (packages/ui-kit/src/ui/switch.tsx:5-12; packages/ui-kit/src/ui/switch.tsx:14-62) |
| `Segments` | (packages/ui-kit/src/ui/segments.tsx:9-36) |
| `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, `TableCaption` | (packages/ui-kit/src/ui/table.tsx:111-120) |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | (packages/ui-kit/src/ui/tabs.tsx:6-53) |
| `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` | (packages/ui-kit/src/ui/tooltip.tsx:8-61) |
| `usePortalScopeProps` | (packages/ui-kit/src/lib/portal-scope.ts:3-17) |
| `cn`, `formatHomePathForDisplay` | (packages/ui-kit/src/lib/utils.ts:4-17) |
| `CONTROL_H` | (packages/ui-kit/src/ui/control-row.ts:1-4) |
| `SHELL_COMPACT_MAX`, `CONTENT_STACK_MAX`, `chromeIsCompact`, `contentStacksControls`, `PanelLayoutContext`, `usePanelLayout`, `useObservedWidth`, `PanelLayout` | (packages/ui-kit/src/ui/panel-layout.ts:4-39) |

## Gotchas

- The utility `formatHomePathForDisplay` shortens recognized Unix home paths and Windows user paths; other paths return unchanged (packages/ui-kit/src/lib/utils.ts:8-17).
- Component `Input` sets autoComplete to off before spreading caller props, so callers can override it (packages/ui-kit/src/ui/input.tsx:13-24).
- The token `CONTROL_H` aliases the coarse-pointer input height class `COARSE_POINTER_INPUT_HEIGHT_CLASS` ((packages/ui-kit/src/ui/control-row.ts:1-4), (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:4-5)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Kit — Overview](../overview.md)
