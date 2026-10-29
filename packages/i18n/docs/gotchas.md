---
title: i18n gotchas
type: gotchas
created: 2026-10-24
updated: 2026-10-29
status: active
confidence: medium
tags: [i18n, pitfalls, localization]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/src/i18n-board.ts
  - packages/i18n/tests/i18n-duplicate-keys.test.ts
  - packages/i18n/tests/i18n.test.ts
  - src/rooms/runs/ui/run-card.tsx
---
# i18n gotchas

TL;DR: Dictionary merges, shared locale overrides, and pass-through fallbacks affect how consumers see translated text (`packages/i18n/src/i18n.ts:2216-2217`, `packages/i18n/src/i18n.ts:2243-2249`, `packages/i18n/src/i18n.ts:2305-2335`).

## Critical

None found in the inspected package code.

## High

None found in the inspected package code.

## Medium

### Later dictionary spreads replace earlier duplicate keys

**Problem:** `en` and `ru` are formed by object spreads, so a repeated key in a later catalog silently replaces the earlier value. The duplicate-key test checks a manually listed subset of English partial catalogs; it omits the base dictionary (`chromeEn`, which holds the run card, team roster and override-reset keys), board, owner, graph, JEV, cockpit, and role-model catalogs (`packages/i18n/src/i18n.ts:20`, `packages/i18n/src/i18n.ts:2216-2217`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

**Risk:** A key collision in an omitted catalog can change the visible string without a merge error and is not covered by that test's collision assertion (`packages/i18n/src/i18n.ts:2216-2217`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

**Workaround:** Use unique keys across catalogs and include any newly added catalog in the duplicate-key test's `partials` object (`packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

### Explicit locale override masks automatic detection

**Problem:** `detectLocale` returns the global override before checking the module override or browser hints (`packages/i18n/src/i18n.ts:2243-2249`).

**Risk:** A still-set override keeps `t()` on that locale even if a consumer observes automatic locale-hint changes (`packages/i18n/src/i18n.ts:2264-2289`).

**Workaround:** Call `setLocaleOverride(null)` to clear both the module and shared global override and resume automatic detection (`packages/i18n/src/i18n.ts:2226-2232`).

## Low

### Unknown labels remain untranslated

**Problem:** `stateLabel` returns an unrecognized state unchanged, and `unappliedReason` returns an unknown reason or unmatched format unchanged (`packages/i18n/src/i18n.ts:2305-2309`, `packages/i18n/src/i18n.ts:2324-2333`).

**Risk:** Raw identifiers or reason text can appear in the UI when upstream values are added without corresponding translations (`packages/i18n/src/i18n.ts:2305-2335`).

**Workaround:** Add the state key or reason mapping and its English and Russian strings before expecting a localized label (`packages/i18n/src/i18n.ts:2216-2221`, `packages/i18n/src/i18n.ts:2310-2325`).

### Placeholders are not checked

**Problem:** `{stages}`, `{role}`, `{model}`, `{places}` and similar tokens are replaced by the calling component, not by `t`; the parity test compares only key sets and non-empty values (`packages/i18n/src/i18n.ts:2286-2289`, `src/rooms/runs/ui/run-card.tsx:24-26`, `packages/i18n/tests/i18n.test.ts:74-84`).

**Risk:** A Russian string that drops or renames a placeholder passes the tests and shows the literal token or loses the value (`packages/i18n/tests/i18n.test.ts:74-84`).

**Workaround:** Copy the placeholder names from the English string when translating, as in `runCardBackgroundFailed` (`packages/i18n/src/i18n.ts:97`, `packages/i18n/src/i18n.ts:1195`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](features/locale-and-translation.md)
- [i18n workspace overview](overview.md)
