---
title: Role Specification Registry
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: medium
tags: [models, role-specs, rpc-contracts, settings-keys, council-seats]
sources:
  - packages/models/src/role-specs.ts
  - packages/models/src/role-models.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/providers.ts
  - packages/models/tests/role-spec-registry.test.ts
---

# Role Specification Registry

TL;DR: Declarative registry of configurable roles, defining their save RPC names, settings key mappings, council seats, and atomic update contracts.

## Purpose

The role specification registry establishes a single declarative source for all roles that configure provider, model, reasoning effort, and service tier selections (packages/models/src/role-specs.ts:1-10).
It maps UI picker rows to backend persistence keys and RPC handlers (`save_<role>_selection`), eliminating drift between frontend forms, RPC validators, and settings storage (packages/models/src/role-specs.ts:2-10, :51-87).

## How it works

1. Define council seats in `COUNCIL_SEATS` (`product`, `demand`, `audience`, `skeptic`, `growth`, `ux`, `chair`) and fallback slots in `WRITER_FALLBACK_SLOTS` (`1`, `2`, `3`) (packages/models/src/role-specs.ts:13, :17).
2. Generate structured key arrays: `PAIR_KEYS` generates the four keys `<prefix>.provider`, `.model`, `.reasoning_effort`, and `.service_tier`; `SEAT_KEYS` generates keys for each council seat; `SLOT_KEYS` generates keys for each fallback slot (packages/models/src/role-specs.ts:20-25).
3. Populate `ROLE_SPEC_ROWS`: configure settings prefixes, RPC handler names, access roles, catalog host resolution strategies, and default effort policies (packages/models/src/role-specs.ts:93-152).
4. Export table views: `ROLE_SPECS` contains all rows, and `PAIR_ROLE_SPECS` filters for `kind: "pair"` rows (packages/models/src/role-specs.ts:155-158).
5. Expose lookup functions: `roleSpec` finds a role specification by its ID; `roleSpecKey` formats specific keys for pair roles (packages/models/src/role-specs.ts:170-179).
6. Aggregate all keys in `ROLE_SELECTION_KEYS`: flat list of all configuration keys owned by any role selection (packages/models/src/role-specs.ts:182).
7. Enforce atomic updates with `roleAtomicMessage`: when a caller attempts to modify a role key through general setting commands, emit an instruction directing them to use the atomic RPC (packages/models/src/role-specs.ts:185-188).

### Role specification registry entries

| Role ID | Kind | RPC handler | Settings prefix | Host strategy | Default effort | Evidence |
|---|---|---|---|---|---|---|
| `writer` | `pair` | `save_writer_selection` | `writer` | `thread` | Dynamic | (packages/models/src/role-specs.ts:94-98) |
| `memory` | `pair` | `save_memory_selection` | `memory` | `writer-binding` | `none` (from writer) | (packages/models/src/role-specs.ts:99-103) |
| `night_review` | `pair` | `save_night_review_selection` | `night_review` | `project` | `high` | (packages/models/src/role-specs.ts:104-108) |
| `docs` | `pair` | `save_docs_selection` | `docs` | `project` | `high` | (packages/models/src/role-specs.ts:109-113) |
| `project_life` | `pair` | `save_project_life_selection` | `project_life` | `project` | `high` | (packages/models/src/role-specs.ts:114-118) |
| `onboarding` | `pair` | `save_onboarding_selection` | `onboarding` | `project` | `medium` | (packages/models/src/role-specs.ts:119-123) |
| `pm_read` | `pair` | `save_pm_read_selection` | `pm_read` | `project` | `low` | (packages/models/src/role-specs.ts:124-128) |
| `plan_critique` | `pair` | `save_plan_critique_selection` | `plan_critique` | `project` | `medium` (from writer) | (packages/models/src/role-specs.ts:129-133) |
| `code_critique` | `pair` | `save_code_critique_selection` | `code_critique` | `project` | `medium` (from writer) | (packages/models/src/role-specs.ts:134-138) |
| `specialist` | `pair` | `save_specialist_selection` | `specialist` | `project` | `high` | (packages/models/src/role-specs.ts:139-143) |
| `council` | `council` | `save_council_seat_selection` | None | None | Per seat | (packages/models/src/role-specs.ts:144-147) |
| `writer_fallback` | `fallback` | `save_writer_fallback_selection` | None | None | Per slot | (packages/models/src/role-specs.ts:148-151) |

### Failures and rejections

| Condition | Failure symptom | Remedy | Evidence |
|---|---|---|---|
| Direct key edit | Caller writes `<prefix>.model` via `save_setting` | Handler returns rejection: "use atomic <atomicLabel> provider/model selection" | (packages/models/src/role-specs.ts:185-188) |
| Invalid role key lookup | Calling `roleSpecKey` on a non-pair or unknown role ID | Throws `Error: role "<id>" has no <suffix> key` | (packages/models/src/role-specs.ts:175-179) |

## Business rules

- Atomic update requirement: Selections for a role must be written atomically through its dedicated RPC; piecemeal key writes are rejected (packages/models/src/role-specs.ts:2-6, :185-188).
- Council composition: A council consists of seven predefined seats in order: `product`, `demand`, `audience`, `skeptic`, `growth`, `ux`, `chair` (packages/models/src/role-specs.ts:12-13).
- Fallback capacity: Writer fallbacks are fixed to three numbered slots: `1`, `2`, `3` (packages/models/src/role-specs.ts:16-17).
- Key naming standard: Pair roles own exactly four settings keys formatted as `${prefix}.${suffix}` where suffix is `provider`, `model`, `reasoning_effort`, or `service_tier` (packages/models/src/role-specs.ts:20-21, :175-179).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `ROLE_SPECS` | Immutable array of all role specifications | (packages/models/src/role-specs.ts:155) |
| `PAIR_ROLE_SPECS` | Filtered list containing only the 10 `kind: "pair"` roles | (packages/models/src/role-specs.ts:158) |
| `COUNCIL_SEATS` | Array of 7 council seat identifiers | (packages/models/src/role-specs.ts:13) |
| `WRITER_FALLBACK_SLOTS` | Array of 3 writer fallback slot numbers | (packages/models/src/role-specs.ts:17) |
| `COUNCIL_KEYS` | Flat array of all 21 council seat settings keys | (packages/models/src/role-specs.ts:27) |
| `WRITER_FALLBACK_KEYS` | Flat array of all 9 writer fallback settings keys | (packages/models/src/role-specs.ts:28) |
| `ROLE_SELECTION_KEYS` | Complete array of every settings key managed by role selections | (packages/models/src/role-specs.ts:182) |
| `roleSpec` | Retrieves a `RoleSpec` by role identifier | (packages/models/src/role-specs.ts:170-172) |
| `roleSpecKey` | Builds a settings key for a pair role and suffix | (packages/models/src/role-specs.ts:175-179) |
| `roleAtomicMessage` | Builds atomic save instruction message for settings handlers | (packages/models/src/role-specs.ts:185-188) |

## Gotchas

For implementation traps regarding atomic settings keys and RPC mappings, see [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Models Workspace — Overview](../overview.md)
