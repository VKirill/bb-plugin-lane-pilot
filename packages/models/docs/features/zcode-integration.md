---
title: ZCode Integration Rules
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: medium
tags: [models, zcode, glm, promo-window, background-tasks]
sources:
  - packages/models/src/zcode.ts
  - packages/models/src/model-catalog.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/role-models.ts
  - packages/models/src/model-profiles.ts
  - packages/models/tests/zcode.test.ts
---

# ZCode Integration Rules

TL;DR: Enforces host requirements, promo window schedules, parallel slot limits, and bridge environment error classification for the ZCode desktop provider.

## Purpose

The ZCode integration coordinates tasks using the local ZCode desktop client running GLM-5.3-Flash (packages/models/src/zcode.ts:3-11).
Because ZCode relies on a desktop application with free promo quota, host restrictions, and limited concurrency, this subsystem evaluates whether ZCode can accept work before tasks are dispatched (packages/models/src/zcode.ts:4-11, :54-62).

## How it works

1. Check host support in `zcodeBlock`: verify that the machine catalog includes the `zcode` provider ID and that the target host ID is in `provider.hostIds` (packages/models/src/zcode.ts:55-57). If the catalog is unknown or the host does not offer ZCode, return a `host` block (packages/models/src/zcode.ts:57).
2. Check the operating time window with `zcodeWindowBlock`: inspect `zcode.window` setting via `zcodeWindowMode` (packages/models/src/zcode.ts:22-24, :47-52). If set to `promo` (the default), check `inZcodePromo` (packages/models/src/zcode.ts:31-34, :48).
3. Check slot concurrency: if `busy` is true (all 3 parallel task slots are in use), return a `busy` block (packages/models/src/zcode.ts:10, :60).
4. Evaluate background tasks in `resolveAgentModel`: if a background role from `ZCODE_FREE_ROWS` (`docs-maintainer`, `rules-analyzer`, `memory`, `project-life`) is on its built-in default, `zcodeBackgroundOn` is true, and the caller confirms ZCode availability, inject `glm-5.3-flash-free` at high effort as the first candidate (packages/models/src/zcode.ts:74-80; packages/models/src/agent-model.ts:139-141).
5. Detect bridge runtime failures with `zcodeEnvironmentError`: match process errors against `ZCODE_ENVIRONMENT` regex to distinguish desktop application states from code generation failures (packages/models/src/zcode.ts:64-70, :81-84).

### Block conditions and response codes

| Block code | Cause | Description / message | `resetsAt` value | Evidence |
|---|---|---|---|---|
| `host` | Host lacks the `zcode` provider (not Mac mini) or catalog is missing | "ZCode is not on this machine (only the Mac mini has it)" | `null` | (packages/models/src/zcode.ts:56-57) |
| `window` | Current UTC hour outside 15:00-01:00 with `zcode.window = promo` | "ZCode is free only 15:00-01:00 UTC (set zcode.window=always to use it at other hours)" | Next ISO timestamp from `nextZcodePromoStart` | (packages/models/src/zcode.ts:48-50) |
| `busy` | All 3 parallel slots occupied by Lane Pilot tasks | "ZCode's parallel slots are all taken" | `null` | (packages/models/src/zcode.ts:60) |

### Bridge environment errors

| Pattern trigger | Bridge error message | Handling | Evidence |
|---|---|---|---|
| `ZCode is busy` | Another chat holds the ZCode UI slot | Retry immediately on another model uncharged | (packages/models/src/zcode.ts:69) |
| `ZCode (text-not-visible)` | The answer text is not visible in desktop DOM | Retry immediately on another model uncharged | (packages/models/src/zcode.ts:69) |
| `ZCode (foreground_required)` | The desktop window must be brought to foreground | Retry immediately on another model uncharged | (packages/models/src/zcode.ts:69) |
| `ZCode (session_expired)` / `sign in` | The desktop application session expired | Retry immediately on another model uncharged | (packages/models/src/zcode.ts:69) |
| `ZCode (promo_unavailable)` | The Start Plan free token quota is depleted | Retry immediately on another model uncharged | (packages/models/src/zcode.ts:69, :72) |

## Business rules

- Daily promo schedule: Free promo hours run from 15:00 UTC to 01:00 UTC the following day (packages/models/src/zcode.ts:16-19, :31-34).
- Setting validation: `zcode.window` accepts only `"promo"` or `"always"` (packages/models/src/zcode.ts:14, :26-29).
- Single-machine constraint: The `zcode` provider exists exclusively on the Mac mini; an unknown host or missing catalog resolves to blocked (packages/models/src/zcode.ts:5-7, :56-57).
- Plan charge prevention: The free model `glm-5.3-flash-free` is programmed never to bill the account; without free tokens the plugin returns `promo_unavailable` rather than incurring plan fees (packages/models/src/zcode.ts:71-72).
- Free background candidate injection: Background roles `ZCODE_FREE_ROWS` (`docs-maintainer`, `rules-analyzer`, `memory`, `project-life`) attempt ZCode free tokens when on default model and `zcodeBackgroundOn` permits (`zcode.background !== false && zcode.background !== "off"`) (packages/models/src/zcode.ts:78-80; packages/models/src/agent-model.ts:139-141).
- Uncharged environment retry: Output matching `zcodeEnvironmentError` triggers an uncharged retry on the next candidate model in the chain (packages/models/src/zcode.ts:64-68).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `ZCODE_PROVIDER_ID` | Identifier constant `"zcode"` | (packages/models/src/zcode.ts:12) |
| `ZCODE_FREE_MODEL` | Model identifier `"glm-5.3-flash-free"` | (packages/models/src/zcode.ts:72) |
| `ZCODE_FREE_ROWS` | Background role IDs eligible for free token routing | (packages/models/src/zcode.ts:78) |
| `ZCODE_PROMO_FROM_HOUR` | Start hour in UTC (`15`) | (packages/models/src/zcode.ts:17) |
| `ZCODE_PROMO_TO_HOUR` | End hour in UTC (`1`) | (packages/models/src/zcode.ts:18) |
| `isZcodeProvider` | Boolean check for `"zcode"` provider ID | (packages/models/src/zcode.ts:20) |
| `inZcodePromo` | Checks if a given timestamp falls in the 15:00-01:00 UTC window | (packages/models/src/zcode.ts:31-34) |
| `nextZcodePromoStart` | Calculates the next opening ISO date for the promo window | (packages/models/src/zcode.ts:37-42) |
| `zcodeWindowMode` | Returns `"always"` or `"promo"` from settings | (packages/models/src/zcode.ts:23) |
| `zcodeWindowProblem` | Validates `zcode.window` setting value | (packages/models/src/zcode.ts:26-29) |
| `zcodeWindowBlock` | Evaluates whether current time blocks ZCode usage | (packages/models/src/zcode.ts:47-52) |
| `zcodeBlock` | Complete readiness evaluation checking host, window, and busy status | (packages/models/src/zcode.ts:55-62) |
| `zcodeEnvironmentError` | Extracts bridge environment failure messages | (packages/models/src/zcode.ts:81-84) |
| `zcodeBackgroundOn` | Checks if `zcode.background` setting allows free routing | (packages/models/src/zcode.ts:80) |

## Gotchas

For implementation traps regarding overnight promo hour arithmetic and bridge error classification, see [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Models Workspace — Overview](../overview.md)
