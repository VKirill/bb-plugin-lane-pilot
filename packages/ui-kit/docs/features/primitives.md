---
title: UI Primitives
type: component
created: 2026-10-10
updated: 2026-10-10
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
  - packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx
  - packages/ui-kit/src/ui/hooks/use-media-query.ts
  - packages/ui-kit/src/ui/hooks/use-pointer-coarse.ts
  - packages/ui-kit/src/ui/icon-extended.tsx
  - packages/ui-kit/src/ui/icon-registry.ts
  - packages/ui-kit/src/ui/motion.ts
  - packages/ui-kit/src/ui/table.tsx
  - packages/ui-kit/src/ui/panel-layout.ts
---

# UI Primitives

TL;DR: The root UI kit entry exports styled React building blocks for controls, overlays, content layout, and small status or helper elements.

## Purpose

The primitives provide common visual and interaction elements used by room UIs, including controls, tabs, tables, notices, disclosures, popovers, tooltips, and surfaces (packages/ui-kit/src/index.ts:1-32). Most primitive wrappers compose Radix primitives or native elements with shared Tailwind class merging ((packages/ui-kit/src/ui/button.tsx:1-6), (packages/ui-kit/src/ui/tabs.tsx:1-5)).

## How it works

1. Import the component or helper from `@lane-pilot/ui-kit`; `src/index.ts` is the package root’s complete barrel ((packages/ui-kit/package.json:13-18), (packages/ui-kit/src/index.ts:1-32)).
2. Compose controls and compound widgets from their exported parts, such as `Select`, `SelectTrigger`, `SelectContent`, and `SelectItem` ((packages/ui-kit/src/ui/select.tsx:9-15), (packages/ui-kit/src/ui/select.tsx:70-99)).
3. Supply standard element or Radix props and optionally `className`; wrappers merge custom classes with their base styles using `cn` ((packages/ui-kit/src/ui/button.tsx:45-54), (packages/ui-kit/src/lib/utils.ts:4-6)).
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
| `Input` | Native input types | Sets `autoComplete="off"`, unless caller overrides through later spread props | (packages/ui-kit/src/ui/input.tsx:10-24) |
| `Switch` | `size="sm"` default or `default`; controlled `checked` boolean | Calls `onCheckedChange(!checked)` after click unless prevented | (packages/ui-kit/src/ui/switch.tsx:5-12; packages/ui-kit/src/ui/switch.tsx:14-45) |
| Layout and display | `Card*`, `Surface*`, `Table*`, `Tabs*`, `Label`, `Separator`, `Skeleton`, `Slider`, `HelpSup` | Native or Radix composition with local classes | (packages/ui-kit/src/index.ts:1-32) |

### Failures

- A custom icon used inside a primitive resolves through the icon API’s fallback behavior; see [Icons](icons.md) for resolution and load failure details (packages/ui-kit/src/ui/icon.tsx:225-275).
- The overlay blur helpers return without action when no document exists, no editable field is active, or an optional container does not contain that field (packages/ui-kit/src/ui/overlay-trigger.ts:41-57).
- `TooltipTrigger` preserves a caller’s `onFocus` handler; it suppresses focus only when the event remains unprevented and the last recorded input was not keyboard (packages/ui-kit/src/ui/tooltip.tsx:15-27).

## Business rules

- `Button` supplies disabled pointer and opacity styling and focus-visible styling across variants (packages/ui-kit/src/ui/button.tsx:8-10).
- `Switch` is controlled: the caller supplies `checked`; clicking requests the opposite value through `onCheckedChange` and does not mutate internal state (packages/ui-kit/src/ui/switch.tsx:14-45).
- `Disclosure` uses native details state unless the caller supplies `open`, and invokes `onToggle` with the DOM element’s resulting state (packages/ui-kit/src/ui/disclosure.tsx:23-27).
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
| `COARSE_POINTER_TEXT_BASE_CLASS`, `COARSE_POINTER_TEXT_SM_CLASS`, `COARSE_POINTER_ICON_SIZE_CLASS`, `COARSE_POINTER_ICON_SIZE_SHRINK_CLASS`, `COARSE_POINTER_COMPACT_ICON_SIZE_CLASS`, `COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS`, `COARSE_POINTER_DOT_SIZE_CLASS`, `COARSE_POINTER_GLYPH_BOX_CLASS`, `COARSE_POINTER_CHECK_SLOT_CLASS`, `COARSE_POINTER_HEADER_ICON_BUTTON_CLASS`, `COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS`, `COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS`, `COARSE_POINTER_CHILD_ICON_BUTTON_CLASS`, `COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS`, `COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS`, `COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS`, `COARSE_POINTER_PROMPT_COMBO_BUTTON_CLASS`, `COARSE_POINTER_INPUT_HEIGHT_CLASS`, `COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS`, `COARSE_POINTER_ROW_HEIGHT_CLASS`, `COARSE_POINTER_PROVIDER_TAB_SIZE_CLASS`, `COARSE_POINTER_ROW_ACTION_SIZE_CLASS` | (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:1-66) |
| `COMPACT_VIEWPORT_QUERY`, `CompactViewportOverrideProvider`, `useIsCompactViewport` | (packages/ui-kit/src/ui/hooks/use-compact-viewport.tsx:10-36) |
| `DARK_COLOR_SCHEME_QUERY`, `REDUCED_MOTION_QUERY`, `subscribeMediaQuery`, `getMediaQuerySnapshot`, `useMediaQuery`, `usePrefersReducedMotion` | (packages/ui-kit/src/ui/hooks/use-media-query.ts:3-4; packages/ui-kit/src/ui/hooks/use-media-query.ts:46-70) |
| `POINTER_COARSE_QUERY`, `usePointerCoarse` | (packages/ui-kit/src/ui/hooks/use-pointer-coarse.ts:3-7) |
| `EXTENDED_ICON_MAP` | (packages/ui-kit/src/ui/icon-extended.tsx:209-268) |
| `EXTENDED_ICON_NAMES`, `registerExtendedIcons`, `getExtendedIcons`, `subscribeExtendedIcons`, `setAppIcons`, `getAppIcon`, `subscribeAppIcons`, `ExtendedIconName`, `ExtendedIconMap` | (packages/ui-kit/src/ui/icon-registry.ts:4-6; packages/ui-kit/src/ui/icon-registry.ts:110-160) |
| `ICON_NAMES`, `preloadExtendedIcons`, `isBuiltinIconName`, `Icon`, `BuiltinIconName`, `IconName`, `IconProps` | (packages/ui-kit/src/ui/icon.tsx:165-207; packages/ui-kit/src/ui/icon.tsx:225-277) |
| `Input` | (packages/ui-kit/src/ui/input.tsx:10-30) |
| `Label` | (packages/ui-kit/src/ui/label.tsx:6-21) |
| `CONTROL_HOVER_TRANSITION`, `LIST_HOVER_TRANSITION` | (packages/ui-kit/src/ui/motion.ts:1-4) |
| `getOverlayTriggerClassName`, `blurActiveKeyboardInputWithin`, `blurActiveKeyboardInputBeforeOverlayOpen`, `blurActiveKeyboardInputBeforeOverlayClose`, `preventOverlayTriggerSelection`, `isLastInputKeyboard` | (packages/ui-kit/src/ui/overlay-trigger.ts:20-84) |
| `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverAnchor`, `PopoverClose` | (packages/ui-kit/src/ui/popover.tsx:7-46) |
| `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton` | (packages/ui-kit/src/ui/select.tsx:149-160) |
| `Separator` | (packages/ui-kit/src/ui/separator.tsx:6-29) |
| `Skeleton` | (packages/ui-kit/src/ui/skeleton.tsx:4-14) |
| `Slider` | (packages/ui-kit/src/ui/slider.tsx:6-26) |
| `Switch` | (packages/ui-kit/src/ui/switch.tsx:5-12; packages/ui-kit/src/ui/switch.tsx:14-62) |
| `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, `TableCaption` | (packages/ui-kit/src/ui/table.tsx:111-120) |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | (packages/ui-kit/src/ui/tabs.tsx:6-53) |
| `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` | (packages/ui-kit/src/ui/tooltip.tsx:8-61) |
| `usePortalScopeProps` | (packages/ui-kit/src/lib/portal-scope.ts:3-17) |
| `cn`, `formatHomePathForDisplay` | (packages/ui-kit/src/lib/utils.ts:4-17) |
| `CONTROL_H` | (packages/ui-kit/src/ui/control-row.ts:1-4) |
| `SHELL_COMPACT_MAX`, `CONTENT_STACK_MAX`, `chromeIsCompact`, `contentStacksControls`, `PanelLayoutContext`, `usePanelLayout`, `useObservedWidth`, `PanelLayout` | (packages/ui-kit/src/ui/panel-layout.ts:4-39) |

## Gotchas

- `formatHomePathForDisplay` only shortens recognized Unix home paths (`/Users/<name>`, `/home/<name>`, `/root`) and Windows user paths; other paths are returned unchanged (packages/ui-kit/src/lib/utils.ts:8-17).
- `Input` sets `autoComplete="off"` before spreading caller props, so callers can override it (packages/ui-kit/src/ui/input.tsx:10-24).
- `CONTROL_H` aliases the coarse-pointer input height class, which is `h-9` and becomes `h-10` under the CSS coarse-pointer media variant ((packages/ui-kit/src/ui/control-row.ts:1-4), (packages/ui-kit/src/ui/coarse-pointer-sizing.ts:53-55)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Kit — Overview](../overview.md)
