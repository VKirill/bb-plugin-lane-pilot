---
title: Package operation details
type: component
created: 2026-10-14
updated: 2026-10-17
status: active
confidence: medium
tags: [jev, pixel-world, batching, navigation]
sources:
  - packages/jev/src/run.ts
  - packages/jev/src/registry.ts
  - packages/jev/src/client.ts
  - packages/jev/src/types.ts
  - packages/jev/src/thresholds.ts
  - packages/jev/src/receipts.ts
  - packages/contracts/src/index.ts
  - packages/pixel-world/src/batch.ts
  - packages/pixel-world/src/nav.ts
  - packages/pixel-world/src/index.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc-timing.ts
  - packages/jev/src/index.ts
---

# Package operation details

TL;DR: `createJev` batches judgment requests and resolves fallback/shadow/escalation modes; the pixel-world helpers merge eligible static geometry and find paths across a captured obstacle grid.

## Purpose

Describe the execution and failure behavior of selected package APIs summarized in [Packages](packages.md).

## How it works

### `createJev`

1. `createJev` receives a client and optional database/logger. Before a request it runs the judgment state builder through deep redaction, gets its questions, rejects judgments over the question cap, resolves mode and thresholds from context settings, and serializes state (`packages/jev/src/run.ts:56-64`).
2. Receipt writing is skipped when there is no database or the mode is `off`. Otherwise it records judgment/version, hashed state, question/batch counts, call status, token/latency data, decision and thresholds; insertion errors are logged and become a null receipt id (`packages/jev/src/run.ts:66-80`).
3. A client failure or missing/invalid answer set calls the judgment fallback. A decision exception is logged and also falls back with `invalid` status. In shadow mode the production fallback remains the decision while the Jev decision is attached as `shadow`; explicit escalation returns `by:"escalate"`; otherwise the Jev decision is returned (`packages/jev/src/run.ts:82-97`).
4. `run` immediately returns fallback verdicts for `off` entries. Other entries with identical model and serialized state are grouped, then split when adding an entry would exceed 48 questions or the 80,000-character bound applied to serialized questions (`packages/jev/src/run.ts:99-117`, `packages/jev/src/registry.ts:11`, `packages/jev/src/client.ts:22`).
5. Each request namespaces question ids with the original entry index, calls the client with the shared state, selected model, maximum member timeout, and context budget/signal, then extracts each judgment's answer subset and resolves its verdict (`packages/jev/src/run.ts:118-129`).
6. The returned API supports one judgment, many inputs for one judgment, and a bundle of different judgments. `outcome` ignores null receipts/no database and swallows receipt-labeling errors (`packages/jev/src/run.ts:132-140`).

| Mode or condition | Inputs and output | Failure behavior |
|---|---|---|
| `off` | Uses the judgment fallback without a client call. | No receipt is attempted. |
| Normal | Returns `by:"jev"` with decision and answers when call and decision succeed. | Client failure, invalid answers, or decision exception return fallback with failure status. |
| `shadow` | Returns fallback as production decision and attaches the Jev result under `shadow`. | Jev failure follows the same fallback path; receipt insertion failure only removes receipt id. |
| Escalation | A successful decision with `escalate` returns `by:"escalate"`, destination, and answers. | This is a declared judgment outcome, not a transport failure. |
| Preparation/client rejection | State/question preparation happens before run; a rejected `client.call` rejects the run promise. | Too many questions throws during preparation; batch request rejection propagates through `Promise.all`. |

### `rpcContract`

1. The contracts room imports the shell, native, runs, settings, operations, knowledge, workflow, and world maps, then spreads each into one `defineRpcContract` call (`src/rooms/contracts/index.ts:1-9`, `:17-26`).
2. Composition is unconditional. Each method owns its strict input and output schemas; `rpcContract` does not add a separate route mode or transform a domain result (`src/rooms/contracts/index.ts:17-26`).
3. The module separately exports `hostContract` and shared schemas/types, while `rpcContract` is the single public UI RPC contract of the room (`src/rooms/contracts/index.ts:11-16`).

| Condition | Result | Failure behavior |
|---|---|---|
| Valid route payload | Method input is checked against the schema declared in its source map; the contract includes the route's declared output shape. | Handler owns domain work and domain refusal values. |
| Extra or invalid field | Strict route schemas reject undeclared keys, invalid enums, and values outside declared bounds. | Validation fails before the handler returns a result. |
| Handler or transport failure | Contract does not convert a rejection into a domain result. | RPC caller receives the rejection through the registration wrapper (`src/rooms/core/server/rpc-timing.ts:12-40`). |

### `batchStatic`

1. `batchStatic(THREE, root, options)` updates world matrices, creates shared opaque/glass toon materials, and traverses visible descendants. Invisible and `noBatch` objects stop traversal; `options.isolate` starts a separate merge target under a selected group (`packages/pixel-world/src/batch.ts:37-65`).
2. A mesh is eligible only when it is visible, unskinned, non-instanced, one untextured `MeshToonMaterial`, without emissive map/glow, front-side, no vertex colors, no children, and not marked `noBatch` (`packages/pixel-world/src/batch.ts:27-35`). Excluded geometry stays in the scene.
3. For each eligible mesh, the function clones position, normal, and index data (or generates missing index/normals), applies the matrix into target-local space, corrects mirrored triangle winding, and bakes material color plus glass alpha into vertex colors (`packages/pixel-world/src/batch.ts:67-106`).
4. It counts source meshes/triangles, removes each source mesh, and removes empty intermediate groups. Opaque and transparent geometry are merged separately per target; non-null merges become static meshes and are returned (`packages/pixel-world/src/batch.ts:108-131`).
5. `dispose` releases owned shared materials and merged geometry (`packages/pixel-world/src/batch.ts:48-52`, `:134-137`).

| Branch | Outcome | Failure behavior |
|---|---|---|
| Eligible opaque/glass mesh | Added to separate opaque or transparent target merge. | Source material color and transparency become vertex colors/alpha. |
| Ineligible/invisible/noBatch object | Source stays unchanged; invisible/noBatch also prunes descendant traversal. | It is not reported as an error. |
| Merge returns null | Source meshes have already been detached; that target receives no replacement mesh. | Function continues with other merge buckets. |
| Unexpected exception | No catch surrounds traversal/geometry processing. | Exception propagates; previously detached sources can remain detached. |

### `createNavGrid`

1. `createNavGrid` captures bounds and obstacle rectangles once, applies defaults of 0.5 world-unit step, 0.15 point margin, and 0.08 segment margin, then indexes each rectangle into 2-unit buckets (`packages/pixel-world/src/nav.ts:1-16`, `:27-50`).
2. `isBlocked` first checks bounds, then tests only obstacle rectangles in nearby buckets with the requested/default margin. `isSegmentBlocked` samples the line with at least three intervals and no interval larger than 0.18 units (`packages/pixel-world/src/nav.ts:53-75`).
3. `findPath` returns the exact target as one waypoint when the direct segment is clear. Otherwise it lazily computes and caches blocked cells, maps blocked start/target cells to the nearest free cell within radius three when possible, then runs A* with eight directions and diagonal corner checks (`packages/pixel-world/src/nav.ts:84-94`, `:107-180`).
4. When a route is found, grid cells become world waypoints. String-pulling skips waypoints visible from the current point and includes the exact original target as the final point (`packages/pixel-world/src/nav.ts:185-212`).

| Branch | Result | Failure behavior |
|---|---|---|
| Direct clear segment | One waypoint at the exact target; no grid search. | No explicit failure status. |
| Obstructed segment | A* route, then string-pulled waypoints. | Search stops after 8,000 iterations; no-path is not exposed as a status and fallback smoothing still returns a sequence. |
| Blocked endpoint cell | Searches outward up to three cells for a free cell. | If none is found, retains the original cell; final smoothing still targets the original exact point, so it may remain blocked. |

## Business rules

The pixel-world batcher is intended for completed static scene geometry before dynamic objects are added; the navigation grid keeps its obstacle snapshot until recreated (`packages/pixel-world/src/batch.ts:37-45`, `packages/pixel-world/src/nav.ts:7-15`).

## Public API or commands

`@lane-pilot/jev` exports `createJev` through its package root; `@lane-pilot/pixel-world` exports `batchStatic` and `createNavGrid` plus navigation types (`packages/jev/src/index.ts:1-9`, `packages/pixel-world/src/index.ts:1-8`). `rpcContract` is exported by the contracts room (`src/rooms/contracts/index.ts:13-26`).

## Gotchas

Batching can detach source meshes before a merge failure or thrown exception is visible to the caller. Navigation's output is a waypoint list without a separate no-path result (`packages/pixel-world/src/batch.ts:108-131`, `packages/pixel-world/src/nav.ts:150-152`, `:185-212`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Shared packages](packages.md)
