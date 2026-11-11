---
title: Memory context packing
type: component
created: 2026-11-07
updated: 2026-11-11
status: active
confidence: high
tags: [memory, context, packing, budgets, roles, prompts]
sources:
  - packages/memory-core/src/context.ts
  - packages/memory-core/src/context-pack.ts
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/sections.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/terms.ts
  - packages/memory-core/src/settings.ts
  - src/rooms/writer/server/writer-knowledge.ts
  - src/rooms/writer/server/spawn.ts
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/compress.ts
---

# Memory context packing

TL;DR: Context packing assembles prompts and unified session context packs under strict role budgets, prioritizing required rules and dropping stale or low-relevance candidates.

## Purpose

The context packing subsystem bounds and formats project memory for injection into agent sessions and maintainer prompts, enforcing role-specific token ceilings without silently truncating required rules or conventions (`packages/memory-core/src/context.ts:48-64`, `packages/memory-core/src/context-pack.ts:21-67`).

## How it works

1. Resolving role budget ceiling: `roleContextBudget` checks the agent role against `ROLE_CONTEXT_BUDGET` (`pm: 1600`, `writer: 1600`, `critic: 1200`, `helper: 600`) and takes the minimum between the configured budget and the role cap (`packages/memory-core/src/context.ts:48-53`).
2. Candidate pre-screening: `buildContextPack` inspects each input `PackCandidate`:
   - Checks if candidate is stale (due to file drift); if so, marks `packed: false` with reason `"stale:needs_review"` (`packages/memory-core/src/context-pack.ts:35`).
   - Checks if candidate ID is in `floorDropIds`; if so, marks `packed: false` with reason `"floor:low-relevance"` (`packages/memory-core/src/context-pack.ts:36`).
   - Validates section chain scoping: shared scopes (`"project"`) pass; empty section chains require the candidate ID to be in `rootWhitelist`; otherwise the candidate's scope must match a prefix of the section chain (`packages/memory-core/src/context-pack.ts:39-43`). Unmatched scopes receive reason `"scope:not-deliverable"`.
3. Packing required candidates: isolates candidates where `required = true` and no exclusion reason was set. Evaluates their combined byte length; if the required candidates exceed the budget, `buildContextPack` (`packages/memory-core/src/context-pack.ts:26`) throws `context_pack_oversized` naming the largest candidate (`packages/memory-core/src/context-pack.ts:45-50`). Otherwise, each required source is packed (`source.packed = true`) into the text (`packages/memory-core/src/context-pack.ts:52-53`).
4. Packing optional candidates: sorts remaining eligible candidates by relevance descending, tie-breaking by ID. Appends candidates one by one as long as `estimateTokens(text) <= budget`. Once budget is exceeded, remaining candidates receive reason `"cut:over-budget"` (`packages/memory-core/src/context-pack.ts:54-58`).
5. Packaging context packet: generates an immutable `ContextPack` containing packed text, byte size, estimated token count, source arrays with exclusion reasons, and a deterministic `packId` (SHA-256 hash of project ID, role, and sorted packed candidate IDs) (`packages/memory-core/src/context-pack.ts:60-66`).
6. Prompt-based packing: `memoryContext` provides a legacy text packing mechanism: ranks memory records by query stem overlap weighted by usefulness and verification bonus, appending lines until budget is reached (`packages/memory-core/src/context.ts:55-64`).
7. Explaining delivery decisions: `explainMemory` compares candidate records against the output of `memoryContext`, returning delivery verdicts for each record: `"deliver <id> — matched the query"`, `"reject <id> — matched, cut by the context budget"`, or `"reject <id> — no token overlap"` (`packages/memory-core/src/context.ts:70-79`).
8. Maintenance prompt generation: `memoryMaintenanceBrief` and `memoryMaintenancePrompt` format task descriptions, accepted results, existing core/notes, file excerpts, and wave facts into a zero-tool prompt for the memory maintainer model (`packages/memory-core/src/context.ts:7-45`).
9. Preparing note shortening: `shortenText` normalizes eligible spacing and removes repeated sentences while preserving structural lines and fenced code; `proposeShorter` returns a candidate only when the result is shorter and fits the requested token ceiling (`packages/memory-core/src/compress.ts:33-82`). Applying or undoing that candidate is documented in [lifecycle and files](lifecycle-and-files.md).

## Modes, variants and branches

| Mode / Role | Budget limits | Candidate selection rule | Packaging behavior | Evidence |
|---|---|---|---|---|
| PM role | Clamped to max 1,600 tokens | Scoped notes, project facts | Packed under PM role ceiling | `packages/memory-core/src/context.ts:48-53` |
| Writer role | Clamped to max 1,600 tokens | Required conventions first, then ranked notes | Packed under writer role ceiling | `packages/memory-core/src/context.ts:48-53` |
| Critic / Reviewer | Clamped to max 1,200 tokens | Targets reviewer concepts (`"review"`, `"pitfall"`, `"invariant"`) | Packed under critic ceiling | `packages/memory-core/src/context.ts:48-53`, `packages/memory-core/src/settings.ts:40` |
| Helper role | Clamped to max 600 tokens | Minimal necessary guidance | Strict token limit | `packages/memory-core/src/context.ts:48-53` |
| Shadow pack comparison | Evaluated during migration | Compares new pack against previous delivered IDs | Reports kept, added, dropped IDs and exclusion reasons | `packages/memory-core/src/context-pack.ts:72-85` |
| Maintainer prompt | Not token clamped directly | Formatted XML tags for model ingestion | Model provided zero tools; output must be JSON array | `packages/memory-core/src/context.ts:7-35` |
| Shortening proposal | A note text and maximum token count | Removes repeated eligible sentences and excess spaces; output must use fewer tokens and fit the limit | Returns shortened text or `null` | `packages/memory-core/src/compress.ts:33-82` |

## Failure behavior

| Failure condition | Cause / Trigger | Consequence | Evidence |
|---|---|---|---|
| Required candidate overflow | Required candidates alone exceed role token budget | Throws `context_pack_oversized:<kind>:<id>` naming largest required item | `packages/memory-core/src/context-pack.ts:47-50` |
| Budget exceeded by optional note | Optional note causes `estimateTokens > budget` | Note is omitted; marked with `reason: "cut:over-budget"` | `packages/memory-core/src/context-pack.ts:56` |
| Stale candidate detected | `candidate.stale === true` (named files drifted) | Excluded from delivery; marked with `reason: "stale:needs_review"` | `packages/memory-core/src/context-pack.ts:35` |
| Relevance floor drop | Candidate ID listed in `floorDropIds` | Excluded from delivery; marked with `reason: "floor:low-relevance"` | `packages/memory-core/src/context-pack.ts:36` |
| Scope mismatch | Candidate section scope does not match reader chain | Excluded from delivery; marked with `reason: "scope:not-deliverable"` | `packages/memory-core/src/context-pack.ts:43` |
| No useful shortening | Text is unchanged, is not shorter, or remains above the token ceiling | `proposeShorter` returns `null` | `packages/memory-core/src/compress.ts:77-82` |

## Business rules

- Mandatory policies protected: required candidates (`required = true`) are never silently truncated; if they do not fit the role budget, context creation throws an error (`packages/memory-core/src/context-pack.ts:47-50`).
- Token estimation formula: estimated token usage equals UTF-8 byte length divided by 4, rounded up (`packages/memory-core/src/candidates.ts:49`, `packages/memory-core/src/context-pack.ts:69`).
- Usefulness weighting: in `memoryContext`, record score is multiplied by `(0.5 + memoryUsefulness(record) + verificationBonus)`, where verification bonus adds up to 0.3 for corroborations from multiple sources (`packages/memory-core/src/context.ts:58`).
- Header inclusion in token accounting: the formatted prefix `- [<kind>; concepts=<list>]` is included in the estimated token length before budget checks, preventing concept lists from overflowing prompt allocations (`packages/memory-core/src/context.ts:61-62`, `packages/memory-core/src/context.ts:84-86`).
- Maintainer boundaries: the memory maintainer prompt explicitly warns that passwords, secrets, and assistant instructions cause the validator to reject the whole array (`packages/memory-core/src/context.ts:24`).

## Public API or commands

- `buildContextPack(input)`: builds a structured, role-capped context packet (`packages/memory-core/src/context-pack.ts:26-67`).
- `shadowPackCompare(oldDeliveredIds, oldBytes, pack)`: compares a new context pack against historical deliveries (`packages/memory-core/src/context-pack.ts:72-85`).
- `memoryCandidates(records, staleIds?)`: transforms `MemoryRecord` instances into `PackCandidate` structures (`packages/memory-core/src/context-pack.ts:88-92`).
- `roleContextBudget(role, configured)`: clamps configured budget to role hard limits (`packages/memory-core/src/context.ts:51-53`).
- `memoryContext(records, taskText, budget)`: formats and packs memory records into prompt text (`packages/memory-core/src/context.ts:55-64`).
- `explainMemory(records, taskText, budget)`: generates deliver/reject status explanations for candidate records (`packages/memory-core/src/context.ts:70-79`).
- `memoryMaintenanceBrief(input)`: constructs structured data for memory maintenance models (`packages/memory-core/src/context.ts:13-35`).
- `memoryMaintenancePrompt(input)`: returns rendered prompt text for memory maintenance (`packages/memory-core/src/context.ts:43-45`).
- `memoryMaintainerTools()`: returns empty tool array, enforcing zero-tool maintainer execution (`packages/memory-core/src/context.ts:7-9`).
- `shortenText(content)`: reduces eligible spacing and repeated sentences while leaving structural lines and fenced blocks intact (`packages/memory-core/src/compress.ts:33-76`).
- `proposeShorter(row, maxTokens)`: returns a shorter note text only when it saves tokens and fits the supplied ceiling (`packages/memory-core/src/compress.ts:77-82`).

## Gotchas

- A required rule that is slightly too long for a role's budget (for example, a 1,700-token rule sent to a writer with a 1,600-token budget) will immediately crash `buildContextPack` with `context_pack_oversized:rule:<id>` rather than pruning less important sentences (`packages/memory-core/src/context-pack.ts:47-50`).
- When no section chain is passed (`sectionChain: []`), only candidates present in `rootWhitelist` or marked with shared scope (`"project"`) can be packed; project-wide delivery is never assumed (`packages/memory-core/src/context-pack.ts:39-43`).
- In `memoryContext` (`packages/memory-core/src/context.ts:55-64`), core records are not forcibly injected; sessions requiring unconditional core conventions query `coreShelf` (`packages/memory-core/src/store.ts:246-252`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory lifecycle and file integration](lifecycle-and-files.md)
- [Memory core workspace overview](../overview.md)
