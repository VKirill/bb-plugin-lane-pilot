---
schema_version: agency-artifact/1.0
artifact_id: art_f24024817eac44e78551261affecad57
artifact_type: specification
title: Jev adapter contract for BB reasoning selection
scope: project
project_id: proj_ejbam66722
department: development
task_ref:
  system: bb-task
  id: job_f657e605a08886020cddda3f
owner:
  kind: agent
  id: agt_e35e9235561a8262dfc9b75b
status: draft
version: 1
created_at: '2026-09-23T12:13:36+00:00'
updated_at: '2026-09-23T12:13:36+00:00'
access: internal
source_refs:
  - plugins/bb-plugin-lane-pilot/.bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack/plugins/lane-stack/fast-jev/src/request.ts
  - plugins/bb-plugin-lane-pilot/.bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack/plugins/lane-stack/hooks/jev-route-core.ts
  - plugins/bb-plugin-lane-pilot/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts
depends_on: []
review: null
---

# Jev adapter contract for BB reasoning selection

> [!IMPORTANT] This adapter is scoped to Lane Pilot BB writer dispatch. The ordinary CLI routing hooks remain unchanged.

## Verified source contracts

| Contract | Source location | Verified shape |
|---|---|---|
| Jev transport | pinned Lane Stack v1.38.0 `plugins/lane-stack/fast-jev/src/request.ts:3-53` | `POST https://api.typesafe.ai/v1/systemone`; body `{ model: "jev-latest", state, questions }`; bearer authorization; response must contain `answers`. |
| Jev state type | pinned Lane Stack `plugins/lane-stack/fast-jev/src/types.ts:165-166` | `JevState` is a string or JSON object. |
| Existing effort classifier question | pinned Lane Stack `plugins/lane-stack/hooks/jev-route-core.ts:22-43` | One separate `effort` choice question: low, medium, high, xhigh. The BB adapter uses this question shape without the tier/risk questions that could change the selected model. |
| BB model catalog | SDK `0.4.104`, `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:18468-18476`, `9659-9697` | `providers.models({ providerId, hostId })` returns models with `id`, `model`, and `supportedReasoningEfforts[].reasoningEffort`. |
| BB spawn | SDK `0.4.104`, `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:19097-19107`, `CreateThreadRequest` schema near `provider-bridge.js:2800` | `threads.spawn` receives selected `providerId`, `model`, optional `reasoningLevel`, and `executionInputSources.reasoningLevel`. Accepted reasoning enum includes `medium`, `high`, and `xhigh`. |

## Lane Pilot adapter

`lane_pilot_dispatch_writer` has a required `plan` string, separate from the unchanged task-v2 object. The PM tool instructions require that `plan` be the complete canonical plan, without writer/system wrapper content. The plan is stored separately for retry/recovery and passed to the host classifier as the exact string `state: { task: plan }`. Fixed classifier questions are sent in the separate `questions` property. There is no local slicing, summarizing, compression, or artificial length threshold.

The host adapter uses the existing Lane Stack Jev API and model `jev-latest`. It reads the existing `TYPESAFE_API_KEY` / `JEV_API_KEY` process variables or `~/secrets/typesafe.env`; neither the credential nor API response body is written to logs. Missing credentials, timeout, HTTP failure, and invalid answers return explicit statuses. A rejection/timeout at the BB-to-host RPC boundary is also converted to an explicit error status and uses the configured manual effort fallback; it does not abort the writer attempt. For an attempted API request, the host JSON-serializes then decodes the outgoing state and checks that the SHA-256 digest and UTF-8 byte length match the original plan before sending; the PM rechecks both digests and lengths across the host boundary. When no request was made, sent-plan fields stay null.

Before dispatch, Lane Pilot asks BB for the selected provider's live model catalog on the selected host. A Jev effort is used only when that exact model advertises it. Otherwise the configured `writer.reasoning_effort` is passed as the explicit fallback with a reason. If the catalog itself is unavailable, the selected manual level is kept unchanged and the trace records `selected_model_catalog_unavailable`; Lane Pilot does not choose a lower level. The actual `threads.spawn` payload names the configured provider/model unchanged, sets `reasoningLevel`, and marks its provenance `explicit`.

The attempt trace contains plan hash/byte lengths, Jev status/decision, requested/effective levels, fallback reason, provider/model, run/attempt/thread IDs. It does not store the plan text or private instructions. The wait receipt exposes that trace.

## Existing hook boundary and limitation

Pinned upstream files establish the separate CLI behavior: OpenCode `profiles/opencode/opencode-lane/index.ts:72-85` saves a `.slice(0, 1500)` prompt and `:118-143` may apply its route result to `reasoningEffort`; Claude `plugins/lane-stack/hooks/jev-router.ts:10-20, 67-73, 101-119` trims user text to 1500 characters and applies its own `turn.step` route. These hooks run in their ordinary CLI plugin processes. Lane Pilot does not patch them, change workspace-wide flags, or modify provider code.

The BB `threads.spawn` contract exposes no per-thread environment override for `LANE_JEV_EFFORT`. Therefore this plugin adapter cannot suppress an already enabled OpenCode/Claude CLI hook on a spawned native writer thread without changing shared CLI behavior or upstream code, both outside this task's allowed files. The chosen provider/model path must be checked against the resulting live `client/turn/requested` and `execution.reasoningLevel`; a trace mismatch is a failed live gate, not a successful fallback. The current implementation is scoped to BB writer dispatch and does not alter ordinary CLI operation.
