---
title: Who works a role — the role table and model pools
type: component
created: 2026-10-29
updated: 2026-10-29
status: active
confidence: medium
tags: [models, roles, providers, settings, jev]
sources:
  - packages/models/src/role-models.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/zcode.ts
  - packages/models/src/model-profiles.ts
  - src/rooms/core/server/spawn-model.ts
  - src/rooms/settings/server/rpc/role-models.ts
  - src/rooms/settings/server/rpc/settings.ts
  - src/rooms/settings/model-keys.ts
  - src/rooms/contracts/rpc-settings.ts
  - src/rooms/ui-shell/ui/tab-team.tsx
  - src/rooms/settings/ui/role-models.tsx
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/writer-model-pick.ts
  - packages/models/src/model-tiers.ts
---

# Who works a role — the role table and model pools

TL;DR: One setting per role names the model that works it — now any provider's model, with an optional pool of extras whose least loaded provider takes each run.

## Purpose

Every agent step of every graph names a role, and the role names the model: one table «role -> model» for the whole plugin, on the global, project or section level (`packages/models/src/role-models.ts:1-13`). The writer of a task is not a row of the table: it is picked per task by Jev from the writers' anamnesis (`packages/models/src/model-profiles.ts:24-83`). See [Jev adapter](jev-adapter.md) for the writer pick.

## How it works

1. A row is the setting `role_model.<role>` = `{ provider?, model, reasoning_effort?, pool?: [{ provider?, model, reasoning_effort? }] }`. `model` may name one of the table's ten options by id, or — with `provider` — any model of any provider that BB's own provider/model window offers; its family and tier are read off the name (`other`/`standard` when the name says nothing) (`packages/models/src/role-models.ts:159-171`). A model named alone that is not in the table is not a pick; the two native providers (`claude-code`, `codex`) serve only their own family (`packages/models/src/role-models.ts:163-165`).
2. The row is validated as a whole: the provider id is a string of at most 100 characters, the model id at most 200, the effort must be one of the model's own list, and a `pool` is an array of entries with the same shape as the row; a problem string names the first defect (`packages/models/src/role-models.ts:200-223`). Invalid or repeated pool entries are dropped when the pool is read (`packages/models/src/role-models.ts:184-197`).
3. A spawn resolves the role in order, first hit wins: the owner's row of the table, then a stage selection made before the table existed (`plan_critique.*`, `specialist.*` and the other legacy keys), then the role's built-in default (`packages/models/src/role-models.ts:282-296`, defaults at `:99-119`). A pick that names no effort takes the row's default when it names the row's default model, else the model's own catalog default (`packages/models/src/role-models.ts:273-276`).
4. The candidates for one run are the row's model plus its pool (a stored table row only). A Claude Code agent profile role — thirteen of them: the specialist, the workflow architect and the named helper roles (copy-lead, seo-specialist, design-lead, video-lead, tavily, 3d-artist, game-dev, social-manager, billing-assistant, visual-artist, macos-operator — `CLAUDE_PROFILE_ROLES`, `packages/models/src/agent-model.ts:6-10`) — takes only the Claude models of its pool: another provider refuses the profile (`packages/models/src/agent-model.ts:6`, `:130-135`).
5. The pool is ranked for each run by `rankPool`: a provider whose usage window is spent goes last, then the less spent window (compared in steps of ten percent, so a few points do not flip the order), then the provider with fewer helper starts in the last half hour, then the order the owner gave (`packages/models/src/agent-model.ts:69-80`).
6. Where the load numbers come from: the spawn resolver reads the cached usage reading with a 1% threshold (ZCode has no window, so always `null`) and counts each provider's helper starts over the last 30 minutes in memory; the chosen provider's start is recorded after the resolution (`src/rooms/core/server/spawn-model.ts:45-54`, `:80-83`, `:99`).
7. A background row left on its built-in default tries ZCode's free tokens first — but only where the caller says ZCode can work now (its machine, its free hours, a free slot); a caller that cannot tell never gets it. The rows are `docs-maintainer`, `rules-analyzer`, `memory` and `project-life`; `zcode.background` = false turns the behaviour off (`packages/models/src/zcode.ts:78-80`, `packages/models/src/agent-model.ts:141-145`).
8. After the row and its pool come the role's built-in default (when the row named something else), then the role's fallback pair, then the PM chat's model (`packages/models/src/agent-model.ts:146-150`).

### Where a role's model can come from

| Source | What it is | Beats |
|---|---|---|
| Table row | `role_model.<role>` on the project, section or global level; any provider's model with its `provider`, or a table option by id (`packages/models/src/role-models.ts:159-171`). | Everything below. |
| Legacy stage selection | `plan_critique.*`, `specialist.*` and the other pre-table keys, for the roles `LEGACY_STAGES` lists (`packages/models/src/role-models.ts:282-296`). | The built-in default. |
| Built-in default | The row's `default` in `ROLE_TABLE`, with a `why` for each (`packages/models/src/role-models.ts:99-119`). | The fallback. |
| Role fallback | One named pair per role (a review whose Gemini is not offered takes the GPT model it ran on before) (`packages/models/src/role-models.ts:246-256`). | The PM chat's model. |

### The ZCode free option

The `zcode` provider serves one option, `glm-5.3-flash-free` («ZCode · GLM-5.3-Flash · Free»), matched by full id only (`packages/models/src/role-models.ts:36-39`). It never bills the plan: the bridge refuses it with `promo_unavailable` rather than charge (`packages/models/src/model-profiles.ts:81-84`). Lane Pilot offers it only where `zcodeBlock` passes — the provider is on the task's machine, the time is in the free window (15:00–01:00 UTC unless `zcode.window` = `always`), and a parallel slot is free; ZCode runs at most three tasks at once on the whole machine (`packages/models/src/zcode.ts:11`, `:66-75`). ZCode refusing at run time is a free `limit` failure: the step moves to the next candidate (`packages/models/src/agent-model.ts:141-145`).

## Failures

| Failure | What happens |
|---|---|
| Row fails validation | `save_setting` refuses with the `roleModelProblem` string; the stored row stays (`packages/models/src/role-models.ts:200-223`). |
| Pool entry invalid or repeated | Dropped when the pool is read; the row itself still works (`packages/models/src/role-models.ts:184-197`). |
| A pool provider is spent or busier | It goes last in `rankPool`; another pool model or the row's model takes the run (`packages/models/src/agent-model.ts:69-80`). |
| ZCode cannot work now | Not offered at pick time (`packages/models/src/agent-model.ts:141-145`); a run-time refusal hands the step to the next writer (`src/rooms/writer/writer-model-pick.ts:100-101`). |
| No usage reading cached | The window percent counts as `null` (0 in the ranking); recent-start counts still order the pool (`src/rooms/core/server/spawn-model.ts:80-83`). |

## Business rules

- The model belongs to the role, not to the step: no per-step override and no node-level model exists (`packages/models/src/role-models.ts:1-4`).
- The specialist, the workflow architect and eleven helper roles run as Claude Code agent profiles and take only Claude models of their pool (`packages/models/src/agent-model.ts:6`, `:130-135`).
- Saving the row keeps the pool: the settings panel and the team roster both send the remaining pool entries with every change of the main model (`src/rooms/settings/ui/role-models.tsx:88-91`, `src/rooms/ui-shell/ui/tab-team.tsx:240-247`).
- «Reset everywhere» takes back a project's or section's model rows and its `<role>.agent` keys, but never the pinned models of LP bench and sandbox projects: the bench compares models on purpose (`src/rooms/settings/model-keys.ts:4-13`, `src/rooms/settings/server/rpc/settings.ts:333-350`).

## Public API or commands

- `get_role_models` returns each role's resolved model with its `pool`, source, version and default (`src/rooms/settings/server/rpc/role-models.ts:16-35`, contract at `src/rooms/contracts/rpc-settings.ts:38-50`); `save_setting` stores `role_model.<role>`.
- `list_model_overrides` lists the places with their own model rows or agents (sandboxes screened out); `reset_model_overrides` removes the given levels' rows and agents (`src/rooms/settings/server/rpc/settings.ts:333-350`).
- `resolveSpawnModel` (helpers) and `resolveAgentModel` (pure) are the resolution entry points (`src/rooms/core/server/spawn-model.ts:68-100`, `packages/models/src/agent-model.ts:108-150`).
- The writer keeps its own per-task Jev pick, which now also receives how busy each candidate's provider is and is told to spread the work (`src/rooms/writer/server/start.ts:133-163`, `src/rooms/writer/writer-model-pick.ts:18-45`).

## Gotchas

- The team roster's model column reads the same table: a row of it replaces an older stage picker on screen, `code-repair` and `night-fixer` show "the task writer's model", and the writer, rules analyzer and onboarder keep pickers of their own (`src/rooms/ui-shell/ui/tab-team.tsx:27-29`, `:104-115`).
- The ten-percent band means two providers within a few percentage points of spent stay in the owner's order (`packages/models/src/agent-model.ts:74-78`).
- A pool is read only when the row's source is the table: a legacy stage selection has no pool (`src/rooms/settings/server/rpc/role-models.ts:34`, `packages/models/src/agent-model.ts:130-134`).
- Repairer's built-in default is GPT-6.1 Sol: the owner moved the repairs off Claude's window (`packages/models/src/role-models.ts:117-118`); Grok 4.6 (Cursor) is one of Jev's writer candidates (`packages/models/src/model-profiles.ts:31-33`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Shared packages](packages.md)
