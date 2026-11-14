---
title: Canonical role names
type: component
created: 2026-11-14
updated: 2026-11-14
status: active
confidence: medium
tags: [i18n, role-names, agents, localization]
sources:
  - packages/i18n/src/role-names.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-agent-labels.ts
  - packages/i18n/src/i18n-role-models.ts
  - tests/agents-doc.test.ts
  - src/rooms/pages/tab-team.tsx
  - src/rooms/native-agent/ui/helper-threads.tsx
  - src/rooms/council/ui/council-page.tsx
  - src/rooms/native-agent/server/agents-cli.ts
  - src/rooms/tools/server/cli-project.ts
---
# Canonical role names

TL;DR: `role-names.ts` is the single bilingual registry of display names, kinds, and groups for every Lane Pilot agent, single-call judge, and Codex config profile, re-exported at the package root (`packages/i18n/src/role-names.ts:1-160`, `packages/i18n/src/index.ts:1-2`).

## Purpose

The component ensures every internal role identifier—whether used in settings keys, thread roles, workflow steps, or CLI commands—resolves to one unique display name per language (`packages/i18n/src/role-names.ts:2-6`). Each entry in `ROLE_NAMES` pairs its Russian (`ru`) and English (`en`) names with a `RoleKind` (`"agent" | "judge" | "profile" | "code"`) and a `RoleGroup` (`"management" | "coders" | "checkers" | "memory" | "council" | "specialists" | "service"`) (`packages/i18n/src/role-names.ts:14-21`). Dictionary modules (`i18n.ts`, `i18n-agent-labels.ts`, `i18n-role-models.ts`) pull role names from this map instead of duplicating strings (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n-agent-labels.ts:1`, `packages/i18n/src/i18n-role-models.ts:1`).

## How it works

1. `ROLE_NAMES` defines every canonical role entry using internal `agent`, `judge`, and `profile` factory helpers across seven groups (`packages/i18n/src/role-names.ts:18-109`).
2. `ROLE_ID_ALIASES` maps legacy names, thread-specific identifiers, and `specialist:<employee>` prefixes onto canonical `RoleNameId` keys (`packages/i18n/src/role-names.ts:118-138`).
3. `canonicalRoleId(id)` checks whether `id` is an own property of `ROLE_NAMES`; if not, it looks up `ROLE_ID_ALIASES[id]` and returns `null` when neither matches (`packages/i18n/src/role-names.ts:141-144`).
4. `roleDisplayName(id, lang)` resolves `canonicalRoleId(id)` and returns `ROLE_NAMES[key][lang]`, defaulting `lang` to `"ru"`; `roleLabel(id, lang)` formats `${ROLE_NAMES[key][lang]} (${id})` for CLI output where the raw ID must remain visible (`packages/i18n/src/role-names.ts:147-156`).
5. `roleNameEn(id)` and `roleNameRu(id)` bind `lang` to `"en"` and `"ru"` for static dictionary initialization, while `roleName(id)` in `i18n.ts` calls `roleDisplayName(id, detectLocale())` for runtime UI rendering (`packages/i18n/src/role-names.ts:159-160`, `packages/i18n/src/i18n.ts:2596-2598`).

### Resolution modes and kinds

| Mode or classification | Input / values | Output / behavior | Fallback / constraint |
|---|---|---|---|
| `canonicalRoleId(id)` | Direct `RoleNameId` or key in `ROLE_ID_ALIASES` | Returns canonical `RoleNameId` (`packages/i18n/src/role-names.ts:141-144`) | Returns `null` when unknown (`packages/i18n/src/role-names.ts:143`) |
| `roleDisplayName(id, lang)` | Any role ID; `lang` `"ru" \| "en"` (default `"ru"`) | Localized display name (`packages/i18n/src/role-names.ts:147-150`) | Returns raw `id` unchanged when `canonicalRoleId(id)` is `null` (`packages/i18n/src/role-names.ts:149`) |
| `roleLabel(id, lang)` | Any role ID; `lang` `"ru" \| "en"` (default `"ru"`) | `"Name (id)"` keeping the caller's `id` in parentheses (`packages/i18n/src/role-names.ts:153-156`) | Returns raw `id` unchanged when `canonicalRoleId(id)` is `null` (`packages/i18n/src/role-names.ts:155`) |
| `roleName(id)` | Any role ID | Delegates to `roleDisplayName(id, detectLocale())` (`packages/i18n/src/i18n.ts:2596-2598`) | Same pass-through fallback as `roleDisplayName` (`packages/i18n/src/role-names.ts:149`) |
| `RoleKind` | `"agent"`, `"judge"`, `"profile"`, `"code"` (`packages/i18n/src/role-names.ts:14`) | Distinguishes LLM sessions (`agent`), single-call judges (`judge`: `memory-judge`, `jev`), Codex tool profiles (`profile`), and deterministic code (`code`) (`packages/i18n/src/role-names.ts:8-12`, `packages/i18n/src/role-names.ts:53`, `packages/i18n/src/role-names.ts:64`, `packages/i18n/src/role-names.ts:106-108`) | `profile` entries use group `"service"` (`packages/i18n/src/role-names.ts:20`) |

## Business rules

- Every role identifier known across the models table, helper roles, council seats, writer fallback slots, errand kinds, Codex lean profiles, stock agent descriptions, workflow graphs, and legacy thread roles must resolve via `canonicalRoleId` (`tests/agents-doc.test.ts:33-55`).
- No two entries in `ROLE_NAMES` can share a trimmed, lowercased display name in either `"ru"` or `"en"`, and no entry name can be empty (`tests/agents-doc.test.ts:57-67`).
- `ROLE_ID_ALIASES` keys must not appear in `ROLE_NAMES`, and every alias target must exist in `ROLE_NAMES` (`tests/agents-doc.test.ts:69-74`).
- Codex config profiles (`codex-profile:code`, `codex-profile:quiet`, `codex-profile:open`) must have `kind: "profile"` and remain distinct from `writer` (`packages/i18n/src/role-names.ts:20`, `packages/i18n/src/role-names.ts:106-108`, `tests/agents-doc.test.ts:76-82`).
- `specialist:lead` is its own canonical entry in `ROLE_NAMES` separate from `lead`, whereas the other twelve `specialist:<employee>` IDs are aliases pointing to `<employee>` (`packages/i18n/src/role-names.ts:25-26`, `packages/i18n/src/role-names.ts:126-137`).
- Dictionary keys prefixed with `accessName_`, `roleModelName_`, and `settingCouncilSeat_`, along with `helperRole_writer` and `agentDisplayDevOrchestrator`, draw their values from `ROLE_NAMES` (`packages/i18n/src/i18n.ts:106`, `packages/i18n/src/i18n.ts:227`, `packages/i18n/src/i18n.ts:308`, `packages/i18n/src/i18n.ts:1155`, `packages/i18n/src/i18n-role-models.ts:25`, `tests/agents-doc.test.ts:93-105`).

## Public API

All declarations from `role-names.ts` and `roleName` (`packages/i18n/src/i18n.ts:2596-2598`) are re-exported by the package entry point (`packages/i18n/src/index.ts:1-2`).

| Import | Source | Purpose |
|---|---|---|
| `RoleKind`, `RoleGroup`, `RoleNameEntry`, `RoleNameId` | `packages/i18n/src/role-names.ts:14-16`, `packages/i18n/src/role-names.ts:111` | Classification and key types for canonical role entries |
| `ROLE_NAMES`, `ROLE_NAME_IDS` | `packages/i18n/src/role-names.ts:22-112` | Canonical role-name registry and ordered key array |
| `ROLE_ID_ALIASES` | `packages/i18n/src/role-names.ts:118-138` | Map from alias and `specialist:*` IDs to `RoleNameId` |
| `canonicalRoleId(id)` | `packages/i18n/src/role-names.ts:141-144` | Resolve direct ID or alias to `RoleNameId \| null` |
| `roleDisplayName(id, lang?)` | `packages/i18n/src/role-names.ts:147-150` | Return `"ru"` (default) or `"en"` display name, or raw `id` |
| `roleLabel(id, lang?)` | `packages/i18n/src/role-names.ts:153-156` | Return `"Name (id)"` for CLI output, or raw `id` |
| `roleNameEn(id)`, `roleNameRu(id)` | `packages/i18n/src/role-names.ts:159-160` | Single-language helpers for static i18n dictionaries |
| `roleName(id)` | `packages/i18n/src/i18n.ts:2596-2598` | Return display name in `detectLocale()` language |

## Package shape

- `packages/i18n/src/role-names.ts` holds the registry, alias map, and language-parameterized helpers (`packages/i18n/src/role-names.ts:1-160`).
- `packages/i18n/src/index.ts` re-exports both `i18n.ts` and `role-names.ts` (`packages/i18n/src/index.ts:1-2`).
- `i18n.ts`, `i18n-agent-labels.ts`, and `i18n-role-models.ts` import `roleNameEn` and `roleNameRu` to populate static dictionary entries (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n-agent-labels.ts:1`, `packages/i18n/src/i18n-role-models.ts:1`).
- Root UI and CLI modules import `roleName`, `roleDisplayName`, and `canonicalRoleId` from `@lane-pilot/i18n` (`src/rooms/pages/tab-team.tsx:106`, `src/rooms/native-agent/ui/helper-threads.tsx:51`, `src/rooms/council/ui/council-page.tsx:45`, `src/rooms/native-agent/server/agents-cli.ts:38`, `src/rooms/tools/server/cli-project.ts:133`).

## Internal model

`ROLE_NAMES` is typed with `as const satisfies Record<string, RoleNameEntry>` so TypeScript preserves literal `RoleNameId` keys while validating every entry shape (`packages/i18n/src/role-names.ts:109-111`). `canonicalRoleId` uses `Object.prototype.hasOwnProperty.call(ROLE_NAMES, id)` to avoid prototype-key false positives before consulting `ROLE_ID_ALIASES` (`packages/i18n/src/role-names.ts:141-144`).

## Dependencies

`role-names.ts` has no imports or external dependencies (`packages/i18n/src/role-names.ts:1-160`). `roleName` in `i18n.ts` depends on `detectLocale` in the same module (`packages/i18n/src/i18n.ts:2493-2498`, `packages/i18n/src/i18n.ts:2596-2598`).

## Gotchas

- `roleDisplayName` and `roleLabel` default `lang` to `"ru"`, whereas `detectLocale()` defaults to `"en"` when no hints are present; UI components that follow the active screen locale must call `roleName(id)` rather than omitting `lang` on `roleDisplayName` (`packages/i18n/src/role-names.ts:147-156`, `packages/i18n/src/i18n.ts:2490`, `packages/i18n/src/i18n.ts:2596-2598`).
- `roleLabel(id, lang)` keeps the caller-supplied `id` inside parentheses even when resolved through an alias (for example `roleLabel("council")` produces `"Председатель совета (council)"`) (`packages/i18n/src/role-names.ts:153-156`, `tests/agents-doc.test.ts:90`).
- Unrecognized role IDs are returned verbatim by `roleDisplayName`, `roleLabel`, and `roleName` rather than throwing (`packages/i18n/src/role-names.ts:147-156`, `packages/i18n/src/i18n.ts:2596-2598`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](locale-and-translation.md)
- [i18n gotchas](../gotchas.md)
- [i18n workspace overview](../overview.md)
