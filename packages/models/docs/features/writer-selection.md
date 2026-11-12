---
title: Writer Selection and Fallbacks
type: component
created: 2026-11-08
updated: 2026-11-11
status: active
confidence: medium
tags: [models, writers, table, writer-reasoning, fallbacks, rotation]
sources:
  - packages/models/src/model-profiles.ts
  - packages/models/src/writer-reasoning.ts
  - packages/models/src/writer-fallbacks.ts
  - packages/models/src/stage-writer-selection.ts
  - packages/models/src/model-tiers.ts
  - packages/models/src/providers.ts
  - packages/models/src/role-models.ts
  - packages/models/src/setting-value.ts
  - packages/models/src/provider-limit.ts
  - packages/models/tests/writer-fallbacks.test.ts
  - packages/models/tests/jev-plan.test.ts
  - packages/models/tests/writer-preset.test.ts
---

# Writer Selection and Fallbacks

TL;DR: Evaluates coding models from the writers' anamnesis, resolves Jev reasoning efforts and service tiers, constructs fallback chains, and rotates task assignments.

## Purpose

The writer subsystem manages execution models for task writers (packages/models/src/model-profiles.ts:1-6).
The package maintains `ROLE_TABLE` for role-based model resolution; writer selection uses a separate registry of coding profiles and filters those profiles as candidates ([Role-to-Model Resolution](role-models.md); packages/models/src/role-models.ts:102-145; packages/models/src/model-profiles.ts:24-120).

## How it works

1. The writer is the project's `writer.provider`/`writer.model`; a pair listed in `writer.models_off` is skipped (`writerSwitchedOff`, packages/models/src/model-profiles.ts). There is no per-task model pick.
2. Determine writer service tier via `writerServiceTier`: inspect `writer.service_tier` ("standard" or "fast"), falling back to legacy `writer.fast_mode` ("1", "true", "on") (packages/models/src/writer-reasoning.ts:40-48). Map to BB service tier using `bbServiceTier` ("fast" -> "fast", otherwise "default") (packages/models/src/writer-reasoning.ts:50-52).
3. Check `listedServiceTier`: strip tier when the provider lacks `supportsServiceTier` capability or when "default" tier is unlisted (packages/models/src/writer-reasoning.ts:58-62).
4. Resolve the reasoning effort with `resolveWriterReasoning`: `writer.reasoning_effort`, clamped to the model's listed levels, with a diagnostic reason (packages/models/src/writer-reasoning.ts).
5. Build the final execution payload using `writerExecutionSelection`: ensure provider and model consistency via `consistentProvider` and mark input sources as explicit (packages/models/src/writer-reasoning.ts:64-84).
6. Fallback defaults are GLM-5.3 Flash (slot 1), Gemini 3.8 Flash high (slot 2), and off (slot 3) (packages/models/src/writer-fallbacks.ts:12-16). `writerFallbackSlots` reads configured slots and uses the matching default when a provider is unset; malformed configured values turn that slot off (packages/models/src/writer-fallbacks.ts:25-35).
7. Assemble the fallback sequence using `writerFallbackChain`: deduplicate against the primary writer and append the PM model as the emergency fallback (packages/models/src/writer-fallbacks.ts:44-54).
8. Apply task rotation via `rotatedWriterSettings`: compute an FNV-1a hash bucket of `taskId` via `rotationBucket`; if below `writer.rotation_share` (default 25%), swap the primary writer with fallback 1 and set `writer.rotated = true` (packages/models/src/writer-fallbacks.ts:62-84).

### Writer profiles in the anamnesis

| Profile key | Provider ID | Model | Default effort | Tier | Status | Focus and suitability | Evidence |
|---|---|---|---|---|---|---|---|
| `composer` | `acp-cursor` | `composer-2.5` | `medium` | `standard` | Active | Everyday multi-file features and refactors in mainstream stacks | (packages/models/src/model-profiles.ts:25-29) |
| `grok` | `acp-cursor` | `grok-4.6` | `medium` | `standard` | Active | Routine features and fixes following a written plan; multi-file work and long well-specified runs | (packages/models/src/model-profiles.ts:31-32) |
| `gemini-flash` | `opencode2` | `router9/ag/gemini-3.8-flash-high` | `medium` | `standard` | Active | Fast prototyping, UI tweaks, and quick well-described tasks | (packages/models/src/model-profiles.ts:35-39) |
| `gpt-astra` | `codex` | `gpt-6-astra` | `high` | `strong` | Active | The most demanding scientific or research-heavy coding when Sol has failed | (packages/models/src/model-profiles.ts:41-42) |
| `gpt-sol` | `codex` | `gpt-6.1-sol` | `high` | `strong` | Active | Algorithmic and backend logic, difficult bugs, terminal and build work | (packages/models/src/model-profiles.ts:45-49) |
| `gpt-terra` | `codex` | `gpt-6.1-terra` | `medium` | `standard` | Active | Well-specified moderate features and fixes, terminal and build work, UI changes, and data analysis | (packages/models/src/model-profiles.ts:51-52) |
| `gpt-luna` | `codex` | `gpt-6-luna` | `high` | `light` | Active | Small mechanical tasks with clear checks: configs, tests, one-file fixes, scripts, and documentation | (packages/models/src/model-profiles.ts:56-57) |
| `sonnet` | `claude-code` | `claude-sonnet-5-5` | `medium` | `standard` | Active | Daily features, bug fixes, refactors, documentation, and UI copy | (packages/models/src/model-profiles.ts:60-64) |
| `fable` | `claude-code` | `claude-fable-5-1` | `high` | `strong` | Active | Long-horizon multi-step features, deep debugging, architecture changes | (packages/models/src/model-profiles.ts:65-69) |
| `opus` | `claude-code` | `claude-opus-5-5` | `high` | `strong` | Active | High-risk cross-cutting refactors, security-sensitive logic, migrations | (packages/models/src/model-profiles.ts:70-74) |
| `swe2` | `devin` | `swe-2-high` | `high` | `strong` | Active | Hard features, deep debugging, cross-cutting refactors, and tasks other writers failed | (packages/models/src/model-profiles.ts:76-77) |
| `glm-flash` | `opencode2` | `zai-coding-plan/glm-5.3-flash` | `high` | `light` | Active | Routine agentic coding, scripts, small failure debugging | (packages/models/src/model-profiles.ts:80-84) |
| `zcode-flash` | `zcode` | `glm-5.3-flash-free` | `high` | `standard` | Active | Bulk mechanical edits, documentation, tests, patterned migrations | (packages/models/src/model-profiles.ts:85-90) |
| `haiku` | `claude-code` | `claude-haiku-5-5` | `medium` | `light` | Active | Short, well-scoped edits with clear checks; not large features or wide repository changes | (packages/models/src/model-profiles.ts:92-93) |
| `minimax-flash` | `opencode2` | `openlux/MiniMax-M3.1-Flash` | `high` | `light` | Inactive | Pay-per-token via OpenLux; kept out of automatic picks | (packages/models/src/model-profiles.ts:97-100) |
| `gemini-pro` | `opencode2` | `openrouter/~google/gemini-pro-latest` | `high` | `strong` | Inactive | Owner marks it weak for this work and does not use it | (packages/models/src/model-profiles.ts:102-103) |
| `gemini-argon` | `acp-antigravity` | `gemini-4-argon` | `high` | `strong` | Inactive | Antigravity subscription model; pending review-based profile | (packages/models/src/model-profiles.ts:105-108) |

### Failures and compensation

| Failure condition | Detected trigger | System response | Evidence |
|---|---|---|---|
| Effort the model does not list | `writer.reasoning_effort` not in `supportedLevels` | Uses the nearest listed effort; records `manual_effort_clamped:<from>-><to>` | (packages/models/src/writer-reasoning.ts) |
| Catalog unavailable | `supportedLevels === null` | Uses the setting; records `selected_model_catalog_unavailable` | (packages/models/src/writer-reasoning.ts) |
| Provider limit refusal | A short provider response matches a limit form, including `HTTP 403 (reset after …)` | `providerLimitNotice` classifies the response as a provider limit; that provider refusal means the task did not run (packages/models/src/provider-limit.ts:1-3,9-13) |
| Primary writer failure | Quota exhaustion, network fault, or provider error | Dispatches attempt to next candidate in `writerFallbackChain` | (packages/models/src/writer-fallbacks.ts:44-54) |

## Business rules

- Stable rotation hash: Writer rotation computes an FNV-1a 32-bit hash on `taskId` modulo 100 via `rotationBucket`; every attempt of a task lands in the same bucket (packages/models/src/writer-fallbacks.ts:65-69).
- Rotation share bounds: `writer.rotation_share` evaluated with `WRITER_ROTATION_SHARE_DEFAULT` is clamped between 0 and 100 with default 25; a share of 0 disables rotation (packages/models/src/writer-fallbacks.ts:62-74).
- Fallback chain deduplication: A candidate matching the primary writer or an earlier fallback in `providerId/model` is discarded from the chain (packages/models/src/writer-fallbacks.ts:45-50).
- Provider and model consistency: `writerExecutionSelection` passes provider and model through `consistentProvider`, preventing mismatch errors (packages/models/src/writer-reasoning.ts:71-73).
- Stage writer override order: `resolveStageWriterSelection` checks stage provider/model first, then writer profile settings, then prototype config (packages/models/src/stage-writer-selection.ts:15-31).
- Worker exclusion: `writer.models_off` entries match a profile key, a `provider/model` pair, or a bare model ID. A match omits that candidate while leaving its writer configuration intact (packages/models/src/model-profiles.ts:112-129).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `WRITER_PROFILES` | Registry of coding models with benchmarks, summaries, and availability | (packages/models/src/model-profiles.ts:24-109) |
| `writerSwitchedOff` | Names the `writer.models_off` entry that switches a provider/model off | (packages/models/src/model-profiles.ts) |
| `writerSwitchedOff` | Finds a matching worker exclusion by profile key, `provider/model`, or bare model ID | (packages/models/src/model-profiles.ts:121-129) |
| `resolveWriterReasoning` | Clamps the configured effort to the model's listed levels | (packages/models/src/writer-reasoning.ts) |
| `writerExecutionSelection` | Prepares execution parameters and sources for writer spawns | (packages/models/src/writer-reasoning.ts:64-84) |
| `writerServiceTier` | Reads `writer.service_tier` and legacy `writer.fast_mode` settings | (packages/models/src/writer-reasoning.ts:40-48) |
| `bbServiceTier` | Normalizes writer tier to "fast" or "default" | (packages/models/src/writer-reasoning.ts:50-52) |
| `listedServiceTier` | Filters service tiers according to provider capabilities | (packages/models/src/writer-reasoning.ts:58-62) |
| `writerFallbackSlots` | Extracts the 3 fallback slots from settings with built-in defaults | (packages/models/src/writer-fallbacks.ts:26-36) |
| `writerFallbackChain` | Builds an ordered, deduplicated fallback list including the PM model | (packages/models/src/writer-fallbacks.ts:44-54) |
| `rotatedWriterSettings` | Swaps writer and fallback 1 for tasks falling within the rotation share | (packages/models/src/writer-fallbacks.ts:72-84) |
| `rotationBucket` | Deterministic FNV-1a hash bucket (0-99) for a task ID | (packages/models/src/writer-fallbacks.ts:65-69) |
| `resolveStageWriterSelection` | Resolves stage vs profile writer selections | (packages/models/src/stage-writer-selection.ts:15-39) |

## Gotchas

For implementation traps regarding rotation behavior, fallback slots, and service tier handling, see [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Models Workspace — Overview](../overview.md)
