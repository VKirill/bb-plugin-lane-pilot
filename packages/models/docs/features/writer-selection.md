---
title: Writer Selection and Fallbacks
type: component
created: 2026-11-08
updated: 2026-11-14
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
  - packages/models/tests/role-models.test.ts
  - packages/models/tests/role-models-argon.test.ts
  - packages/models/tests/zcode.test.ts
---

# Writer Selection and Fallbacks

TL;DR: Knows coding models by writer profile key, clamps reasoning efforts to the live catalog, maps service tiers, builds fallback chains, and rotates task assignments.

## Purpose

The writer subsystem manages execution models for task writers (packages/models/src/model-profiles.ts:1-4).
The package maintains `ROLE_TABLE` for role-based model resolution; writer selection uses a separate table of known `WRITER_PROFILES` for `writer.models_off` matching while allowing any configured `provider/model` ([Role-to-Model Resolution](role-models.md); packages/models/src/role-models.ts:103-146; packages/models/src/model-profiles.ts:1-34).

## How it works

1. The writer is the project's `writer.provider`/`writer.model`; a pair listed in `writer.models_off` is skipped (`writerSwitchedOff`, packages/models/src/model-profiles.ts:41-46). There is no per-task model pick.
2. Determine writer service tier via `writerServiceTier`: inspect `writer.service_tier` ("standard" or "fast"), falling back to legacy `writer.fast_mode` ("1", "true", "on") (packages/models/src/writer-reasoning.ts:37-45). Map to BB service tier using `bbServiceTier` ("fast" -> "fast", otherwise "default") (packages/models/src/writer-reasoning.ts:47-49).
3. Check `listedServiceTier`: strip tier when the provider lacks `supportsServiceTier` capability or when "default" tier is unlisted (packages/models/src/writer-reasoning.ts:55-59).
4. Resolve the reasoning effort with `resolveWriterReasoning`: `writer.reasoning_effort`, clamped to the model's listed levels, with a diagnostic reason (packages/models/src/writer-reasoning.ts:12-32).
5. Build the final execution payload using `writerExecutionSelection`: ensure provider and model consistency via `consistentProvider` and mark input sources as explicit (packages/models/src/writer-reasoning.ts:61-80).
6. Fallback defaults are GLM-5.3 Flash (slot 1), Gemini 3.8 Flash high (slot 2), and off (slot 3) (packages/models/src/writer-fallbacks.ts:12-16). `writerFallbackSlots` reads configured slots and uses the matching default when a provider is unset; malformed configured values turn that slot off (packages/models/src/writer-fallbacks.ts:26-36).
7. Assemble the fallback sequence using `writerFallbackChain`: deduplicate against the primary writer and append the PM model as the emergency fallback (packages/models/src/writer-fallbacks.ts:44-54).
8. Apply task rotation via `rotatedWriterSettings`: compute an FNV-1a hash bucket of `taskId` via `rotationBucket`; if below `writer.rotation_share` (default 25%), swap the primary writer with fallback 1 and set `writer.rotated = true` (packages/models/src/writer-fallbacks.ts:62-84).

### Known writer profiles

| Profile key | Provider ID | Model | Label | Tier | Evidence |
|---|---|---|---|---|---|
| `composer` | `acp-cursor` | `composer-2.5` | Composer 2.5 (Cursor) | `standard` | (packages/models/src/model-profiles.ts:17) |
| `grok` | `acp-cursor` | `grok-4.6` | Grok 4.6 (Cursor) | `standard` | (packages/models/src/model-profiles.ts:18) |
| `gemini-flash` | `opencode2` | `router9/ag/gemini-3.8-flash-high` | Gemini 3.8 Flash high (9router) | `standard` | (packages/models/src/model-profiles.ts:19) |
| `gpt-astra` | `codex` | `gpt-6-astra` | GPT-6 Astra (Codex) | `strong` | (packages/models/src/model-profiles.ts:20) |
| `gpt-sol` | `codex` | `gpt-6.1-sol` | GPT-6.1 Sol (Codex) | `strong` | (packages/models/src/model-profiles.ts:21) |
| `gpt-terra` | `codex` | `gpt-6.1-terra` | GPT-6.1 Terra (Codex) | `standard` | (packages/models/src/model-profiles.ts:22) |
| `gpt-luna` | `codex` | `gpt-6-luna` | GPT-6 Luna (Codex) | `light` | (packages/models/src/model-profiles.ts:23) |
| `sonnet` | `claude-code` | `claude-sonnet-5-5` | Claude Sonnet 5.5 | `standard` | (packages/models/src/model-profiles.ts:24) |
| `fable` | `claude-code` | `claude-fable-5-1` | Claude Fable 5.1 | `strong` | (packages/models/src/model-profiles.ts:25) |
| `opus` | `claude-code` | `claude-opus-5-5` | Claude Opus 5.5 | `strong` | (packages/models/src/model-profiles.ts:26) |
| `swe2` | `devin` | `swe-2-high` | SWE-2 (Devin) | `strong` | (packages/models/src/model-profiles.ts:27) |
| `glm-flash` | `opencode2` | `zai-coding-plan/glm-5.3-flash` | GLM-5.3 Flash (Z.AI) | `light` | (packages/models/src/model-profiles.ts:28) |
| `zcode-flash` | `zcode` | `glm-5.3-flash-free` | ZCode · GLM-5.3-Flash · Free | `standard` | (packages/models/src/model-profiles.ts:29) |
| `haiku` | `claude-code` | `claude-haiku-5-5` | Claude Haiku 5.5 | `light` | (packages/models/src/model-profiles.ts:30) |
| `minimax-flash` | `opencode2` | `openlux/MiniMax-M3.1-Flash` | MiniMax M3.1 Flash | `light` | (packages/models/src/model-profiles.ts:31) |
| `gemini-pro` | `opencode2` | `openrouter/~google/gemini-pro-latest` | Gemini Pro | `strong` | (packages/models/src/model-profiles.ts:32) |
| `gemini-argon` | `acp-antigravity` | `gemini-4-argon` | Gemini 4 Argon | `strong` | (packages/models/src/model-profiles.ts:33) |

### Failures and compensation

| Failure condition | Detected trigger | System response | Evidence |
|---|---|---|---|
| Effort the model does not list | `writer.reasoning_effort` not in `supportedLevels` | Uses the nearest listed effort; records `manual_effort_clamped:<from>-><to>` | (packages/models/src/writer-reasoning.ts:12-32) |
| Catalog unavailable | `supportedLevels === null` | Uses the setting; records `selected_model_catalog_unavailable` | (packages/models/src/writer-reasoning.ts:18-21) |
| Provider limit refusal | A short provider response matches a limit form, including `unavailable (reset after …)`, `[403]`, and bare `HTTP 403` | `providerLimitNotice` classifies the response as a provider limit; that provider refusal means the task did not run | (packages/models/src/provider-limit.ts:1-13) |
| Primary writer failure | Quota exhaustion, network fault, or provider error | Dispatches attempt to next candidate in `writerFallbackChain` | (packages/models/src/writer-fallbacks.ts:44-54) |

## Business rules

- Stable rotation hash: Writer rotation computes an FNV-1a 32-bit hash on `taskId` modulo 100 via `rotationBucket`; every attempt of a task lands in the same bucket (packages/models/src/writer-fallbacks.ts:65-69).
- Rotation share bounds: `writer.rotation_share` evaluated with `WRITER_ROTATION_SHARE_DEFAULT` is clamped between 0 and 100 with default 25; a share of 0 disables rotation (packages/models/src/writer-fallbacks.ts:62-74).
- Fallback chain deduplication: A candidate matching the primary writer or an earlier fallback in `providerId/model` is discarded from the chain (packages/models/src/writer-fallbacks.ts:45-50).
- Provider and model consistency: `writerExecutionSelection` passes provider and model through `consistentProvider`, preventing mismatch errors (packages/models/src/writer-reasoning.ts:68-70).
- Stage writer override order: `resolveStageWriterSelection` checks stage provider/model first, then writer profile settings, then prototype config (packages/models/src/stage-writer-selection.ts:15-31).
- Worker exclusion: `writer.models_off` entries match a profile key, a `provider/model` pair, or a bare model ID. A match omits that candidate while leaving its writer configuration intact (packages/models/src/model-profiles.ts:36-46).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `WRITER_PROFILES` | Registry of 17 known writer profiles with provider, model, label, and cost tier | (packages/models/src/model-profiles.ts:16-34) |
| `writerSwitchedOff` | Finds a matching `writer.models_off` entry by profile key, `provider/model`, or bare model ID | (packages/models/src/model-profiles.ts:41-46) |
| `resolveWriterReasoning` | Clamps the configured effort to the model's listed levels | (packages/models/src/writer-reasoning.ts:12-32) |
| `writerExecutionSelection` | Prepares execution parameters and sources for writer spawns | (packages/models/src/writer-reasoning.ts:61-80) |
| `writerServiceTier` | Reads `writer.service_tier` and legacy `writer.fast_mode` settings | (packages/models/src/writer-reasoning.ts:37-45) |
| `bbServiceTier` | Normalizes writer tier to "fast" or "default" | (packages/models/src/writer-reasoning.ts:47-49) |
| `listedServiceTier` | Filters service tiers according to provider capabilities | (packages/models/src/writer-reasoning.ts:55-59) |
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
