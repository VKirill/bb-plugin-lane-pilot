---
title: i18n gotchas
type: gotchas
created: 2026-10-24
updated: 2026-11-24
status: active
confidence: medium
tags: [i18n, pitfalls, localization]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/role-names.ts
  - packages/i18n/src/i18n-workflow-library.ts
  - packages/i18n/src/i18n-workflow-export.ts
  - packages/i18n/src/i18n-workflow-map.ts
  - packages/i18n/src/i18n-agent-labels.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/src/i18n-board.ts
  - packages/i18n/tests/i18n-duplicate-keys.test.ts
  - packages/i18n/tests/i18n.test.ts
  - src/rooms/runs/ui/run-card.tsx
  - src/rooms/contracts/agent-display.ts
---
# i18n gotchas

TL;DR: Dictionary merges, shared locale overrides, and pass-through fallbacks affect how consumers see translated text (`packages/i18n/src/i18n.ts:2521-2522`, `packages/i18n/src/i18n.ts:2549-2554`, `packages/i18n/src/i18n.ts:2611-2640`).

## Critical

None found in the inspected package code.

## High

None found in the inspected package code.

## Medium

### Later dictionary spreads replace earlier duplicate keys

**Problem:** `en` and `ru` are formed by object spreads (`packages/i18n/src/i18n.ts:2521-2522`), so a repeated key in a later catalog silently replaces the earlier value. The duplicate-key test checks the hand-listed `partials` subset of English catalogs (`packages/i18n/tests/i18n-duplicate-keys.test.ts:21`); it omits the base dictionary (`chromeEn`, declared at `packages/i18n/src/i18n.ts:25`, which holds the run card, team roster and override-reset keys), and the board, owner, errands, graph, cockpit, role-model, agent-label, workflow-library, export, and map catalogs.

**Risk:** A key collision in an omitted catalog can change the visible string without a merge error and is not covered by that test's collision assertion (`packages/i18n/src/i18n.ts:2521-2522`, `packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

**Workaround:** Use unique keys across catalogs and include any newly added catalog in the duplicate-key test's `partials` object (`packages/i18n/tests/i18n-duplicate-keys.test.ts:21`).

### Explicit locale override masks automatic detection

**Problem:** `detectLocale` returns the global override before checking the module override or browser hints (`packages/i18n/src/i18n.ts:2549-2554`).

**Risk:** A still-set override keeps `t()` on that locale even if a consumer observes automatic locale-hint changes (`packages/i18n/src/i18n.ts:2556-2590`).

**Workaround:** Call `setLocaleOverride(null)` to clear both the module and shared global override and resume automatic detection (`packages/i18n/src/i18n.ts:2532-2537`).

## Low

### Unknown labels remain untranslated

**Problem:** `stateLabel` returns an unrecognized state unchanged, `unappliedReason` returns an unknown reason or unmatched format unchanged, and `roleDisplayName`, `roleLabel`, and `roleName` return an unrecognized role ID unchanged (`packages/i18n/src/i18n.ts:2611-2614`, `packages/i18n/src/i18n.ts:2616-2640`, `packages/i18n/src/role-names.ts:154-163`, `packages/i18n/src/i18n.ts:2652-2654`).

**Risk:** Raw identifiers or reason text can appear in the UI when upstream values or new role IDs are added without corresponding entries (`packages/i18n/src/i18n.ts:2611-2654`, `packages/i18n/src/role-names.ts:148-163`).

**Workaround:** Add the state key, reason mapping, or canonical role entry/alias and its English and Russian strings before expecting a localized label (`packages/i18n/src/i18n.ts:2521-2525`, `packages/i18n/src/i18n.ts:2616-2640`); see [Canonical role names](features/role-names.md).

### New keys can fall out of the exported key type

**Problem:** `I18nKey` is `keyof typeof en` plus `keyof typeof agentLabelEn`; the source comment says that keys added to the large merged object after it grew past the export limit are dropped from `keyof typeof en`. The agent labels live in their own small module so their keys stay in the union (`packages/i18n/src/i18n.ts:2524-2525`, `packages/i18n/src/i18n-agent-labels.ts:3`).

**Risk:** A key added to a big catalog may be a real key at runtime but fail to type-check in `t()`. The agent picker works around it by casting the label keys to `I18nKey` (`src/rooms/contracts/agent-display.ts:63-92`).

**Workaround:** Put new keys that must be typed in a small module and add its `keyof` to the `I18nKey` union, as `agentLabelEn` does (`packages/i18n/src/i18n.ts:2525`).

### Placeholders are not checked

**Problem:** `{stages}`, `{role}`, `{model}`, `{places}` and similar tokens are replaced by the calling component, not by `t`; the parity test compares only key sets and non-empty values (`packages/i18n/src/i18n.ts:2592-2594`, `src/rooms/runs/ui/run-card.tsx:26-27`, `packages/i18n/tests/i18n.test.ts:74-83`).

**Risk:** A Russian string that drops or renames a placeholder passes the parity test, which asserts only equal key sets and non-empty values (`packages/i18n/tests/i18n.test.ts:74-83`); `t` returns the stored string as is, so the literal token stays on screen or the value is lost (`packages/i18n/src/i18n.ts:2592-2594`).

**Workaround:** Copy the placeholder names from the English string when translating, as in `runCardBackgroundFailed` (`packages/i18n/src/i18n.ts:102`, `packages/i18n/src/i18n.ts:1350`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](features/locale-and-translation.md)
- [i18n workspace overview](overview.md)
