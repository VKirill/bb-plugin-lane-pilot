---
title: Canonical role names
type: component
created: 2026-11-14
updated: 2026-11-27
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
  - src/rooms/settings/ui/agents-loadout-row.tsx
  - src/rooms/specialist/ui/staff-list-parts.tsx
  - src/rooms/pages/ui/screens/overview-parts.tsx
  - src/rooms/native-agent/ui/helper-threads.tsx
  - src/rooms/native-agent/server/handlers/agents-cli.ts
  - src/rooms/tools/server/handlers/cli-project.ts
---
# Canonical role names

TL;DR: `role-names.ts` is the single bilingual registry of display names, kinds, and groups for every Lane Pilot agent, single-call judge, and Codex config profile, re-exported at the package root (`packages/i18n/src/role-names.ts:1-167`, `packages/i18n/src/index.ts:1-2`).

## Purpose

The component ensures every internal role identifier—whether used in settings keys, thread roles, workflow steps, or CLI commands—resolves to one unique display name per language (`packages/i18n/src/role-names.ts:2-6`). Each entry in `ROLE_NAMES` pairs its Russian (`ru`) and English (`en`) names with a `RoleKind` (`"agent" | "judge" | "profile" | "code"`) and a `RoleGroup` (`"management" | "coders" | "checkers" | "memory" | "council" | "specialists" | "service"`) (`packages/i18n/src/role-names.ts:14-21`). Dictionary modules (`i18n.ts`, `i18n-agent-labels.ts`, `i18n-role-models.ts`) pull role names from this map instead of duplicating strings (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n-agent-labels.ts:1`, `packages/i18n/src/i18n-role-models.ts:1`). The `"management"` group includes the codebase scout (`scout`) (`packages/i18n/src/role-names.ts:31`), and the `"memory"` group includes the chat-digestion (`digest-light`, `digest-analyst`) and graph-evolution (`evolve-planner`, `evolve-critic`, `evolve-architect`, `evolve-auditor`) agent entries (`packages/i18n/src/role-names.ts:60-65`).

## How it works

1. `ROLE_NAMES` defines every canonical role entry using internal `agent`, `judge`, and `profile` factory helpers across seven groups (`packages/i18n/src/role-names.ts:18-116`).
2. `ROLE_ID_ALIASES` maps legacy names, thread-specific identifiers, and `specialist:<employee>` prefixes onto canonical `RoleNameId` keys (`packages/i18n/src/role-names.ts:125-145`).
3. `canonicalRoleId(id)` checks whether `id` is an own property of `ROLE_NAMES`; if not, it looks up `ROLE_ID_ALIASES[id]` and returns `null` when neither matches (`packages/i18n/src/role-names.ts:148-151`).
4. `roleDisplayName(id, lang)` resolves `canonicalRoleId(id)` and returns `ROLE_NAMES[key][lang]`, defaulting `lang` to `"ru"` (`packages/i18n/src/role-names.ts:145-148`).
5. `roleNameEn(id)` and `roleNameRu(id)` bind `lang` to `"en"` and `"ru"` for static dictionary initialization, while `roleName(id)` in `i18n.ts` calls `roleDisplayName(id, detectLocale())` for runtime UI rendering (`packages/i18n/src/role-names.ts:166-167`, `packages/i18n/src/i18n.ts:2652-2654`).

### Resolution modes and kinds

| Mode or classification | Input / values | Output / behavior | Fallback / constraint |
|---|---|---|---|
| `canonicalRoleId(id)` | Direct `RoleNameId` or key in `ROLE_ID_ALIASES` | Returns canonical `RoleNameId` (`packages/i18n/src/role-names.ts:148-151`) | Returns `null` when unknown (`packages/i18n/src/role-names.ts:150`) |
| `roleDisplayName(id, lang)` | Any role ID; `lang` `"ru" \| "en"` (default `"ru"`) | Localized display name (`packages/i18n/src/role-names.ts:145-148`) | Returns raw `id` unchanged when `canonicalRoleId(id)` is `null` (`packages/i18n/src/role-names.ts:147`) |
| `roleName(id)` | Any role ID | Delegates to `roleDisplayName(id, detectLocale())` (`packages/i18n/src/i18n.ts:2652-2654`) | Same pass-through fallback as `roleDisplayName` (`packages/i18n/src/role-names.ts:147`) |
| `RoleKind` | `"agent"`, `"judge"`, `"profile"`, `"code"` (`packages/i18n/src/role-names.ts:14`) | Distinguishes LLM sessions (`agent`), single-call judges (`judge`: `memory-judge`, `jev`), Codex tool profiles (`profile`), and deterministic code (`code`) (`packages/i18n/src/role-names.ts:8-12`, `packages/i18n/src/role-names.ts:54`, `packages/i18n/src/role-names.ts:71`, `packages/i18n/src/role-names.ts:113-115`) | `profile` entries use group `"service"` (`packages/i18n/src/role-names.ts:20`) |

## Business rules

- Every role identifier known across the models table, helper roles, council seats, writer fallback slots, errand kinds, Codex lean profiles, stock agent descriptions, workflow graphs, and legacy thread roles must resolve via `canonicalRoleId` (`tests/agents-doc.test.ts:33-55`).
- No two entries in `ROLE_NAMES` can share a trimmed, lowercased display name in either `"ru"` or `"en"`, and no entry name can be empty (`tests/agents-doc.test.ts:57-67`).
- `ROLE_ID_ALIASES` keys must not appear in `ROLE_NAMES`, and every alias target must exist in `ROLE_NAMES` (`tests/agents-doc.test.ts:69-74`).
- Codex config profiles (`codex-profile:code`, `codex-profile:quiet`, `codex-profile:open`) must have `kind: "profile"` and remain distinct from `writer` (`packages/i18n/src/role-names.ts:20`, `packages/i18n/src/role-names.ts:113-115`, `tests/agents-doc.test.ts:76-82`).
- `specialist:lead` is its own canonical entry in `ROLE_NAMES` separate from `lead`, whereas the other twelve `specialist:<employee>` IDs are aliases pointing to `<employee>` (`packages/i18n/src/role-names.ts:25-26`, `packages/i18n/src/role-names.ts:133-144`).
- Dictionary keys prefixed with `accessName_`, `roleModelName_`, and `settingCouncilSeat_`, along with `helperRole_writer` and `agentDisplayDevOrchestrator`, draw their values from `ROLE_NAMES` (`packages/i18n/src/i18n.ts:106`, `packages/i18n/src/i18n.ts:232`, `packages/i18n/src/i18n.ts:313`, `packages/i18n/src/i18n.ts:1169`, `packages/i18n/src/i18n-role-models.ts:25`, `tests/agents-doc.test.ts:93-105`).

## Public API

All declarations from `role-names.ts` and `roleName` (`packages/i18n/src/i18n.ts:2652-2654`) are re-exported by the package entry point (`packages/i18n/src/index.ts:1-2`).

| Import | Source | Purpose |
|---|---|---|
| `RoleKind`, `RoleGroup`, `RoleNameEntry`, `RoleNameId` | `packages/i18n/src/role-names.ts:14-16`, `packages/i18n/src/role-names.ts:118` | Classification and key types for canonical role entries |
| `ROLE_NAMES` | `packages/i18n/src/role-names.ts:22-108` | Canonical role-name registry |
| `ROLE_ID_ALIASES` | `packages/i18n/src/role-names.ts:116-135` | Map from alias and `specialist:*` IDs to `RoleNameId` |
| `canonicalRoleId(id)` | `packages/i18n/src/role-names.ts:138-141` | Resolve direct ID or alias to `RoleNameId \| null` |
| `roleDisplayName(id, lang?)` | `packages/i18n/src/role-names.ts:144-147` | Return `"ru"` (default) or `"en"` display name, or raw `id` |
| `roleNameEn(id)`, `roleNameRu(id)` | `packages/i18n/src/role-names.ts:150-151` | Single-language helpers for static i18n dictionaries |
| `roleName(id)` | `packages/i18n/src/i18n.ts:2652-2654` | Return display name in `detectLocale()` language |

## Package shape

- `packages/i18n/src/role-names.ts` holds the registry, alias map, and language-parameterized helpers (`packages/i18n/src/role-names.ts:1-167`).
- `packages/i18n/src/index.ts` re-exports both `i18n.ts` and `role-names.ts` (`packages/i18n/src/index.ts:1-2`).
- `i18n.ts`, `i18n-agent-labels.ts`, and `i18n-role-models.ts` import `roleNameEn` and `roleNameRu` to populate static dictionary entries (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n-agent-labels.ts:1`, `packages/i18n/src/i18n-role-models.ts:1`).
- Root UI and CLI modules import `roleName`, `roleDisplayName`, and `canonicalRoleId` from `@lane-pilot/i18n` (`src/rooms/settings/ui/agents-loadout-row.tsx:2`, `src/rooms/specialist/ui/staff-list-parts.tsx:1`, `src/rooms/pages/ui/screens/overview-parts.tsx:1`, `src/rooms/native-agent/ui/helper-threads.tsx:6`, `src/rooms/native-agent/server/handlers/agents-cli.ts:2`, `src/rooms/tools/server/handlers/cli-project.ts:133`).

## Internal model

`ROLE_NAMES` is typed with `as const satisfies Record<string, RoleNameEntry>` so TypeScript preserves literal `RoleNameId` keys while validating every entry shape (`packages/i18n/src/role-names.ts:116-118`). `canonicalRoleId` uses `Object.prototype.hasOwnProperty.call(ROLE_NAMES, id)` to avoid prototype-key false positives before consulting `ROLE_ID_ALIASES` (`packages/i18n/src/role-names.ts:148-151`).

## Dependencies

`role-names.ts` has no imports or external dependencies (`packages/i18n/src/role-names.ts:1-167`). `roleName` in `i18n.ts` depends on `detectLocale` in the same module (`packages/i18n/src/i18n.ts:2549-2554`, `packages/i18n/src/i18n.ts:2652-2654`).

## Gotchas

- `roleDisplayName` defaults `lang` to `"ru"`, whereas `detectLocale()` defaults to `"en"` when no hints are present; UI components that follow the active screen locale must call `roleName(id)` rather than omitting `lang` on `roleDisplayName` (`packages/i18n/src/role-names.ts:144-147`, `packages/i18n/src/i18n.ts:2546`, `packages/i18n/src/i18n.ts:2652-2654`).
- Unrecognized role IDs are returned verbatim by `roleDisplayName` and `roleName` rather than throwing (`packages/i18n/src/role-names.ts:144-147`, `packages/i18n/src/i18n.ts:2652-2654`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Locale resolution and translation](locale-and-translation.md)
- [i18n gotchas](../gotchas.md)
- [i18n workspace overview](../overview.md)
