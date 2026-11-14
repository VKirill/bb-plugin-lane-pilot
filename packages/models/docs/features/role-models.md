---
title: Role-to-Model Resolution
type: component
created: 2026-11-08
updated: 2026-11-14
status: active
confidence: medium
tags: [models, role-models, agent-model, cross-family, resolution]
sources:
  - packages/models/src/role-models.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/model-tiers.ts
  - packages/models/src/providers.ts
  - packages/models/src/zcode.ts
  - packages/models/tests/role-models.test.ts
  - packages/models/tests/role-models-argon.test.ts
---

# Role-to-Model Resolution

TL;DR: Maps agent roles to models across workflow graphs, enforces cross-family judge independence, ranks fallback pools, and handles provider quota saturation.

## Purpose

The role resolution system assigns models to workflow agent roles across graphs without per-step model overrides (packages/models/src/role-models.ts:1-4).
The model belongs to the role rather than the node or graph (packages/models/src/agent-model.ts:16-19).
It maintains cross-family judge separation so that code critics and reviewers do not share a model family with authors (packages/models/src/role-models.ts:89-101), and provides fallback chains when primary models or hosts are unavailable or over quota (packages/models/src/agent-model.ts:24-28).

## How it works

1. Resolve the role entry via `resolveRoleModel`: check owner settings `role_model.<role>` first, then legacy stage settings, then the built-in default from `ROLE_TABLE` (packages/models/src/role-models.ts:313-325).
2. If `input.pinned` is specified, pin the model directly; resolve its consistent provider via `consistentProvider` and verify host availability (packages/models/src/agent-model.ts:115-123).
3. Assemble candidate models in priority order: the chosen role model, the owner's configured pool from `tablePoolAt`, the free ZCode model for eligible background roles, the built-in default, the role fallback model, and the PM chat model (packages/models/src/agent-model.ts:127-145).
4. Rank the candidate pool using `rankPool`: keep models in configured order while moving spent providers to the end of the pool (packages/models/src/agent-model.ts:76-79, :136).
5. If the role is a judge with a known author from `AUTHOR_ROWS`, check cross-family separation with `judgeAgainstAuthor` (packages/models/src/agent-model.ts:148-156). When the judge matches the author's family, select a peer from another family (packages/models/src/role-models.ts:358-366).
6. Pick the first candidate offered on the target host (packages/models/src/agent-model.ts:151-158).
7. Unless the role belongs to `CLAUDE_PROFILE_ROLES`, if the chosen provider is near quota exhaustion according to `input.spent`, execute `peerOffSpent` to switch to an available peer in another family (packages/models/src/role-models.ts:383-391; packages/models/src/agent-model.ts:170-180).
8. Return the final `AgentModel` containing provider, model, reasoning effort, service tier, source, source key, and accumulated diagnostic issue codes (packages/models/src/agent-model.ts:35-45, :104).

### Modes, variants, and role groupings

| Role grouping | Member roles | Default model & effort | Family & tier | Evidence |
|---|---|---|---|---|
| Primary authors | `analyst`, `planner`, `workflow-architect`, `lead`, `specialist` | Claude Opus 5.5 (`high`) | `claude`, `strong` | (packages/models/src/role-models.ts:104-108) |
| Creative & domain leads | `copy-lead`, `seo-specialist`, `growth-marketer`, `design-lead`, `video-lead`, `visual-artist`, `tavily`, `3d-artist`, `game-dev` | Claude Sonnet 5.5 (`high`) | `claude`, `standard` | (packages/models/src/role-models.ts:109-116, :119) |
| Routine execution & operators | `social-manager`, `billing-assistant`, `macos-operator`, `errand`, `errand-browser`, `browser-qa` | Claude Sonnet 5.5 (`medium`) | `claude`, `standard` | (packages/models/src/role-models.ts:117-118, :120, :135, :141, :143) |
| Specialized errands | `errand-computer`, `errand-devops` (Opus 5.5 high); `errand-research` (Sonnet 5.5 high); `api-recon` (Terra high) | Varied by errand requirements | Varied (`claude` / `gpt`) | (packages/models/src/role-models.ts:138-140, :142) |
| Reviews & critics | `plan-critic`, `specialist-reviewer`, `code-critic`, `episode-analyst`, `triager` | Gemini 3.8 Flash high via 9router (`medium`); fallback to GPT-6.1 Sol or GPT-6 Luna | `google`, `standard` | (packages/models/src/role-models.ts:121, :123-124, :130, :132) |
| Light plan review | `plan-critic-light` | Gemini 4 Hydrogen via Antigravity (`medium`); fallback to GPT-6.1 Terra (`medium`) | `google`, `standard` | (packages/models/src/role-models.ts:122) |
| Deep analysis & judges | `auditor`, `debugger`, `council`, `wall-hunter`, `repairer` | GPT-6.1 Sol (`high`) | `gpt`, `strong` | (packages/models/src/role-models.ts:125-127, :131, :145) |
| Upkeep & background | `pm-reader` (Haiku 5.5 low); `memory`, `project-life` (Haiku 5.5 medium); `docs-maintainer`, `rules-analyzer` (Luna high) | Varied small models | `claude` / `gpt`, `light` | (packages/models/src/role-models.ts:128-129, :133-134, :144) |

### Failures and diagnostic issues

| Diagnostic issue | Cause | Resulting action / behavior | Evidence |
|---|---|---|---|
| `selection_unavailable` | The primary candidate (from table or settings) is not offered on the run host | Resolution advances to default, fallback, or PM candidates | (packages/models/src/agent-model.ts:157-164) |
| `model_unavailable_here` | No candidate in the chain is offered on the host, or pinned model is unavailable | The executor retains the target model and halts with host details | (packages/models/src/agent-model.ts:121, :185) |
| `crossed_family` | A judge shared the model family of its author and was switched to a peer | The peer in the alternate family executes the review | (packages/models/src/agent-model.ts:155-160) |
| `same_family_judge` | A judge shares the author family, but no peer was offered on the host | The judge executes on the original model; marked non-independent | (packages/models/src/agent-model.ts:156-181) |
| `SAME_FAMILY_JUDGE_BY_LIMIT` | Quota exhaustion shifted a previously independent judge into the author's family | Permitted because quota limit is the higher priority; flag recorded | (packages/models/src/role-models.ts:375; packages/models/src/agent-model.ts:177) |
| `escalated_for_role` | An inherited legacy stage selection fell below the role's minimum tier (`least`) | The model was elevated to the role's built-in default | (packages/models/src/agent-model.ts:119, :161; packages/models/src/role-models.ts:321-324) |
| `light_model_for_role` | The owner's explicit table pick or pin uses a light model for a deciding role | The model runs as requested, but the diagnostic warning is emitted | (packages/models/src/agent-model.ts:120, :163) |
| `USAGE_MOVED_ISSUE` | The candidate's provider exceeded its quota threshold in `input.spent` | Switched by `peerOffSpent` to an unspent peer in another family | (packages/models/src/role-models.ts:373-390; packages/models/src/agent-model.ts:170-179) |

## Business rules

- Author independence: Authors (`analyst`, `planner`, `workflow-architect`, `specialist`) default to Claude Opus 5.5; judges (`plan-critic`, `plan-critic-light`, `code-critic`, `auditor`, `council`) default to another family (packages/models/src/role-models.ts:89-101, :122). `AUTHOR_ROWS` and `pmAuthorOf` map `plan-critic-light` to `planner` and the PM model alongside `plan-critic` and `specialist-reviewer` (packages/models/src/agent-model.ts:82-92).
- Cross-family peer symmetry: Claude and GPT models pair by strength: Opus 5.5 pairs with GPT-6.1 Sol, Sonnet 5.5 pairs with GPT-6.1 Terra, Haiku 5.5 pairs with GPT-6 Luna, and Fable 5.1 pairs with GPT-6 Astra (packages/models/src/role-models.ts:328-331).
- Third-family peer ordering: Google and GLM models take GPT-6.1 Sol first, then Claude Opus 5.5 (packages/models/src/role-models.ts:333-336).
- Native provider exclusivity: Providers `claude-code` and `codex` serve only their native families; `rowOption` rejects mismatched table pairs, and `consistentProvider` overrides a mismatched native provider for any model in `ROLE_MODEL_OPTIONS` (packages/models/src/role-models.ts:194-195, :289-298).
- Profile role protection: Roles in `CLAUDE_PROFILE_ROLES` (`specialist`, `workflow-architect`, `lead`, `copy-lead`, `seo-specialist`, `growth-marketer`, `design-lead`, `video-lead`, `tavily`, `3d-artist`, `game-dev`, `social-manager`, `billing-assistant`, `visual-artist`, `macos-operator`) run as Claude Code agent profiles; they cannot be reassigned to other providers via pools or `peerOffSpent` (packages/models/src/agent-model.ts:6-10, :131-134, :170).
- Minimum tier enforcement: Deciding roles define a `least` tier in `ROLE_LEAST_TIER` (packages/models/src/agent-model.ts:100; packages/models/src/role-models.ts:79, :105, :124-126). Inherited stage selections below this tier are elevated to default (packages/models/src/role-models.ts:321-324).
- Free background tokens: Eligible background roles (`ZCODE_FREE_ROWS`) try ZCode free tokens first during promo hours when enabled by `zcode.background` (packages/models/src/zcode.ts:78-80; packages/models/src/agent-model.ts:139-141).
- Pool prioritization: Fallback pools are sequential fallbacks rather than load sharing; `rankPool` preserves the configured order while moving spent providers to the end, and candidate selection skips models not offered on the host (packages/models/src/agent-model.ts:72-79, :136, :151-158).

## Public API

| Function or constant | Purpose | Evidence |
|---|---|---|
| `ROLE_TABLE` | Master list of all 40 table roles, their defaults, fallbacks, and tiers | (packages/models/src/role-models.ts:103-146) |
| `ROLE_MODEL_OPTIONS` | Allowed options in the role table (12 models across `claude`, `gpt`, `google`, and `glm`) with provider, family, and tier tags | (packages/models/src/role-models.ts:30-49) |
| `resolveRoleModel` | Resolves a role's model from settings alone (table pick -> legacy stage -> default) | (packages/models/src/role-models.ts:313-325) |
| `resolveAgentModel` | Pure resolution function for an agent step given settings, host offer probe, author, and spent probe | (packages/models/src/agent-model.ts:104-187) |
| `judgeAgainstAuthor` | Switches a judge to a cross-family peer if it shares the author's family | (packages/models/src/role-models.ts:358-366) |
| `peerOffSpent` | Reroutes a model on a saturated provider to an unspent peer in another family | (packages/models/src/role-models.ts:383-391) |
| `rankPool` | Sorts candidate pool entries, putting unspent options ahead of spent ones | (packages/models/src/agent-model.ts:76-79) |
| `roleModelProblem` | Validates a stored `role_model.<role>` value (role ID, provider <= 100 chars, model <= 200 chars, effort, and pool) and returns the first problem string or `null` | (packages/models/src/role-models.ts:231-253) |
| `consistentProvider` | Returns the valid provider for a model to prevent impossible provider/model pairings | (packages/models/src/role-models.ts:289-298) |

## Gotchas

For implementation traps regarding Claude profiles, pool ordering, and native provider restrictions, see [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Writer Selection and Fallbacks](writer-selection.md)
- [Models Workspace — Overview](../overview.md)
