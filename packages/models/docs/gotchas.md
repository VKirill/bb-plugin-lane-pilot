---
title: Models Workspace — Gotchas
type: gotchas
created: 2026-11-08
updated: 2026-11-12
status: active
confidence: medium
tags: [models, gotchas, edge-cases, validation, providers]
sources:
  - packages/models/src/role-models.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/zcode.ts
  - packages/models/src/model-catalog.ts
  - packages/models/src/model-prices.ts
  - packages/models/src/provider-limit.ts
  - packages/models/src/writer-fallbacks.ts
  - packages/models/src/jev-reasoning.ts
  - packages/models/src/providers.ts
  - packages/models/src/picker-compat.ts
  - packages/models/tests/role-models.test.ts
  - packages/models/tests/zcode.test.ts
  - packages/models/tests/model-prices.test.ts
  - packages/models/tests/picker-compat.test.ts
---

# Models Workspace — Gotchas

TL;DR: Critical edge cases, provider mismatches, profile restrictions, and validation nuances across `@lane-pilot/models`.

## Native provider family enforcement

- The native providers `claude-code` and `codex` can only serve models belonging to their native model families (packages/models/src/role-models.ts:192-193).
- If a caller supplies an invalid pair like `{ provider: "codex", model: "claude-opus-5-5" }`, `rowOption` rejects the option as invalid (`undefined`) (packages/models/src/role-models.ts:192-193).
- When normalizing providers before execution, `consistentProvider` overrides any mismatched native provider; for example, passing `claude-code` with a GPT model forces provider `codex` (packages/models/src/role-models.ts:287-295).

## ZCode exactOnly matching vs OpenCode GLM

- The ZCode option `glm-5.3-flash-free` defines `exactOnly: true` (packages/models/src/role-models.ts:47).
- In `optionOfName`, models whose name ends with the same suffix (such as `zai-coding-plan/glm-5.3-flash`) do not resolve to the ZCode option (packages/models/src/role-models.ts:55-58).
- Calling `consistentProvider(null, "glm-5.3-flash-free")` returns `"zcode"`, whereas `consistentProvider(null, "zai-coding-plan/glm-5.3-flash")` returns `null` because the OpenCode model is not in the role table (packages/models/tests/zcode.test.ts:32-33).

## Claude profile roles cannot switch providers

- Roles in `CLAUDE_PROFILE_ROLES` (`specialist`, `workflow-architect`, `lead`, `copy-lead`, `seo-specialist`, `growth-marketer`, `design-lead`, `video-lead`, `tavily`, `3d-artist`, `game-dev`, `social-manager`, `billing-assistant`, `visual-artist`, `macos-operator`) run as native Claude Code agent profiles (packages/models/src/agent-model.ts:6-10).
- When resolving candidate pools for these roles in `resolveAgentModel`, candidate models on non-Claude providers are stripped (`option.providerId === "claude-code"`) (packages/models/src/agent-model.ts:131-134).
- When quota limits are reached, `peerOffSpent` is bypassed for all `CLAUDE_PROFILE_ROLES`; moving a Claude profile to another provider causes the BB core spawn to reject with HTTP 409 (`native profile needs Claude Code`) (packages/models/src/agent-model.ts:168-170).

## Pool ranking is strictly fallback, not load sharing

- In `rankPool`, models maintain the owner's configured sequence; unspent models always precede spent models (packages/models/src/agent-model.ts:76-79).
- Tasks are not distributed across pool candidates to balance load; the primary candidate is always selected unless the provider is marked spent or unavailable on the run host (packages/models/src/agent-model.ts:72-75, :136).
- Schedulers or consumers must not expect round-robin execution across fallback pool members (packages/models/src/agent-model.ts:72-75).

## ZCode promo window arithmetic crosses midnight

- The ZCode promo window spans from 15:00 UTC to 01:00 UTC of the following calendar day (packages/models/src/zcode.ts:16-19).
- Condition `inZcodePromo` checks `hour >= 15 || hour < 1` (packages/models/src/zcode.ts:31-34).
- In `nextZcodePromoStart`, when the calculated 15:00 UTC target is less than or equal to the current timestamp, the UTC date is incremented by 1 before converting to an ISO string (packages/models/src/zcode.ts:37-42).
- Setting `zcode.window = "always"` overrides the promo window check completely (packages/models/src/zcode.ts:48-50).

## Unknown models return null in pricing calculations

- `priceFor` strips context tags and snapshot suffixes, but returns `null` if the normalized name is not in `MODEL_PRICES` (packages/models/src/model-prices.ts:25-28).
- `costUsd` does not fall back to an average or zero for unlisted models; it returns `null` immediately (packages/models/src/model-prices.ts:33-34).
- Downstream accounting code must handle `null` explicitly rather than assuming numeric return values (packages/models/src/model-prices.ts:30-42).

## Host connectivity semantics: Gemini vs native providers

- For Gemini models routed through 9router (`router9/ag/gemini-3.8-flash-high`), `offeredForRole` returns `false` (not `null`) if the machine is connected but lacks the model in its catalog (packages/models/src/role-models.ts:266-271).
- This explicit `false` allows review roles (`plan-critic`, `code-critic`) to drop to their GPT fallback model (`gpt-6.1-sol`) immediately rather than failing inside the spawn (packages/models/src/role-models.ts:261-264, :274-278).
- For native providers (`claude-code`, `codex`), missing catalog entries return `null` because native providers are assumed available across connected machines (packages/models/src/role-models.ts:269-271).

## Inherited legacy escalation vs explicit light configuration

- Deciding roles define a `least` tier requirement in `ROLE_LEAST_TIER` (e.g. `planner` requires `strong`, `code-critic` requires `standard`) (packages/models/src/agent-model.ts:100; packages/models/src/role-models.ts:77-78).
- If a role inherits a legacy stage setting below its `least` tier, `resolveRoleModel` passes over that setting, promotes the selection to the role default, and records `escalated: true` with issue `escalated_for_role` (packages/models/src/role-models.ts:319-321; packages/models/src/agent-model.ts:119, :161).
- If the owner explicitly picks a light model in `role_model.<role>`, the pick is honored without promotion, and issue `light_model_for_role` is emitted as a diagnostic warning (packages/models/src/agent-model.ts:120, :163).

## Provider limit notice character count ceiling

- The function `providerLimitNotice` inspects stdout/stderr for provider quota exhaustion keywords using `PROVIDER_LIMIT` (packages/models/src/provider-limit.ts:3-12).
- Its reset-time forms include `unavailable (reset after …)` and `http 403 (reset after …)` (packages/models/src/provider-limit.ts:3).
- Outputs exceeding 400 characters are discarded by `providerLimitNotice` and return `null` (packages/models/src/provider-limit.ts:9-12).
- This length guard prevents false positives when a build log, test run, or diff report mentions rate-limiting logic or variables (packages/models/src/provider-limit.ts:9-12).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Model Catalog and Validation](features/model-catalog.md)
- [Role-to-Model Resolution](features/role-models.md)
- [Role Specification Registry](features/role-specs.md)
- [Token Pricing and Compatibility](features/token-pricing.md)
- [Writer Selection and Fallbacks](features/writer-selection.md)
- [ZCode Integration Rules](features/zcode-integration.md)
- [Models Workspace — Overview](overview.md)
