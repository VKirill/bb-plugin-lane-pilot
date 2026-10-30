---
title: i18n gotchas
type: gotchas
created: 2026-10-24
updated: 2026-10-30
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
  - packages/i18n/src/i18n-agent-labels.ts
  - src/rooms/native-agent/agent-display.ts
---
# i18n gotchas

TL;DR: Dictionary merges, shared locale overrides, and pass-through fallbacks affect how consumers see translated text (`packages/i18n/src/i18n.ts:2217-2218`, `packages/i18n/src/i18n.ts:2245-2250`, `packages/i18n/src/i18n.ts:2307-2336`).

## Critical

None found in the inspected package code.

## High

None found in the inspected package code.

## Medium

### Later dictionary spreads replace earlier duplicate keys

**Problem:** `en` and `ru` are formed by object spreads, so a repeated key in a later catalog silently replaces the earlier value. The duplicate-key test checks a manually listed subset of English partial catalogs; it omits the base dictionary (`chromeEn`, which holds the run card, team roster and override-reset keys), board, owner, graph, JEV, cockpit, role-model, and agent-label catalogs (`packages/i18n/src/i18n.ts:21`, `packages/i18n/src/i18n.ts:2217-2218`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

**Risk:** A key collision in an omitted catalog can change the visible string without a merge error and is not covered by that test's collision assertion (`packages/i18n/src/i18n.ts:2217-2218`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

**Workaround:** Use unique keys across catalogs and include any newly added catalog in the duplicate-key test's `partials` object (`packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

### Explicit locale override masks automatic detection

**Problem:** `detectLocale` returns the global override before checking the module override or browser hints (`packages/i18n/src/i18n.ts:2245-2250`).

**Risk:** A still-set override keeps `t()` on that locale even if a consumer observes automatic locale-hint changes (`packages/i18n/src/i18n.ts:2266-2290`).

**Workaround:** Call `setLocaleOverride(null)` to clear both the module and shared global override and resume automatic detection (`packages/i18n/src/i18n.ts:2228-2233`).

## Low

### Unknown labels remain untranslated

**Problem:** `stateLabel` returns an unrecognized state unchanged, and `unappliedReason` returns an unknown reason or unmatched format unchanged (`packages/i18n/src/i18n.ts:2307-2310`, `packages/i18n/src/i18n.ts:2328-2335`).

**Risk:** Raw identifiers or reason text can appear in the UI when upstream values are added without corresponding translations (`packages/i18n/src/i18n.ts:2307-2336`).

**Workaround:** Add the state key or reason mapping and its English and Russian strings before expecting a localized label (`packages/i18n/src/i18n.ts:2217-2223`, `packages/i18n/src/i18n.ts:2312-2327`).

### New keys can fall out of the exported key type

**Problem:** `I18nKey` is `keyof typeof en` plus `keyof typeof agentLabelEn`; the source comment says that keys added to the large merged object after it grew past the export limit are dropped from `keyof typeof en`. The agent labels live in their own small module so their keys stay in the union (`packages/i18n/src/i18n.ts:2220-2221`, `packages/i18n/src/i18n-agent-labels.ts:1`).

**Risk:** A key added to a big catalog may be a real key at runtime but fail to type-check in `t()`. The agent picker works around it by casting the label keys to `I18nKey` (`src/rooms/native-agent/agent-display.ts:56-67`).

**Workaround:** Put new keys that must be typed in a small module and add its `keyof` to the `I18nKey` union, as `agentLabelEn` does (`packages/i18n/src/i18n.ts:2221`).

### Placeholders are not checked

**Problem:** `{stages}`, `{role}`, `{model}`, `{places}` and similar tokens are replaced by the calling component, not by `t`; the parity test compares only key sets and non-empty values (`packages/i18n/src/i18n.ts:2288-2290`, `src/rooms/runs/ui/run-card.tsx:24-26`, `packages/i18n/tests/i18n.test.ts:74-83`).

**Risk:** A Russian string that drops or renames a placeholder passes the parity test, which asserts only equal key sets and non-empty values (`packages/i18n/tests/i18n.test.ts:74-83`); `t` returns the stored string as is, so the literal token stays on screen or the value is lost (`packages/i18n/src/i18n.ts:2288-2290`).

**Workaround:** Copy the placeholder names from the English string when translating, as in `runCardBackgroundFailed` (`packages/i18n/src/i18n.ts:98`, `packages/i18n/src/i18n.ts:1196`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](features/locale-and-translation.md)
- [i18n workspace overview](overview.md)
