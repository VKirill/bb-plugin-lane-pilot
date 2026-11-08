---
title: Models Workspace — Overview
type: overview
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: medium
tags: [models, catalog, role-models, pricing, writers]
sources:
  - packages/models/package.json
  - packages/models/src/index.ts
  - packages/models/src/role-models.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/model-catalog.ts
  - packages/models/src/model-profiles.ts
  - packages/models/src/jev-reasoning.ts
  - packages/models/src/writer-fallbacks.ts
  - packages/models/src/model-prices.ts
  - packages/models/src/role-specs.ts
  - packages/models/src/zcode.ts
  - packages/models/src/providers.ts
  - packages/models/src/picker-compat.ts
  - packages/models/src/setting-value.ts
  - packages/models/src/stage-writer-selection.ts
  - packages/models/src/provider-limit.ts
  - packages/models/src/model-tiers.ts
  - src/rooms/platform/server/spawn-model.ts
  - src/rooms/settings/server/rpc/selections.ts
  - src/rooms/workflow/server/workflow-step-executors.ts
  - src/rooms/usage/server/token-usage.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/finish.ts
  - packages/workflow-engine/src/capabilities.ts
---

# Models Workspace — Overview

TL;DR: Pure data and resolution logic for model catalogs, role-to-model assignments, writer anamnesis, Jev reasoning, token pricing, and provider compatibility without SDK dependencies.

## What it is

The `@lane-pilot/models` workspace is an in-memory ESM package located at `packages/models` (packages/models/package.json:1-13).
It contains no runtime SDK clients and makes no network requests; the server loads external provider catalogs and passes them to this package for validation and resolution (packages/models/src/model-catalog.ts:3-8).
Its entry point re-exports the complete public API spanning model catalogs, role mapping, writer fallbacks, presets, token prices, and provider capabilities (packages/models/src/index.ts:1-15).

Key subsystems include:
- The role-to-model table mapping agent roles to models, enforcing cross-family judge pairing, managing fallback pools, and handling provider usage limits (packages/models/src/role-models.ts:1-13, packages/models/src/agent-model.ts:12-29).
- The writers' anamnesis profiles, Jev effort resolution, service tier translation, and task rotation (packages/models/src/model-profiles.ts:1-6, packages/models/src/jev-reasoning.ts:9-30, packages/models/src/writer-fallbacks.ts:57-84).
- The catalog schema, host availability checks, node effort filters, and model cost classification (packages/models/src/model-catalog.ts:9-31, :70-87).
- Token pricing tables, USD calculations, provider limit detections, and picker compatibility remaps (packages/models/src/model-prices.ts:6-42, packages/models/src/provider-limit.ts:9-13, packages/models/src/picker-compat.ts:1-21).
- ZCode desktop provider integration, free promo window schedules, and environment failure detection (packages/models/src/zcode.ts:3-11, :47-62).
- Declarative role specifications, RPC save mappings, and atomic setting key generation (packages/models/src/role-specs.ts:1-10, :155-188).

## Stack

- Private ESM package without third-party dependencies (packages/models/package.json:1-13).
- Exports catalog, role models, presets, pricing, and profile modules (packages/models/src/index.ts:1-15).
- Shared pricing tables and regex-based output classifiers (packages/models/src/model-prices.ts:6-23, packages/models/src/provider-limit.ts:3).

## Quick start

Import models, helpers, and types from `@lane-pilot/models`:

1. Resolve the model for a workflow role or agent step:
   Import `resolveAgentModel` (packages/models/src/agent-model.ts:104-187) or `resolveRoleModel` (packages/models/src/role-models.ts:310-322).
2. Validate a user or node choice against a machine catalog:
   Call `validateChoice` with the current `ModelCatalog` (packages/models/src/model-catalog.ts:70-87).
3. Compute token usage costs:
   Call `costUsd` with token breakdowns (packages/models/src/model-prices.ts:30-42).
4. Configure writer execution selections:
   Call `writerExecutionSelection` with consistent provider resolution (packages/models/src/jev-reasoning.ts:64-84).

## Public entry points

| Export area | Core functions and constants | Evidence |
|---|---|---|
| Role-to-model table | `ROLE_TABLE`, `ROLE_IDS`, `resolveRoleModel`, `resolveAgentModel`, `judgeAgainstAuthor`, `peerOffSpent`, `roleModelProblem` | (packages/models/src/role-models.ts:102-145; packages/models/src/agent-model.ts:104-187) |
| Writer execution | `WRITER_PROFILES`, `writerCandidates`, `writerExecutionSelection`, `resolveJevReasoning`, `writerFallbackChain`, `rotatedWriterSettings` | (packages/models/src/model-profiles.ts:24-115; packages/models/src/jev-reasoning.ts:64-84; packages/models/src/writer-fallbacks.ts:44-84) |
| Catalog validation | `findProvider`, `findModel`, `findModelIn`, `offeredOnHost`, `validateChoice`, `nodeEffortsFor`, `costTier` | (packages/models/src/model-catalog.ts:40-107) |
| Pricing and limits | `MODEL_PRICES`, `priceFor`, `costUsd`, `providerLimitNotice`, `compatibleReasoningLevel`, `compatibleServiceTier` | (packages/models/src/model-prices.ts:6-42; packages/models/src/provider-limit.ts:9-13; packages/models/src/picker-compat.ts:1-21) |
| ZCode integration | `zcodeBlock`, `zcodeWindowBlock`, `inZcodePromo`, `nextZcodePromoStart`, `zcodeEnvironmentError`, `ZCODE_FREE_ROWS` | (packages/models/src/zcode.ts:31-84) |
| Role specifications | `ROLE_SPECS`, `PAIR_ROLE_SPECS`, `COUNCIL_SEATS`, `WRITER_FALLBACK_SLOTS`, `roleSpec`, `roleSpecKey`, `roleAtomicMessage` | (packages/models/src/role-specs.ts:13-188) |

## Configuration

Settings keys inspected and formatted by this package include:
- `role_model.<role>`: JSON object `{ provider?, model, reasoning_effort?, pool? }` storing custom role picks (packages/models/src/role-models.ts:146-147, :228-250).
- `writer.provider`, `writer.model`, `writer.reasoning_effort`, `writer.service_tier`: primary writer settings (packages/models/src/role-specs.ts:20-21).
- `writer.fallback<slot>.provider`, `.model`, `.reasoning_effort`: writer fallback chain slots (packages/models/src/writer-fallbacks.ts:21-25).
- `writer.rotation_share`: percentage of tasks swapped to fallback 1 (packages/models/src/writer-fallbacks.ts:73-75).
- `zcode.window`: promo hour policy (`promo` or `always`) (packages/models/src/zcode.ts:13-15).
- `zcode.background`: toggle for routing background roles to free ZCode tokens (packages/models/src/zcode.ts:79-80).
- `jev.LANE_JEV_EFFORT`: toggle for automatic Jev reasoning effort routing (packages/models/src/jev-reasoning.ts:36-38).

## Consumers

- Server core spawn resolves spawn models through `resolveAgentModel` and `catalogProviderOf` (src/rooms/platform/server/spawn-model.ts:1).
- Native agent settings RPCs save role selections with `roleSpec`, `compatibleReasoningLevel`, and `compatibleServiceTier` (src/rooms/settings/server/rpc/selections.ts:3).
- Workflow step execution verifies choices with `validateChoice` and falls back with `writerFallbackChain` (src/rooms/workflow/server/workflow-step-executors.ts:3-6).
- Token usage screens and background accounting use `MODEL_PRICES` and `costUsd` (src/rooms/usage/server/token-usage.ts:5).
- Writer lifecycle dispatches and logs read `WRITER_PROFILES`, `providerLimitNotice`, and `rotatedWriterSettings` (src/rooms/writer/server/start.ts:9, src/rooms/writer/server/finish.ts:11).
- The standalone package `@lane-pilot/workflow-engine` validates roles with `resolveRoleModel` and `offeredOnHost` (packages/workflow-engine/src/capabilities.ts:1).

## Where to look next

- [Role-to-Model Resolution](features/role-models.md) — role assignments, cross-family pairing, and fallback pools.
- [Writer Selection and Fallbacks](features/writer-selection.md) — writer anamnesis, Jev effort routing, and fallback rotation.
- [Model Catalog and Validation](features/model-catalog.md) — machine catalog normalization, choice validation, and cost tiers.
- [Token Pricing and Compatibility](features/token-pricing.md) — list prices, token calculations, and limit notices.
- [ZCode Integration Rules](features/zcode-integration.md) — desktop client promo schedule, slot limits, and background jobs.
- [Role Specification Registry](features/role-specs.md) — declarative role definitions, save RPCs, and atomic setting keys.
- [Gotchas](gotchas.md) — provider incompatibilities, profile restrictions, and edge cases.
