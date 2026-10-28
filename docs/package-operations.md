---
title: Package operation details
type: component
created: 2026-10-14
updated: 2026-10-28
status: active
confidence: high
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
  - packages/jev/src/runtime.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/handoff/src/messages.ts
---

# Package operation details

TL;DR: `createJev` batches judgment requests and resolves fallback/shadow/escalation modes; the pixel-world helpers merge eligible static geometry and find paths across a captured obstacle grid.

## Purpose

Describe the execution and failure behavior of selected package APIs summarized in [Packages](packages.md).

## How it works

### Jev runtime accessor

1. `jev()` reads a module-level installed value and returns either the current `Jev` instance or `null`; it performs no initialization (`packages/jev/src/runtime.ts:5-12`).
2. `installJev({endpoint, db, log})` creates a Jev client whose endpoint is resolved when needed, passes it with the database and optional logger to `createJev`, stores that instance, and returns a disposer (`packages/jev/src/runtime.ts:14-17`).
3. The disposer clears the singleton only if that same instance is still installed, so disposing an older installation does not clear a replacement. `setJevForTests` directly installs or clears the test instance (`packages/jev/src/runtime.ts:14-21`).

| State or failure | Result |
|---|---|
| No installation | `jev()` returns `null`; the accessor has no failure branch (`packages/jev/src/runtime.ts:10-12`). |
| Installed instance | `jev()` returns the instance until replacement or its matching disposer (`packages/jev/src/runtime.ts:10-17`). |
| Endpoint/client failure | The accessor does not catch failures; the later judgment call owns client and fallback behavior (`packages/jev/src/runtime.ts:14-17`, `packages/jev/src/run.ts:82-97`). |

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

1. The contracts room imports the shell, native, runs, settings, operations, knowledge, workflow, and world maps, then spreads each into one `defineRpcContract` call (`src/rooms/contracts/index.ts:1-9`, `:18-27`).
2. Composition is unconditional. Each method owns its strict input and output schemas; `rpcContract` does not add a separate route mode or transform a domain result (`src/rooms/contracts/index.ts:18-27`).
3. The module separately exports `hostContract` and shared schemas/types, while `rpcContract` is the single public UI RPC contract of the room (`src/rooms/contracts/index.ts:11-17`).

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
3. `findPath` returns the exact target as one waypoint when the direct segment is clear. Otherwise it lazily caches blocked grid cells at the default point margin and maps blocked start/target cells to the nearest free cell within three cells when available (`packages/pixel-world/src/nav.ts:84-94`, `:107-139`).
4. A* expands four cardinal and four diagonal neighbors, uses straight/diagonal costs and Euclidean distance, forbids diagonal corner cutting, and stops when it reaches the target cell or exhausts 8,000 iterations (`packages/pixel-world/src/nav.ts:96-105`, `:141-183`).
5. A found cell chain is converted to world points and string-pulled by checking the farthest visible waypoint from each current point; the exact requested target is included at the end (`packages/pixel-world/src/nav.ts:185-212`).

| Branch | Result | Failure behavior |
|---|---|---|
| Direct clear segment | One waypoint at the exact target; no grid search. | No explicit failure status. |
| Obstructed segment | A* route, then string-pulled waypoints. | Search stops after 8,000 iterations; no-path is not exposed as a status and fallback smoothing still returns a sequence. |
| Blocked endpoint cell | Searches outward up to three cells for a free cell. | If none is found, retains the original cell; final smoothing still targets the original exact point, so it may remain blocked. |
| Search exhausts without a route | The cell chain is empty and smoothing still includes the original start and target (`packages/pixel-world/src/nav.ts:150-195`, `:197-212`). | The API returns a waypoint list ending at the target and has no explicit no-path status; the list does not certify that the target is reachable. |

### `runOnHost`

1. `runOnHost(host, args)` takes host id, cwd, command, command timeout and an optional hub transport timeout (`packages/host-calls/src/run-on-host.ts:8-24`).
2. It calls `runCommand` with the host id duplicated as `requestedHostId` in the request and `hostId` in options, and forwards command, cwd and `timeoutSec` (`packages/host-calls/src/run-on-host.ts:26-31`).
3. An explicit `timeoutMs` is used as the transport timeout; otherwise the transport gets command timeout plus five seconds. The function returns the `host.call` promise directly, so a fulfilled host result and a rejected call pass through without translation (`packages/host-calls/src/run-on-host.ts:26-31`).

| Branch | Outcome or failure |
|---|---|
| Explicit transport timeout | Forwards the caller's `timeoutMs`. |
| No transport timeout | Computes `(timeoutSec + 5) * 1000`. |
| Host rejects | Rejection propagates; the wrapper does not catch or translate it. |

### `handoffMessage`

1. `handoffMessage(card)` assembles a recipient prompt in fixed order: handoff identity/title, objective, numbered acceptance criteria, inputs, budget and receipt instructions (`packages/handoff/src/messages.ts:12-37`).
2. Inputs render as `- kind: ref` with an optional note, or `- none`. The budget includes truthy minutes, turns, tokens and deadline values, or `none stated` (`packages/handoff/src/messages.ts:3-16`).
3. The final fenced JSON asks for `done`, `blocked`, or `rejected`, with summary, outputs and evidence. The formatter returns a string and does not parse or validate a recipient response (`packages/handoff/src/messages.ts:31-37`).

| Condition | Output | Failure behavior |
|---|---|---|
| Empty inputs or budget | Emits `- none` or `none stated`. | Not an error. |
| Non-empty card | Includes input details, truthy budget fields and receipt template. | The formatter has no catch or failure result; invalid runtime data can throw during formatting. |

## Business rules

The pixel-world batcher is intended for completed static scene geometry before dynamic objects are added; the navigation grid keeps its obstacle snapshot until recreated (`packages/pixel-world/src/batch.ts:37-45`, `packages/pixel-world/src/nav.ts:7-15`).

## Public API or commands

`@lane-pilot/jev` exports `createJev` through its package root; `@lane-pilot/pixel-world` exports `batchStatic` and `createNavGrid` plus navigation types (`packages/jev/src/index.ts:1-9`, `packages/pixel-world/src/index.ts:1-8`). `rpcContract` is exported by the contracts room after the route maps are composed (`src/rooms/contracts/index.ts:18-27`).

## Gotchas

Batching can detach source meshes before a merge failure or thrown exception is visible to the caller. Navigation's output is a waypoint list without a separate no-path result (`packages/pixel-world/src/batch.ts:108-131`, `packages/pixel-world/src/nav.ts:150-152`, `:185-212`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Shared packages](packages.md)
