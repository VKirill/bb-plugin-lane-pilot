---
title: Model Catalog and Validation
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: medium
tags: [models, catalog, validation, presets, cost-tier]
sources:
  - packages/models/src/model-catalog.ts
  - packages/models/src/model-presets.ts
  - packages/models/src/model-prices.ts
  - packages/models/src/model-tiers.ts
  - packages/models/src/role-models.ts
  - packages/models/tests/picker-compat.test.ts
  - packages/models/tests/model-prices.test.ts
---

# Model Catalog and Validation

TL;DR: Normalizes provider and model availability across machines, verifies host connectivity, validates node model choices, and computes cost tiers.

## Purpose

The model catalog subsystem maintains an in-memory representation of connected machines, installed providers, offered models, and supported reasoning efforts (packages/models/src/model-catalog.ts:3-8).
It prevents draft workflow patches from committing models that no connected machine can run, and ensures execution steps run on the project's helper machine (packages/models/src/model-catalog.ts:6-8, :27-31, :70-87).

## How it works

1. Receive a `ModelCatalog` populated by the server containing connected `hosts`, installed `providers`, and optional `runHostId` (packages/models/src/model-catalog.ts:9-31).
2. Locate providers using `findProvider` and models using `findModel` or `findModelIn` (matching either `id` or `model` name) (packages/models/src/model-catalog.ts:40-43).
3. Identify default models for a provider using `defaultModelIn` (packages/models/src/model-catalog.ts:45).
4. Identify unique catalog owners of a model using `catalogProviderOf`, returning null when none or multiple providers list it (packages/models/src/model-catalog.ts:48-51).
5. Verify host availability via `offeredOnHost`: checks whether `host.connected` is true and whether `model.hostIds` includes `hostId` (packages/models/src/model-catalog.ts:57-64).
6. Validate node choices with `validateChoice`: verifies provider existence, host availability, model existence, execution host compatibility against `runHostId`, effort support against `model.efforts`, and service tier support (packages/models/src/model-catalog.ts:70-87).
7. Restrict model efforts for workflow nodes via `nodeEffortsFor`, filtering against `NODE_EFFORTS` (packages/models/src/model-catalog.ts:34, :90).
8. Compute cost classifications via `costTier`: checks output token list prices first (output <= $2 is low, <= $15 is medium, > $15 is high), falling back to name patterns (packages/models/src/model-catalog.ts:98-107).
9. Resolve workflow presets via `presetSelection` and `presetSlug`: maps normalized names to `BUILTIN_PRESETS` or project settings (packages/models/src/model-presets.ts:14-23, :33-48).

### Validation error codes

| Error code | Trigger condition | Detail payload | Evidence |
|---|---|---|---|
| `provider_unknown` | Provider ID not present in `catalog.providers` | `choice.providerId` | (packages/models/src/model-catalog.ts:71-72) |
| `provider_unavailable` | Provider exists, but `provider.hostIds` is empty | `choice.providerId` | (packages/models/src/model-catalog.ts:73) |
| `model_unknown` | Model not listed under `provider.models` | `providerId/model` | (packages/models/src/model-catalog.ts:74-75) |
| `model_unavailable` | Model exists, but `model.hostIds` is empty | `providerId/model` | (packages/models/src/model-catalog.ts:76) |
| `model_unavailable_here` | Model is available on other machines, but not on `catalog.runHostId` | `providerId/model (only on <hosts>)` | (packages/models/src/model-catalog.ts:78-81) |
| `effort_unsupported` | `choice.effort` is not included in `model.efforts` | `model: effort` | (packages/models/src/model-catalog.ts:82) |
| `tier_unsupported` | `serviceTier` is not "default"/"standard" and provider lacks support | `providerId: serviceTier` | (packages/models/src/model-catalog.ts:83-85) |

### Built-in model presets

| Preset slug | Provider ID | Model | Reasoning effort | Primary aliases | Evidence |
|---|---|---|---|---|---|
| `cheap-fast` | `claude-code` | `claude-haiku-5-5` | `low` | None | (packages/models/src/model-presets.ts:16) |
| `strong` | `claude-code` | `claude-opus-5-5` | `high` | None | (packages/models/src/model-presets.ts:17) |
| `ins-analysis` | `claude-code` | `claude-opus-5` | `high` | `INS - анализ` | (packages/models/src/model-presets.ts:19) |
| `ins-psychology` | `codex` | `gpt-5.6-luna` | `max` | `INS - психология` | (packages/models/src/model-presets.ts:20) |
| `ins-check` | `codex` | `gpt-6.1-sol` | `medium` | `INS - проверка` | (packages/models/src/model-presets.ts:21) |
| `ins-digest` | `claude-code` | `claude-sonnet-5` | `medium` | `INS - сводка` | (packages/models/src/model-presets.ts:22) |

### Cost tier classification

| Cost tier | List price condition | Fallback name regex pattern | Evidence |
|---|---|---|---|
| `low` | Output price <= $2.00 / 1M tokens | `/(^\|[-/_ ])(flash\|mini\|lite\|nano\|haiku\|luna\|small\|fast\|cheap)([-/_ .\d]\|$)/` | (packages/models/src/model-catalog.ts:101-103) |
| `medium` | Output price <= $15.00 / 1M tokens | `/sonnet\|terra\|sol\|glm\|deepseek\|kimi\|qwen\|grok\|gemini\|gpt\|claude/` | (packages/models/src/model-catalog.ts:101, :105) |
| `high` | Output price > $15.00 / 1M tokens | `/opus\|pro\b\|-pro\|astra\|ultra\|max\|large\|fable/` | (packages/models/src/model-catalog.ts:101, :104) |
| `unknown` | Model string null/empty or unpriced and unmatched by name patterns | None | (packages/models/src/model-catalog.ts:99, :106) |

## Business rules

- Project execution host constraint: When `catalog.runHostId` is defined, the chosen model must be present on that specific host (packages/models/src/model-catalog.ts:27-30, :78-81).
- Non-blocking unknown connectivity: If `hostId` is absent, or if host connectivity cannot be verified, `offeredOnHost` returns `null`; `null` is never treated as a reason to stop execution (packages/models/src/model-catalog.ts:54-55, :58-64).
- Node effort restriction: Node reasoning efforts are constrained to `NODE_EFFORTS` (`low`, `medium`, `high`, `xhigh`, `ultracode`, `max`) (packages/models/src/model-catalog.ts:34, :90).
- Preset name normalization: Preset lookup normalizes unicode dashes, strips trailing parentheses, and collapses whitespace (packages/models/src/model-presets.ts:30-36).
- Preset setting override: Settings override a preset only when both `workflow.preset.<slug>.provider` and `.model` are defined; an effort setting overrides either way (packages/models/src/model-presets.ts:41-48).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `findProvider` | Locates a provider in the catalog by ID | (packages/models/src/model-catalog.ts:40) |
| `findModel` | Locates a model in a provider by ID or model name | (packages/models/src/model-catalog.ts:43) |
| `findModelIn` | Searches an array of models matching `id` or `model` | (packages/models/src/model-catalog.ts:42) |
| `defaultModelIn` | Returns the ID of a provider's catalog default model | (packages/models/src/model-catalog.ts:45) |
| `catalogProviderOf` | Returns the sole provider offering a model across the catalog | (packages/models/src/model-catalog.ts:48-51) |
| `offeredOnHost` | Determines whether a specific host offers a model | (packages/models/src/model-catalog.ts:57-64) |
| `validateChoice` | Validates provider, host availability, model, effort, and service tier | (packages/models/src/model-catalog.ts:70-87) |
| `nodeEffortsFor` | Returns reasoning efforts for a model filtered by node schema limits | (packages/models/src/model-catalog.ts:90) |
| `costTier` | Categorizes a model into price tier (`low`, `medium`, `high`, `unknown`) | (packages/models/src/model-catalog.ts:98-107) |
| `presetSlug` | Resolves a user or chain preset name to its canonical slug | (packages/models/src/model-presets.ts:33-36) |
| `presetSelection` | Resolves a preset slug and settings to provider, model, and effort | (packages/models/src/model-presets.ts:41-48) |
| `BUILTIN_PRESETS` | Registry of built-in preset configurations and aliases | (packages/models/src/model-presets.ts:14-23) |

## Gotchas

For implementation traps regarding host connectivity semantics and preset naming, see [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Models Workspace — Overview](../overview.md)
