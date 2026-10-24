---
title: Locale resolution and translation
type: component
created: 2026-10-24
updated: 2026-10-24
status: active
confidence: high
tags: [i18n, locale, translations]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n-graph.ts
  - packages/i18n/src/i18n-fields.ts
  - packages/i18n/tests/i18n.test.ts
  - packages/settings-catalog/src/channels.ts
  - packages/i18n/package.json
  - app.tsx
  - src/rooms/runs/server/rpc/runs.ts
---
# Locale resolution and translation

TL;DR: This component merges English and Russian UI catalogs, selects a locale from a shared override or browser hints, and exposes typed translation and label helpers (`packages/i18n/src/i18n.ts:2160-2165`, `packages/i18n/src/i18n.ts:2187-2233`).

## Purpose

The component provides shared text for the plugin UI. `I18nKey` is derived from the English dictionary, `Locale` is `"en" | "ru"`, and the Russian dictionary is constrained to the English key set (`packages/i18n/src/i18n.ts:2160-2165`). Catalog files partition strings by feature; for example, settings field strings and work-graph strings are exported as typed EN/RU pairs (`packages/i18n/src/i18n-fields.ts:1`, `packages/i18n/src/i18n-fields.ts:974`, `packages/i18n/src/i18n-graph.ts:2`, `packages/i18n/src/i18n-graph.ts:59`).

## How it works

1. The package entry point re-exports `i18n.ts`; that module imports each catalog pair and `UNAPPLIED_REASON` from `settings-catalog` (`packages/i18n/src/index.ts:1`, `packages/i18n/src/i18n.ts:1-16`).
2. `en` merges the base English strings and each English catalog; `ru` merges the corresponding Russian catalogs and uses the English dictionary's keys as its type (`packages/i18n/src/i18n.ts:2160-2161`).
3. `detectLocale` checks the global override shared across bundles, then the module override, then calls `detectLocaleHint` (`packages/i18n/src/i18n.ts:2187-2192`).
4. `detectLocaleHint` recognizes the Russianizer only when its footer marker exists; local storage value `"off"` disables that hint, while other values leave it enabled. Storage access exceptions are caught (`packages/i18n/src/i18n.ts:2194-2205`).
5. `localeFromSources` chooses Russianizer hint first, then a non-empty navigator language, then a non-default document language, and otherwise English. A recognized language prefix `ru` maps to Russian; other supplied languages map to English (`packages/i18n/src/i18n.ts:2177-2185`).
6. `t` returns the key's value from the selected dictionary. `subscribeToLocaleHintChanges` watches document mutations and matching storage events, notifies only when its detected hint changes, and returns a disposer that disconnects both listeners (`packages/i18n/src/i18n.ts:2208-2232`).
7. Specialized helpers map validation codes, state names, and unapplied reasons to translated strings; unknown state names and unknown reason formats are returned unchanged (`packages/i18n/src/i18n.ts:2234-2278`).

### Locale modes

| Mode | Input and precedence | Output | Failure or fallback |
|---|---|---|---|
| Explicit override | `setLocaleOverride("en" | "ru")`; global override is checked before module-local state | Forced dictionary locale | Passing `null` clears both override values, after which detection uses hints (`packages/i18n/src/i18n.ts:2167-2175`, `packages/i18n/src/i18n.ts:2187-2192`) |
| Automatic detection | Russianizer marker and storage hint, navigator language, document language | `ru` for Russian prefixes; otherwise `en` | Missing hints resolve to English; storage exceptions do not abort detection (`packages/i18n/src/i18n.ts:2177-2205`) |
| Hint subscription | Document mutations and storage events for the Russianizer key or a cleared storage event | Callback receives a changed detected locale | Without `MutationObserver` or a document root, only the storage listener can notify; disposer removes active observers/listeners (`packages/i18n/src/i18n.ts:2208-2227`) |

### Message helper behavior

| Helper | Accepted input | Result and fallback |
|---|---|---|
| `validationMessage` | Six literal codes and a `string[]` parameter list | Four setup codes return fixed translations; `invalid_choice` substitutes `params[0..1]`; remaining code path uses `params[0..3]` for the incompatible-setting message (`packages/i18n/src/i18n.ts:2234-2247`) |
| `stateLabel` | Any string | Translates `state_<value>` if that key exists in English; otherwise returns the input (`packages/i18n/src/i18n.ts:2249-2252`) |
| `unappliedReason` | Any string | Maps known catalog reason constants and a recognized invalid-flag format; unknown reasons pass through unchanged (`packages/i18n/src/i18n.ts:2254-2278`, `packages/settings-catalog/src/channels.ts:19`) |
| `currentStrings` | No arguments | Returns the current translations for enable, enabling, failed, and already active (`packages/i18n/src/i18n.ts:2280-2287`) |

## Business rules

- Only English and Russian are supported by the `Locale` type (`packages/i18n/src/i18n.ts:2163-2165`).
- The Russianizer hint wins over navigator and document language; the navigator value wins over the document value when present (`packages/i18n/src/i18n.ts:2177-2185`).
- Only an explicit local-storage value of `"off"` disables the Russianizer hint, and the hint is read only when the plugin footer marker exists (`packages/i18n/src/i18n.ts:2197-2204`).
- Locale override is stored on `globalThis` as well as in module state so separate plugin bundles can observe the explicit selection (`packages/i18n/src/i18n.ts:2167-2175`).
- Known unapplied-reason strings are sourced from `UNAPPLIED_REASON`; unsupported input is preserved instead of replaced with a fabricated translation (`packages/i18n/src/i18n.ts:2254-2278`, `packages/settings-catalog/src/channels.ts:19`).

## Public API

All declarations below are exported from `i18n.ts` and re-exported by the package root (`packages/i18n/src/index.ts:1`).

| Import | Source | Purpose |
|---|---|---|
| `en`, `ru` | `packages/i18n/src/i18n.ts:2160-2161` | Complete English and Russian dictionaries |
| `I18nKey`, `Locale`, `LocalePreference` | `packages/i18n/src/i18n.ts:2163-2165` | Translation key and locale types |
| `setLocaleOverride(next)` | `packages/i18n/src/i18n.ts:2170-2175` | Set or clear explicit shared locale override |
| `localeFromSources(documentLanguage?, navigatorLanguage?, russianizerHint?)` | `packages/i18n/src/i18n.ts:2177-2185` | Resolve a locale from supplied hints |
| `detectLocale()` | `packages/i18n/src/i18n.ts:2187-2192` | Read override or browser hints |
| `detectLocaleHint()` | `packages/i18n/src/i18n.ts:2194-2206` | Read browser and Russianizer hints |
| `subscribeToLocaleHintChanges(listener)` | `packages/i18n/src/i18n.ts:2208-2228` | Listen for automatic hint changes; returns cleanup function |
| `t(key)` | `packages/i18n/src/i18n.ts:2230-2232` | Return translated string for a typed key |
| `validationMessage(code, params)` | `packages/i18n/src/i18n.ts:2234-2247` | Translate supported validation errors |
| `stateLabel(state)` | `packages/i18n/src/i18n.ts:2249-2252` | Translate known state key or preserve input |
| `unappliedReason(reason)` | `packages/i18n/src/i18n.ts:2254-2278` | Translate known setting-application reason or preserve input |
| `currentStrings()` | `packages/i18n/src/i18n.ts:2280-2287` | Return four current activation strings |

## Package shape

- `src/index.ts` is the sole package entry point (`packages/i18n/src/index.ts:1`, `packages/i18n/package.json:10-13`).
- `src/i18n.ts` merges the base dictionary, feature catalogs, and locale helpers (`packages/i18n/src/i18n.ts:1-16`, `packages/i18n/src/i18n.ts:2160-2287`).
- `src/i18n-*.ts` files hold feature-specific English and Russian pairs; `i18n-graph.ts` documents its domain and merge ownership in its header (`packages/i18n/src/i18n-graph.ts:1-2`).

## Internal model

Catalogs are plain objects. The English dictionary defines the valid key union, and the Russian dictionary is assigned the mapped type `{ [K in keyof typeof en]: string }` (`packages/i18n/src/i18n.ts:2160-2165`). Runtime translation performs a direct lookup in one of those objects; interpolation is performed only by dedicated helpers such as `validationMessage`, while callers replace placeholders in ordinary catalog strings when needed (`packages/i18n/src/i18n.ts:2230-2247`).

## Dependencies

`i18n.ts` imports `UNAPPLIED_REASON` from `@lane-pilot/settings-catalog`; all other imports are local catalog modules (`packages/i18n/src/i18n.ts:1-16`). Consumers include the root plugin app and room modules in the monorepo (`app.tsx:3`, `src/rooms/runs/server/rpc/runs.ts:1`).

## Gotchas

See [Gotchas](../gotchas.md) for key collision behavior, override precedence, and unchanged fallback values.

<!-- lane-pilot:backlinks -->
## Referenced by

- [i18n workspace overview](../overview.md)
