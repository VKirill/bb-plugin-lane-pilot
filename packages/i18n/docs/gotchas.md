---
title: i18n gotchas
type: gotchas
created: 2026-10-24
updated: 2026-10-25
status: active
confidence: medium
tags: [i18n, pitfalls, localization]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/tests/i18n-duplicate-keys.test.ts
  - packages/i18n/tests/i18n.test.ts
---
# i18n gotchas

TL;DR: Dictionary merges, shared locale overrides, and pass-through fallbacks affect how consumers see translated text (`packages/i18n/src/i18n.ts:2161-2162`, `packages/i18n/src/i18n.ts:2188-2193`, `packages/i18n/src/i18n.ts:2250-2279`).

## Critical

None found in the inspected package code.

## High

None found in the inspected package code.

## Medium

### Later dictionary spreads replace earlier duplicate keys

**Problem:** `en` and `ru` are formed by object spreads, so a repeated key in a later catalog silently replaces the earlier value. The duplicate-key test checks a manually listed subset of English partial catalogs; it does not include the cockpit catalog or every other catalog spread by `i18n.ts` (`packages/i18n/src/i18n.ts:2161-2162`, `packages/i18n/src/i18n-cockpit.ts:2`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:20-31`).

**Risk:** A key collision in a catalog omitted from the test's local list can change the visible string without a merge error and is not covered by that test's collision assertion (`packages/i18n/src/i18n.ts:2161-2162`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:20-31`).

**Workaround:** Use unique keys across catalogs and include any newly added catalog in the duplicate-key test's `partials` object (`packages/i18n/tests/i18n-duplicate-keys.test.ts:20-31`).

### Explicit locale override masks automatic detection

**Problem:** `detectLocale` returns the global override before checking the module override or browser hints (`packages/i18n/src/i18n.ts:2188-2193`).

**Risk:** A still-set override keeps `t()` on that locale even if a consumer observes automatic locale-hint changes (`packages/i18n/src/i18n.ts:2209-2233`).

**Workaround:** Call `setLocaleOverride(null)` to clear both the module and shared global override and resume automatic detection (`packages/i18n/src/i18n.ts:2171-2176`).

## Low

### Unknown labels remain untranslated

**Problem:** `stateLabel` returns an unrecognized state unchanged, and `unappliedReason` returns an unknown reason or unmatched format unchanged (`packages/i18n/src/i18n.ts:2250-2253`, `packages/i18n/src/i18n.ts:2268-2279`).

**Risk:** Raw identifiers or reason text can appear in the UI when upstream values are added without corresponding translations (`packages/i18n/src/i18n.ts:2250-2279`).

**Workaround:** Add the state key or reason mapping and its English and Russian strings before expecting a localized label (`packages/i18n/src/i18n.ts:2161-2166`, `packages/i18n/src/i18n.ts:2255-2270`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](features/locale-and-translation.md)
- [i18n workspace overview](overview.md)
