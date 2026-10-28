---
title: i18n gotchas
type: gotchas
created: 2026-10-24
updated: 2026-10-28
status: active
confidence: medium
tags: [i18n, pitfalls, localization]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/src/i18n-board.ts
  - packages/i18n/tests/i18n-duplicate-keys.test.ts
  - packages/i18n/tests/i18n.test.ts
---
# i18n gotchas

TL;DR: Dictionary merges, shared locale overrides, and pass-through fallbacks affect how consumers see translated text (`packages/i18n/src/i18n.ts:2182-2183`, `packages/i18n/src/i18n.ts:2210-2215`, `packages/i18n/src/i18n.ts:2272-2301`).

## Critical

None found in the inspected package code.

## High

None found in the inspected package code.

## Medium

### Later dictionary spreads replace earlier duplicate keys

**Problem:** `en` and `ru` are formed by object spreads, so a repeated key in a later catalog silently replaces the earlier value. The duplicate-key test checks a manually listed subset of English partial catalogs; it omits the board, owner, graph, JEV, cockpit, and role-model catalogs (`packages/i18n/src/i18n.ts:2182-2183`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:20-31`).

**Risk:** A key collision in an omitted catalog can change the visible string without a merge error and is not covered by that test's collision assertion (`packages/i18n/src/i18n.ts:2182-2183`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:20-31`).

**Workaround:** Use unique keys across catalogs and include any newly added catalog in the duplicate-key test's `partials` object (`packages/i18n/tests/i18n-duplicate-keys.test.ts:20-31`).

### Explicit locale override masks automatic detection

**Problem:** `detectLocale` returns the global override before checking the module override or browser hints (`packages/i18n/src/i18n.ts:2209-2214`).

**Risk:** A still-set override keeps `t()` on that locale even if a consumer observes automatic locale-hint changes (`packages/i18n/src/i18n.ts:2230-2254`).

**Workaround:** Call `setLocaleOverride(null)` to clear both the module and shared global override and resume automatic detection (`packages/i18n/src/i18n.ts:2192-2197`).

## Low

### Unknown labels remain untranslated

**Problem:** `stateLabel` returns an unrecognized state unchanged, and `unappliedReason` returns an unknown reason or unmatched format unchanged (`packages/i18n/src/i18n.ts:2271-2274`, `packages/i18n/src/i18n.ts:2289-2300`).

**Risk:** Raw identifiers or reason text can appear in the UI when upstream values are added without corresponding translations (`packages/i18n/src/i18n.ts:2271-2300`).

**Workaround:** Add the state key or reason mapping and its English and Russian strings before expecting a localized label (`packages/i18n/src/i18n.ts:2182-2187`, `packages/i18n/src/i18n.ts:2276-2291`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](features/locale-and-translation.md)
- [i18n workspace overview](overview.md)
