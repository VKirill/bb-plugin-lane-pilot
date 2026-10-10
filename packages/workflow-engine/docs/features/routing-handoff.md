---
title: Workflow Routing and Handoff
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [workflow-engine, routing, handoff]
sources:
  - packages/workflow-engine/src/router.ts
  - packages/workflow-engine/src/handoff.ts
  - packages/workflow-engine/src/capabilities.ts
  - packages/workflow-engine/src/goals.ts
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/preflight.ts
---
# Workflow Routing and Handoff
TL;DR: The router selects or asks about a workflow from the eligible catalog, while handoff helpers package inputs and run goals for a downstream workflow or agent.

## Purpose

Routing scores eligible workflow cards against a request, filters candidates against known machine and project state, optionally asks a model to choose among those candidates, and returns a decision with evidence, missing inputs, questions, and goals (`packages/workflow-engine/src/router.ts:498-565`). Handoff helpers render bounded packets and references for passing context to a later stage (`packages/workflow-engine/src/handoff.ts:62-154`).

## How it works

1. `routeIntent` trims the request, extracts signals, and handles a continuation request as run-state guidance instead of workflow selection (`packages/workflow-engine/src/router.ts:498-510`).
2. It indexes only offered workflows using bilingual names, tags, descriptions, and examples; it scores text and example similarity, applies rule boosts and `not_for` penalties, and adds run-history ordering where records exist (`packages/workflow-engine/src/router.ts:275-299`, `packages/workflow-engine/src/router.ts:302-317`, `packages/workflow-engine/src/router.ts:522-540`).
3. It excludes workflows whose required plugins, skills, secrets, machines, or project properties are known to be unavailable, then gives the best candidates to the configured router model (`packages/workflow-engine/src/router.ts:322-335`, `packages/workflow-engine/src/router.ts:543-560`).
4. A model response is bounded and checked against the candidate list; model failure or an off-list choice falls back to the deterministic scorer (`packages/workflow-engine/src/router.ts:555-563`).
5. The decision builder returns a route or clarification result with confidence, evidence, questions, boundary contract, goals, inferred inputs, warnings, and live-trial state (`packages/workflow-engine/src/router.ts:362-384`, `packages/workflow-engine/src/router.ts:565-601`).
6. Callers can run `checkRequires` for detailed preflight against installed skills/plugins/MCP servers, secrets, tools, and platform sessions. Missing requirements produce refusal text and secret requests; unavailable checks are reported as unverified (`packages/workflow-engine/src/preflight.ts:73-127`, `packages/workflow-engine/src/preflight.ts:130-134`).
7. `planPacket` converts large or structured input into inline content or references according to packet constraints (`packages/workflow-engine/src/handoff.ts:97-154`).

## Modes and states

| Mode | Condition | Result |
|---|---|---|
| Eligible | Workflow is `published` or `tested`, not internal, and not reserved as a never-offered pipeline | Workflow is indexed as a candidate (`packages/workflow-engine/src/router.ts:275-282`). |
| Live trial | Workflow status is `tested` | Candidate carries a live-trial requirement (`packages/workflow-engine/src/router.ts:279-280`). |
| Clarify | No candidates, broad request, low confidence, missing required inputs, or model abstention | Route decision includes questions and/or missing inputs; the precise branches are set in decision assembly (`packages/workflow-engine/src/router.ts:498-513`, `packages/workflow-engine/src/router.ts:565-601`). |
| Preflight missing | A required capability is confirmed absent | `ok` is false; issues describe the missing item, and required missing secrets add an `envRequests` entry (`packages/workflow-engine/src/preflight.ts:92-103`, `packages/workflow-engine/src/preflight.ts:127-134`). |
| Preflight unverified | A port cannot be read or a check is unsupported | Issue level is `unverified`; this alone does not make `ok` false (`packages/workflow-engine/src/preflight.ts:79-90`, `packages/workflow-engine/src/preflight.ts:116-127`). |
| Handoff inline/reference | Payload fits the inline limits or exceeds them / is referenced | Packet plan contains text, refs, or both (`packages/workflow-engine/src/handoff.ts:16-61`, `packages/workflow-engine/src/handoff.ts:128-154`). |

## Business rules

- Only published or tested, non-internal workflows outside the never-offered set are offered; a tested workflow is marked as needing an owner-authorized live trial (`packages/workflow-engine/src/router.ts:275-282`).
- State filtering treats a secret as optional when its requirement text signals optionality; machine checks apply to `host_...` machine identifiers (`packages/workflow-engine/src/router.ts:322-334`).
- The default router model is deterministic; an injected model can only choose from candidate cards, and an invalid choice/failure falls back to scoring (`packages/workflow-engine/src/router.ts:346-358`, `packages/workflow-engine/src/router.ts:555-563`).
- Goal IDs start with a letter, allow letters/digits/underscore/hyphen, and are at most 40 characters; `done_when` and `evidence` are trimmed strings of 3–600 characters (`packages/workflow-engine/src/goals.ts:9-15`).
- Run goals are limited by `MAX_GOALS`; goals can be re-grounded on a due interval determined by `regroundDue` (`packages/workflow-engine/src/goals.ts:17`, `packages/workflow-engine/src/goals.ts:39-41`).

## Public API

| Import | Purpose |
|---|---|
| `routeIntent`, `RouterModel`, `RouteDecision`, `isOffered`, `stateProblem` | Select and explain a workflow route (`packages/workflow-engine/src/router.ts:279-282`, `packages/workflow-engine/src/router.ts:322-335`, `packages/workflow-engine/src/router.ts:498-557`). |
| `checkRequires`, `effectiveRequires`, `preflightRefusal` | Check declared requirements against host ports (`packages/workflow-engine/src/preflight.ts:63-72`, `packages/workflow-engine/src/preflight.ts:73-134`). |
| `planPacket`, `startPacket`, `INLINE_CHARS`, `PACKET_BYTES` | Build bounded handoff packets (`packages/workflow-engine/src/handoff.ts:97-154`). |
| `collectCapabilities`, `WORKFLOW_REFERENCE` | Build workflow capability reference text for model prompts (`packages/workflow-engine/src/capabilities.ts:82-179`). |
| `goalSchema`, `parseGoals`, `regroundDue`, `goalsBlock` | Parse, render, and time run goals (`packages/workflow-engine/src/goals.ts:9-15`, `packages/workflow-engine/src/goals.ts:39-49`). |

## Package shape

`router.ts` owns candidate ranking and decisions; `preflight.ts` checks host requirements; `handoff.ts` creates handoff packets; `goals.ts` carries goal contracts; `capabilities.ts` builds model-facing capability references (`packages/workflow-engine/src/router.ts:1-16`, `packages/workflow-engine/src/preflight.ts:1-8`, `packages/workflow-engine/src/handoff.ts:1-15`).

## Internal model

The router takes ports and data as input instead of querying the host directly. `RouterState` answers whether named capabilities are available, while `RouterModel` receives a bounded candidate list. This keeps catalog selection separate from machine integrations (`packages/workflow-engine/src/router.ts:1-70`, `packages/workflow-engine/src/router.ts:346-358`).

Run goals are structured as `id`, `done_when`, `evidence`, with optional inferred `guess`; the engine stores them with the run and exposes them in step context (`packages/workflow-engine/src/goals.ts:4-15`, `packages/workflow-engine/src/engine.ts:42-53`).

## Dependencies

Routing depends on workflow definitions, capability metadata, run statistics, and injected host state/model ports. Preflight likewise accepts host callbacks rather than importing the host integrations (`packages/workflow-engine/src/router.ts:1-12`, `packages/workflow-engine/src/preflight.ts:1-33`).

## Gotchas

- A catalog item that is `tested` is offered with a live-trial marker; the router’s `isOffered` predicate alone does not mean it has completed a successful live run (`packages/workflow-engine/src/router.ts:275-282`).
- An unverified requirement does not fail preflight; only issues marked `missing` set `ok` false (`packages/workflow-engine/src/preflight.ts:127`).

## Deterministic router and capability reference

### `scorerOutput` and `deterministicRouterModel`

`scorerOutput` reads the already-ranked candidate list. With no first candidate or a first score at or below zero, it abstains with `choice: null`, confidence zero, a no-match pattern, no rejections, and no questions. Otherwise it chooses the first candidate, computes confidence from its score, its margin over the second candidate, and its rule-hit count, records the top score/rule pattern, and marks every remaining candidate rejected because it scored lower (`packages/workflow-engine/src/router.ts:339-357`).

`deterministicRouterModel` is an async-compatible adapter that returns `scorerOutput` directly; it does not call a provider, add questions, or catch invalid runtime input (`packages/workflow-engine/src/router.ts:346-358`). `routeIntent` uses it when no external model output survives, including model failure and off-list selection. The outer route can still return `clarify` when confidence, query breadth, match score, or hidden-best checks fail (`packages/workflow-engine/src/router.ts:555-566`, `packages/workflow-engine/src/router.ts:583-600`).

### `WORKFLOW_REFERENCE`

This exported constant is model/authoring reference data, not a runtime validator. Its `nodeTypes` entries describe each node kind; `passModes`, `qualityModes`, `conditions`, and `fieldTypes` enumerate graph syntax; the strings under `guards`, `edges`, `skipping`, `workflowQualityMode`, and `requires` summarize their constraints. Nested sections document roles, model selection, action names, triggers, and example formats (`packages/workflow-engine/src/capabilities.ts:81-139`).

There is no branch or error result in the constant itself: it is returned as authored data. Validation remains in `schema.ts`/`validate.ts`, and host capability checks are performed by `checkRequires` (`packages/workflow-engine/src/capabilities.ts:81-139`, `packages/workflow-engine/src/preflight.ts:73-127`). Consumers should not treat descriptive prose in this value as a substitute for those validators.

### `planPacket`

The planner defaults to references enabled and a 3,072-byte packet budget. It references every input whose rendered text exceeds 400 characters, using a deterministic path derived from chat ID, truncated run ID, sanitized input name, and an eight-character content hash (`packages/workflow-engine/src/handoff.ts:12-32`, `packages/workflow-engine/src/handoff.ts:128-134`).

If that packet still exceeds budget at the no-example level, it sorts remaining inputs largest-first and changes them to references until the rendered packet fits or the next value is 60 characters or shorter. If it still cannot fit, it bundles all inputs except a short goal input into one `inputs` reference, clears individual references, and returns that bundle's file content. It always returns packet text, reference metadata, and file payloads together; it performs no file I/O (`packages/workflow-engine/src/handoff.ts:135-153`).

With `byReference: false`, it skips reference creation and hands all input values to `startPacket`, which progressively removes examples, clips values/summaries/goals, and finally cuts trailing lines with `[more cut]` if the packet remains oversized (`packages/workflow-engine/src/handoff.ts:92-112`, `packages/workflow-engine/src/handoff.ts:128-153`). Serialization errors from `textOf`/JSON encoding propagate; packet planning has no catch (`packages/workflow-engine/src/handoff.ts:19-20`, `packages/workflow-engine/src/handoff.ts:128-153`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
