---
title: Workflow Lowering
type: component
created: 2026-10-30
updated: 2026-10-30
status: active
confidence: medium
tags: [workflow-engine, lowering, execution]
sources:
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/engine.ts
---
# Workflow Lowering
TL;DR: `lowerWorkflow` rewrites authoring syntax into the flat graph the engine runs — explicit `start` edges, `emit` nodes with an edge into the exit, and an all-in-one `parallel` split into fan-out, body, and join — as a pure, idempotent pass.

## Purpose

Validation and the engine both work on the lowered form, so what is checked is what runs (`packages/workflow-engine/src/lower.ts:4-10`). The host calls `lowerWorkflow` when a run is started, and the lowered definition is what the run row stores (`packages/workflow-engine/src/engine.ts:292`, `packages/workflow-engine/src/engine.ts:296-299`).

## How it works

`lowerWorkflow` walks the nodes once and rewrites three shapes, passing every other node through unchanged (`packages/workflow-engine/src/lower.ts:57-93`):

1. A `parallel` with `child` becomes three nodes (`packages/workflow-engine/src/lower.ts:58-76`): the fan-out `<id>:fan` (it keeps `for_each` and the routing role, with no output fields of its own), the body `<id>:child`, and the join, which keeps the original id so `<id>.field` still reads the joined result and carries the join's `policy`/`uses`/`out` plus the parallel's `produces`, `gates`, title, and skip fields (`packages/workflow-engine/src/lower.ts:61-67`). Two edges are added: fan → body, and body → join with the body's declared fields mapped as `with` (`packages/workflow-engine/src/lower.ts:70-75`).
2. An `emit` action stays one node but gains `uses: builtin:emit` (unless it names its own) and an output-field list computed from the workflow's declared outputs: a mapped key that names a declared output keeps its type, an unknown key becomes an optional `json` field (`packages/workflow-engine/src/lower.ts:78-82`). An edge into `end` is added that maps the declared keys as `{{emit-node.field}}` values (`packages/workflow-engine/src/lower.ts:83-84`).
3. A `subworkflow` with no declared `out` inherits the child's outputs when the resolver finds the child; an unresolved child stays as written (`packages/workflow-engine/src/lower.ts:87-91`).

Then the edge list is rebuilt (`packages/workflow-engine/src/lower.ts:95-100`): every edge into a rewritten parallel is retargeted to its fan node, the extra fan/body/join and emit edges are appended unless an identical edge already exists, an explicit `entry` becomes a `start` edge (prepended when no start edge exists, retargeted if the entry was a parallel), and the `entry` key is dropped from the returned copy.

## Modes and branches

| Input | Condition | Outcome |
|---|---|---|
| `parallel` with `child` | always | fan + body + join; the join keeps the original id and the fan/body get suffixed ids (`packages/workflow-engine/src/lower.ts:11-12`, `packages/workflow-engine/src/lower.ts:58-69`). |
| `action` with `action: "emit"` | always | emit node with computed outputs and an edge to the exit (`packages/workflow-engine/src/lower.ts:78-85`). |
| `subworkflow`, `out` empty | resolver finds the child | node gains the child's outputs (`packages/workflow-engine/src/lower.ts:87-90`). |
| `subworkflow`, `out` empty | resolver returns null | node unchanged; its fields later read as `unknown` to contract checks (`packages/workflow-engine/src/lower.ts:89`, `packages/workflow-engine/src/lower.ts:29-32`). |
| any other node | — | passes through unchanged (`packages/workflow-engine/src/lower.ts:92`). |

## Outcomes and failures

- The pass is pure and idempotent: lowering a lowered workflow changes nothing (`packages/workflow-engine/src/lower.ts:8-10`).
- A resolver that throws propagates out of `lowerWorkflow`; the engine's start path turns it into a failed preflight or start (`packages/workflow-engine/src/lower.ts:88`, `packages/workflow-engine/src/engine.ts:275-277`).
- An emit whose `map` is not an object is lowered with an empty mapping, so the node has no outputs beyond the defaults (`packages/workflow-engine/src/lower.ts:79`).
- After lowering, the engine compiles the stored definition per run and caches it; invalid JSON or expressions throw there, uncaught (`packages/workflow-engine/src/engine.ts:236-240`).

## Public API

| Export | Purpose |
|---|---|
| `lowerWorkflow(workflow, resolve?)` | Lower one workflow (`packages/workflow-engine/src/lower.ts:52-101`). |
| `ResolveWorkflow` | The child-resolution callback type (`packages/workflow-engine/src/lower.ts:17`). |
| `outputFields(workflow, node, resolve?)` | The fields a condition or reference may read; agents always carry `handoff`, a decision borrows its source node's fields, a childless-out subworkflow borrows the child's or reads `unknown` (`packages/workflow-engine/src/lower.ts:20-34`). |
| `executorKey(node)` | The executor key a lowered node needs; null when it has neither `uses` nor a builtin (`packages/workflow-engine/src/lower.ts:37-48`). |
| `fanId`, `childId`, `EMIT` | The suffixed ids of the split parallel and the emit marker (`packages/workflow-engine/src/lower.ts:11-13`). |

## Gotchas

- The join keeps the parallel's id, but the fan-out and body are new nodes: `maxVisits`, `skip_when`, and similar per-node fields stay on the node they were written on, and the fan/body split is invisible only as long as nothing references `<id>:fan` directly (`packages/workflow-engine/src/lower.ts:61-67`).
- A subworkflow whose child cannot be resolved keeps no output fields, so every reference into it reads `unknown` and contract checks on its output are skipped (`packages/workflow-engine/src/lower.ts:29-32`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
