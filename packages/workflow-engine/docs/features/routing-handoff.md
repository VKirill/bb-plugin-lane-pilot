---
title: Workflow Routing and Handoff
type: component
created: 2026-10-10
updated: 2026-11-14
status: active
confidence: medium
tags: [workflow-engine, routing, handoff]
sources:
  - packages/workflow-engine/src/router.ts
  - packages/workflow-engine/src/run-stats.ts
  - packages/workflow-engine/src/handoff.ts
  - packages/workflow-engine/src/capabilities.ts
  - packages/workflow-engine/src/expr.ts
  - packages/workflow-engine/src/goals.ts
  - packages/workflow-engine/src/engine-start.ts
  - packages/workflow-engine/src/engine-step.ts
  - packages/workflow-engine/src/step-types.ts
  - packages/workflow-engine/src/preflight.ts
  - packages/workflow-engine/src/schema.ts
---
# Workflow Routing and Handoff
TL;DR: The router selects or asks about a workflow from the eligible catalog, while handoff helpers package inputs and run goals for a downstream workflow or agent.

## Purpose

Routing scores eligible workflow cards against a request, filters candidates against known machine and project state, optionally asks a model to choose among those candidates, and returns a decision with evidence, candidate summaries (`purpose` and `needs`), missing inputs, questions, and goals (`packages/workflow-engine/src/router.ts:386-413`, `packages/workflow-engine/src/router.ts:523-630`). Handoff helpers render bounded packets and references for passing context to a later stage (`packages/workflow-engine/src/handoff.ts:62-154`).

## How it works

1. `routeIntent` trims the request, extracts signals, and handles a continuation request as run-state guidance instead of workflow selection (`packages/workflow-engine/src/router.ts:523-533`).
2. It indexes only offered workflows using bilingual names, tags, descriptions, and examples; it scores text and example similarity, applies rule boosts and `not_for` penalties, and adds run-history ordering where records exist (`packages/workflow-engine/src/router.ts:523-574`).
3. It excludes workflows whose required plugins, skills, secrets, machines, or project properties are known to be unavailable, then slices the top `TOP_N` (`10`) candidates for the configured router model (`packages/workflow-engine/src/router.ts:15`, `packages/workflow-engine/src/router.ts:546-574`).
4. A model response is bounded and checked against the candidate list; model failure or an off-list choice falls back to `deterministicRouterModel` (`packages/workflow-engine/src/router.ts:580-591`).
5. The decision builder returns a route or clarification result with confidence, candidate list (including each candidate's `purpose` and `needs`), evidence, questions, boundary contract, goals, inferred inputs, warnings, and live-trial state (`packages/workflow-engine/src/router.ts:386-413`, `packages/workflow-engine/src/router.ts:592-630`).
6. Callers can run `checkRequires` for detailed preflight against installed skills/plugins/MCP servers, secrets, tools, and platform sessions. Missing requirements produce refusal text and secret requests; unavailable checks are reported as unverified (`packages/workflow-engine/src/preflight.ts:73-127`, `packages/workflow-engine/src/preflight.ts:73`).
7. `planPacket` converts large or structured input into inline content or references according to packet constraints (`packages/workflow-engine/src/handoff.ts:97-154`).

## Modes and states

| Mode | Condition | Result |
|---|---|---|
| Eligible | Workflow is `published` or `tested`, not internal, and has no `startedBy` value | Workflow is indexed as a candidate (`packages/workflow-engine/src/router.ts:300`, `packages/workflow-engine/src/schema.ts:271-273`). |
| Live trial | Workflow status is `tested` | Candidate carries a live-trial requirement (`packages/workflow-engine/src/router.ts:300-301`). |
| Long request without direct backing | Request has more than 80 words and the selected workflow has no matching rule or its base text-fit score is below 0.12 | The selection is returned as a suggestion with confidence capped below the route threshold; a warning explains that the brief is not backed by both signals (`packages/workflow-engine/src/router.ts:21-22`, `packages/workflow-engine/src/router.ts:611-620`). |
| Clarify | No candidates, broad request, low confidence, missing required inputs, or model abstention | Route decision includes questions and/or missing inputs; the precise branches are set in decision assembly (`packages/workflow-engine/src/router.ts:523-630`). |
| Preflight missing | A required capability is confirmed absent | `ok` is false; issues describe the missing item, and required missing secrets add an `envRequests` entry (`packages/workflow-engine/src/preflight.ts:92-103`, `packages/workflow-engine/src/preflight.ts:127-134`). |
| Preflight unverified | A port cannot be read or a check is unsupported | Issue level is `unverified`; this alone does not make `ok` false (`packages/workflow-engine/src/preflight.ts:79-90`, `packages/workflow-engine/src/preflight.ts:116-127`). |
| Handoff inline/reference | Payload fits the inline limits or exceeds them / is referenced | Packet plan contains text, refs, or both (`packages/workflow-engine/src/handoff.ts:16-61`, `packages/workflow-engine/src/handoff.ts:128-154`). |

## Business rules

- Only published or tested, non-internal workflows without `startedBy` are offered; `startedBy` identifies a starter graph initiated by Lane Pilot and excludes it from PM/router choices (`packages/workflow-engine/src/router.ts:300`, `packages/workflow-engine/src/router.ts:303`, `packages/workflow-engine/src/schema.ts:271-273`). A tested workflow is marked as needing an owner-authorized live trial (`packages/workflow-engine/src/router.ts:300-301`).
- State filtering treats a secret as optional when its requirement text signals optionality; machine checks apply to `host_...` machine identifiers (`packages/workflow-engine/src/router.ts:344-357`).
- The default router model is deterministic; an injected model can only choose from candidate cards, and an invalid choice or failure falls back to `deterministicRouterModel` (`packages/workflow-engine/src/router.ts:380`, `packages/workflow-engine/src/router.ts:580-591`).
- Requests to map/reverse-engineer a website service API are classified as `api-recon` when both API-mapping language and a site/service/account signal are present. That rule suppresses the security-audit rule for the same request; the reference role is read-only and uses browser-automation and Env Catalog (`packages/workflow-engine/src/router.ts:232-234`, `packages/workflow-engine/src/capabilities.ts:100-111`).
- Requests over 80 words route only when the selected workflow has at least one matching rule and its base text-fit score is at least 0.12; otherwise it remains a suggestion and the router asks for clarification (`packages/workflow-engine/src/router.ts:21-22`, `packages/workflow-engine/src/router.ts:611-620`).
- Goal IDs start with a letter, allow letters/digits/underscore/hyphen, and are at most 40 characters; `done_when` and `evidence` are trimmed strings of 3–600 characters (`packages/workflow-engine/src/goals.ts:9-15`).
- Run goals are limited by `MAX_GOALS`; goals can be re-grounded on a due interval determined by `regroundDue` (`packages/workflow-engine/src/goals.ts:17`, `packages/workflow-engine/src/goals.ts:55`).
- The run-history tiebreaker counts business outcomes, not engine statuses: `RunRecord` treats `workDone` as completed work, while `refused` counts as not completed and `escalated` moves neither side (`packages/workflow-engine/src/router.ts:507`). `runRecords` builds each record from the shared outcome tally over the run journal (`packages/workflow-engine/src/run-stats.ts:6-14`; the outcome classes in the [run journal data model](../data-model/run-journal.md)).

## Public API

| Import | Purpose |
|---|---|
| `routeIntent`, `RouterModel`, `RouteDecision`, `isOffered`, `isPipeline`, `stateProblem` | Select and explain a workflow route; `isPipeline` identifies workflows with `startedBy` (`packages/workflow-engine/src/router.ts:300`, `packages/workflow-engine/src/router.ts:303`, `packages/workflow-engine/src/router.ts:386-413`, `packages/workflow-engine/src/router.ts:523-630`). |
| `checkRequires`, `effectiveRequires`, `preflightRefusal` | Check declared requirements against host ports (`packages/workflow-engine/src/preflight.ts:63-72`, `packages/workflow-engine/src/preflight.ts:73-134`). |
| `planPacket`, `startPacket`, `INLINE_CHARS`, `PACKET_BYTES` | Build bounded handoff packets (`packages/workflow-engine/src/handoff.ts:97-154`). |
| `collectCapabilities`, `WORKFLOW_REFERENCE` | Build workflow capability reference text for model prompts (`packages/workflow-engine/src/capabilities.ts:70-178`). |
| `goalSchema`, `parseGoals`, `regroundDue`, `goalsBlock` | Parse, render, and time run goals (`packages/workflow-engine/src/goals.ts:9-15`, `packages/workflow-engine/src/goals.ts:23`). |

## Package shape

`router.ts` owns candidate ranking and decisions; `preflight.ts` checks host requirements; `handoff.ts` creates handoff packets; `goals.ts` carries goal contracts; `capabilities.ts` builds model-facing capability references (`packages/workflow-engine/src/router.ts:1-16`, `packages/workflow-engine/src/preflight.ts:1-8`, `packages/workflow-engine/src/handoff.ts:1-15`).

## Internal model

The router takes ports and data as input instead of querying the host directly. `RouterState` answers whether named capabilities are available, while `RouterModel` receives a bounded candidate list. This keeps catalog selection separate from machine integrations (`packages/workflow-engine/src/router.ts:1-72`, `packages/workflow-engine/src/router.ts:344`).

`stem` keeps digit-only tokens intact, trims one matching suffix from Cyrillic words only when at least three characters remain, then limits them to six characters. For Latin tokens it removes selected `es`, plural `s`, or `-ations`/`-ation`/`-ings`/`-ing`/`-ers`/`-er`/`-ed`/`-ly` endings while retaining at least three characters before the suffix (`packages/workflow-engine/src/router.ts:91-100`).

Run goals are structured as `id`, `done_when`, `evidence`, with optional inferred `guess`; the engine stores them with the run and exposes them in step context (`packages/workflow-engine/src/goals.ts:4-15`, `packages/workflow-engine/src/engine-start.ts:69-75`, `packages/workflow-engine/src/engine-step.ts:29-46`, `packages/workflow-engine/src/step-types.ts:34`).

## Dependencies

Routing depends on workflow definitions, capability metadata, run statistics, and injected host state/model ports. Preflight likewise accepts host callbacks rather than importing the host integrations (`packages/workflow-engine/src/router.ts:1-12`, `packages/workflow-engine/src/preflight.ts:1-33`).

## Gotchas

- A catalog item that is `tested` is offered with a live-trial marker; the router’s `isOffered` predicate alone does not mean it has completed a successful live run (`packages/workflow-engine/src/router.ts:300-301`).
- An unverified requirement does not fail preflight; only issues marked `missing` set `ok` false (`packages/workflow-engine/src/preflight.ts:127`).

## Deterministic router and capability reference

### `stateProblem`

`stateProblem` returns `null` when no `RouterState` is supplied. Otherwise it checks requirements in this order and returns the first known failure (`packages/workflow-engine/src/router.ts:344-357`):

1. Normalize each plugin identifier with `pluginId`; exclude on a known `false`. Then check skills by name, also excluding only known `false` (`packages/workflow-engine/src/router.ts:344-350`).
2. For each secret, extract its leading uppercase name. Parenthetical, `optional`, or supported Russian optionality text makes it optional; otherwise a known missing secret excludes the workflow (`packages/workflow-engine/src/router.ts:348-352`).
3. Check only machine identifiers matching `host_<lowercase letters or digits>`; prose machine requirements are not queried. Then check `requires.project` entries whose value is `true`, excluding when the named project fact is known false (`packages/workflow-engine/src/router.ts:352-356`).
4. Return `null` if no check finds an unavailable requirement. `undefined` state answers are not treated as unavailable; requirements outside these checks do not affect this function's result (`packages/workflow-engine/src/router.ts:344-357`).

| State result | Router behavior |
|---|---|
| First checked requirement is known absent | Return its explanatory string immediately; the caller removes that workflow from available candidates and records the reason (`packages/workflow-engine/src/router.ts:344-357`, `packages/workflow-engine/src/router.ts:546-556`). |
| Requirement checks are absent or return unknown | Continue checking; unknown does not exclude a workflow (`packages/workflow-engine/src/router.ts:344-357`). |
| Every supported check passes | Return `null` (`packages/workflow-engine/src/router.ts:344-357`). |

### `scorerOutput` and `deterministicRouterModel`

`scorerOutput` reads the already-ranked candidate list. With no first candidate or a first score at or below zero, it abstains with `choice: null`, confidence zero, a no-match pattern, no rejections, and no questions. Otherwise it chooses the first candidate, computes confidence from its score, its margin over the second candidate, and its rule-hit count, records the top score/rule pattern, and marks every remaining candidate rejected because it scored lower (`packages/workflow-engine/src/router.ts:369-379`).

`deterministicRouterModel` is an async-compatible adapter that returns `scorerOutput` directly; it does not call a provider, add questions, or catch invalid runtime input (`packages/workflow-engine/src/router.ts:380`). `routeIntent` uses it when no external model output survives, including model failure and off-list selection. The outer route can still return `clarify` when confidence, query breadth, match score, hidden-best checks, or the long-brief rule-and-text-fit check fail (`packages/workflow-engine/src/router.ts:523-620`).

### `WORKFLOW_REFERENCE`

This exported constant is model/authoring reference data, not a runtime validator. Its `nodeTypes` entries describe each node kind; `passModes`, `qualityModes`, `conditions`, and `fieldTypes` enumerate graph syntax; the strings under `guards`, `edges`, `skipping`, `workflowQualityMode`, and `requires` summarize their constraints. Nested sections document roles (including `errand` on the Mac mini through `computer-use: agent-desktop` and `specialist:growth-marketer`), model selection, action names, triggers, and example formats (`packages/workflow-engine/src/capabilities.ts:70-129`, `packages/workflow-engine/src/capabilities.ts:100-111`, `packages/workflow-engine/src/capabilities.ts:145-158`).

The `models` capability section is separate from that static reference: `modelsSection` returns the selected provider, model, reasoning effort, source, and role rationale for each role, plus whether the selected model is offered on the run host. `collectCapabilities` returns it as unavailable when no model catalog is available (`packages/workflow-engine/src/capabilities.ts:37-55`, `packages/workflow-engine/src/capabilities.ts:131-178`, `packages/workflow-engine/src/capabilities.ts:159-166`).

The action reference lists pure code actions, plugin state/checkout actions, specialist state and gate actions (`sp.*`, `passport.*`), deferred scheduling, and errand-helper actions. The plugin state/checkout list includes `lp.review_prepass`, `lp.requirement_coverage`, `lp.milestone_archive`, and `lp.retro_living`; it describes the prepass as checks before the model, coverage as uncovered `REQUIREMENTS.md` ids, milestone archives as roadmap/requirements snapshots, and retro updates as INS-id upserts. It also describes `lp.integration_gate_status` as requiring a green full-gate mark for the shipped head within six hours (`packages/workflow-engine/src/capabilities.ts:117-124`). `schedule.create` describes a single deferred workflow run, its `send_at` input and workflow/name options, and `scheduled` or `cannot_delay` outcomes (`packages/workflow-engine/src/capabilities.ts:120`).

`modelsSection` builds a host-ID-to-name map, trims/lowercases the optional query, and filters roles by role ID substring. For each remaining role it calls `resolveRoleModel`, finds that provider/model in the supplied catalog, and returns the chosen pair, effort, source, default rationale, host availability, and matching machine names when catalog host IDs exist (`packages/workflow-engine/src/capabilities.ts:37-55`). It returns `status: "ready"`, all catalog machines' names/connectivity, the roles map, and an instruction note (`packages/workflow-engine/src/capabilities.ts:37-55`). The function does not catch catalog or resolver exceptions; `collectCapabilities` catches failures while loading the models port, but calls `modelsSection` inside that `try` (`packages/workflow-engine/src/capabilities.ts:131-178`, `packages/workflow-engine/src/capabilities.ts:159-166`).

| Model lookup branch | Output |
|---|---|
| Query absent or role ID contains the normalized query | Role appears with chosen model metadata (`packages/workflow-engine/src/capabilities.ts:37-55`). |
| Query excludes role ID | Role is omitted; provider/model names are not searched (`packages/workflow-engine/src/capabilities.ts:37-55`). |
| Chosen model has catalog host IDs | `machines` contains host names or raw IDs; `offered` combines that presence with the run-host offer check (`packages/workflow-engine/src/capabilities.ts:37-55`). |
| Model record has no host IDs or the run host explicitly does not offer it | `offered` is false and `machines` is omitted when there are no catalog host IDs (`packages/workflow-engine/src/capabilities.ts:37-55`). |

`WORKFLOW_REFERENCE` has no branch or error result; it is returned as authored data. Validation remains in `schema.ts`/`validate.ts`, and host capability checks are performed by `checkRequires` (`packages/workflow-engine/src/capabilities.ts:70-129`, `packages/workflow-engine/src/preflight.ts:73-127`). Consumers should not treat descriptive prose in this value as a substitute for those validators.

### `collectCapabilities`

1. Normalize the optional query to lowercase and define section selection: an absent or empty `sections` list includes every section; a nonempty list includes only named sections (`packages/workflow-engine/src/capabilities.ts:131-136`).
2. For skills, plugins, MCP servers, secrets, and hosts, call the section reader, apply its section-specific text filter, then cap returned items at 120. Skills expose descriptions clipped to 160 characters; secrets expose names and kinds only, never values (`packages/workflow-engine/src/capabilities.ts:10-25`, `packages/workflow-engine/src/capabilities.ts:57-67`, `packages/workflow-engine/src/capabilities.ts:137-144`).
3. The browser section returns the browser host setting and usage instructions. It separately queries plugin IDs and skill names; query failures become `null` for those availability fields rather than rejecting the entire result (`packages/workflow-engine/src/capabilities.ts:145-158`).
4. The models section calls the model port and returns unavailable when it gives no catalog or no providers; thrown read errors become `{status:"error"}`. Otherwise it delegates to `modelsSection` (`packages/workflow-engine/src/capabilities.ts:159-166`).
5. Specialists may be an array or async reader. The result contains role IDs and instructions; a thrown read returns an error object. The `reference` section returns `WORKFLOW_REFERENCE` directly (`packages/workflow-engine/src/capabilities.ts:70-129`, `packages/workflow-engine/src/capabilities.ts:167-176`).

| Capability branch | Success | Unavailable or failure |
|---|---|---|
| Generic port section | `status:"ready"`, filtered items, and `total` only when more than 120 matched (`packages/workflow-engine/src/capabilities.ts:57-67`). | Missing reader or null result gives `status:"unavailable"`; thrown reader gives `status:"error"` and a string error (`packages/workflow-engine/src/capabilities.ts:57-67`). |
| Browser | Host ID, instructions, and booleans when plugin/skill reads succeed (`packages/workflow-engine/src/capabilities.ts:145-158`). | Failed plugin or skill read is converted to `null`; the browser object still returns (`packages/workflow-engine/src/capabilities.ts:145-158`). |
| Models | Ready role table when a provider catalog is present (`packages/workflow-engine/src/capabilities.ts:37-55`, `packages/workflow-engine/src/capabilities.ts:159-166`). | No port, null result, or empty provider list gives unavailable; thrown read gives error (`packages/workflow-engine/src/capabilities.ts:159-166`). |
| Specialists | Returns the supplied or read role IDs (`packages/workflow-engine/src/capabilities.ts:167-175`). | Thrown async reader gives `{status:"error"}` (`packages/workflow-engine/src/capabilities.ts:167-175`). |
| Reference | Returns static `WORKFLOW_REFERENCE` (`packages/workflow-engine/src/capabilities.ts:70-129`, `packages/workflow-engine/src/capabilities.ts:176`). | No separate catch or status wrapper is applied (`packages/workflow-engine/src/capabilities.ts:70-129`, `packages/workflow-engine/src/capabilities.ts:176`). |

### `planPacket`

The planner defaults to references enabled and a 3,072-byte packet budget. It references every input whose rendered text exceeds 400 characters, using a deterministic path derived from chat ID, truncated run ID, sanitized input name, and an eight-character content hash (`packages/workflow-engine/src/handoff.ts:12-32`, `packages/workflow-engine/src/handoff.ts:128-134`).

If that packet still exceeds budget at the no-example level, it sorts remaining inputs largest-first and changes them to references until the rendered packet fits or the next value is 60 characters or shorter. If it still cannot fit, it bundles all inputs except a short goal input into one `inputs` reference, clears individual references, and returns that bundle's file content. It always returns packet text, reference metadata, and file payloads together; it performs no file I/O (`packages/workflow-engine/src/handoff.ts:135-153`).

With `byReference: false`, it skips reference creation and hands all input values to `startPacket`, which progressively removes examples, clips values/summaries/goals, and finally keeps the initial lines that fit before `[more cut]` if the packet remains oversized (`packages/workflow-engine/src/handoff.ts:92-112`, `packages/workflow-engine/src/handoff.ts:128-153`). Serialization errors from `textOf`/JSON encoding propagate; packet planning has no catch (`packages/workflow-engine/src/handoff.ts:19-20`, `packages/workflow-engine/src/handoff.ts:128-153`).

The planner's branch sequence is:

1. Use the caller's budget or `PACKET_BYTES` and start with an empty reference map. With references enabled, turn every input whose rendered text exceeds `INLINE_CHARS` into an `InputRef` (`packages/workflow-engine/src/handoff.ts:128-134`).
2. Render without examples and compare UTF-8 byte length to the budget. If oversized, sort remaining inline inputs largest-first; convert each input longer than 60 characters to a reference until it fits or the next value is at most 60 characters (`packages/workflow-engine/src/handoff.ts:134-140`).
3. If still oversized, keep only a short goal input inline and bundle every other input into one `inputs` object reference. Delete the individual references and replace them with the bundle reference (`packages/workflow-engine/src/handoff.ts:142-150`).
4. Build `files` from the final reference map by pairing each path with the original input's rendered text, then render `packet` with `startPacket`. Return packet, file payloads, and refs together; writing those files is the caller's responsibility (`packages/workflow-engine/src/handoff.ts:151-153`).

| Mode or outcome | Behavior |
|---|---|
| `byReference: true` (default) | Big values become individual references first; budget pressure can cause more references or a single bundled file (`packages/workflow-engine/src/handoff.ts:128-150`). |
| `byReference: false` | No files or refs are created; `startPacket` uses its clipping levels and may finish with `[more cut]` (`packages/workflow-engine/src/handoff.ts:97-112`, `packages/workflow-engine/src/handoff.ts:128-153`). |
| Rendered packet fits budget at a level | Return that level's text; later, more aggressive clipping levels are not used (`packages/workflow-engine/src/handoff.ts:97-112`). |
| Even the final clipped level exceeds budget | Keep initial lines only while they fit, add `[more cut]`, and preserve the closing line (`packages/workflow-engine/src/handoff.ts:103-112`). |
| Value serialization fails | JSON serialization errors propagate from `textOf`/`render`; no packet plan is returned (`packages/workflow-engine/src/handoff.ts:19-20`, `packages/workflow-engine/src/handoff.ts:62-90`, `packages/workflow-engine/src/handoff.ts:128-153`). |

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
