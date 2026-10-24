---
title: Workflow Store Loading and Validation
type: component
created: 2026-10-24
updated: 2026-10-24
status: active
confidence: high
tags: [workflow-engine, workflow-store, validation]
sources:
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/expr.ts
---
# Workflow Store Loading and Validation
TL;DR: The store reads built-ins and workflow files, filters parse and local validation errors, applies source precedence, then checks references against the merged set.

## Purpose

`loadWorkflowStore` turns built-in definitions and configured global/project directories into a lookup store. It keeps source-specific problems alongside the definitions that passed parsing and validation (`packages/workflow-engine/src/store.ts:45-57`, `packages/workflow-engine/src/store.ts:95-103`).

## How it works

1. Built-ins become raw entries with origin `builtin`. The supplied file source or `nodeFileSource` is used for files; unset directories are skipped (`packages/workflow-engine/src/store.ts:16-22`, `packages/workflow-engine/src/store.ts:58-62`).
2. For each configured global or project directory, `list` is called. A listing exception becomes a `read` problem and loading continues; each file read is attempted separately, with read exceptions recorded against that path (`packages/workflow-engine/src/store.ts:61-68`). The default file source treats a missing directory as empty and returns sorted `.json` paths (`packages/workflow-engine/src/store.ts:16-20`).
3. Pass 1 calls `loadWorkflow` without a cross-workflow resolver. Parse, schema, or local graph errors are recorded and the entry is excluded; successful entries retain warnings and receive a content hash (`packages/workflow-engine/src/store.ts:71-78`). The hash excludes editor `ui` placement (`packages/workflow-engine/src/store.ts:40-43`).
4. Successful definitions are sorted by origin rank and inserted into a map by workflow ID. Later entries at the same or higher rank replace earlier entries, so project outranks global, which outranks built-in (`packages/workflow-engine/src/store.ts:39`, `packages/workflow-engine/src/store.ts:79`).
5. Pass 2 creates a resolver over that merged map. It returns a workflow only when the ID exists and an optional requested version matches (`packages/workflow-engine/src/store.ts:81-85`).
6. Each selected workflow is validated again with this resolver. Any error records the issues and excludes that selected ID; it does not restore a lower-ranked definition. If validation passes, the optional `resolveStatus` callback may override the stored status and append its notes; otherwise validation warnings are stored (`packages/workflow-engine/src/store.ts:86-94`).
7. The returned store exposes snapshot-style `list`, nullable `get`, version-aware `resolve`, and accumulated `problems` (`packages/workflow-engine/src/store.ts:95-103`).

### `validateWorkflow` checks

`loadWorkflow` calls `validateWorkflow` after schema parsing. The validator accumulates `WorkflowProblem` entries rather than stopping at the first reported issue; errors make `loadWorkflow` fail, while warning-only results remain successful (`packages/workflow-engine/src/validate.ts:67-70`, `packages/workflow-engine/src/validate.ts:470-472`).

| Order | Checks and branches | Reported outcome |
|---|---|---|
| Authoring form | Reserved/duplicate node IDs, missing or conflicting entry declarations, duplicate input/output/node fields, schedule cron/timezone, emit map requirements, output status values, emit outgoing edges, and parallel child/join/for_each combinations (`packages/workflow-engine/src/validate.ts:78-119`). | Structural inconsistencies add errors; invalid schedule details add warnings. |
| Lowered graph | Lower shorthand, index runnable nodes, validate edge endpoints and note edges, require exactly one unconditional start edge and an exit edge (`packages/workflow-engine/src/validate.ts:121-138`). | Unknown endpoints, illegal sentinel edges, missing/multiple/conditional entries, or missing exits add errors. |
| Routing shape | For each runnable node, check outgoing edges. Parallel edges cannot be conditional; `for_each` parallel nodes need one outgoing edge; ordinary nodes cannot have multiple unconditional edges. | Dead ends and invalid branch shape add errors; conditional routes without fallback add a warning (`packages/workflow-engine/src/validate.ts:154-165`). |
| Expressions and references | Parse edge conditions, mappings, templates, value specs, `skip_when`, `reads`, and mode tables. Then check reference scope, node order, field paths and expression types (`packages/workflow-engine/src/validate.ts:167-253`, `packages/workflow-engine/src/validate.ts:255-276`). | Syntax problems become `bad_expr`; reference/type issues become structured error codes; invalid `by_mode` keys or missing mode/default entries add errors. |
| Cycles and skips | Inspect strongly connected components; require `maxVisits` or an in-loop `visits()` bound. For nodes that can skip, verify declared readers are supplied by `skip_out` (`packages/workflow-engine/src/validate.ts:278-302`). | Unbounded cycles or missing skip values add errors. |
| Step contracts | Check artifact registry entries, produced fields, `each` list shape, consumed source and producer ordering, and gate expression references (`packages/workflow-engine/src/validate.ts:304-343`). | Contract inconsistencies add errors; missing `produces` on agent/lp-task nodes adds a warning. |
| Node-specific rules | Check executor availability when configured, presets, agent settings and outputs, human timeout defaults, decision source/order/field compatibility, and parallel list/filter/child rules (`packages/workflow-engine/src/validate.ts:345-445`). | Invalid configuration adds errors; unknown presets/models, ignored agent environment settings, and empty prompts add warnings. |
| Subworkflow closure | When a resolver is supplied, calculate nested depth and detect recursive calls (`packages/workflow-engine/src/validate.ts:448-452`). | Recursive calls or depth beyond the lower of workflow and schema limits add errors. |

## Modes and outcomes

| Case | Branch | Outcome |
|---|---|---|
| Built-in definitions | Added directly to raw entries; no directory listing (`packages/workflow-engine/src/store.ts:58-60`). | Parsed with the same `loadWorkflow` path as file definitions. |
| Global/project directory absent | No directory is listed (`packages/workflow-engine/src/store.ts:61-62`). | That origin contributes no file definitions. |
| Default source sees missing directory | `nodeFileSource.list` catches `ENOENT` (`packages/workflow-engine/src/store.ts:16-20`). | Empty path list, without a problem. |
| Listing or reading fails | Store catches each exception (`packages/workflow-engine/src/store.ts:63-68`). | Adds an origin/source `read` problem and continues with other entries. |
| Parse/schema/local validation fails | `loadWorkflow` returns `ok: false` (`packages/workflow-engine/src/validate.ts:459-471`). | Adds its problems and excludes the entry before precedence is applied (`packages/workflow-engine/src/store.ts:74-77`). |
| Duplicate workflow ID | Successful entries are sorted and assigned into `first` by ID (`packages/workflow-engine/src/store.ts:39`, `packages/workflow-engine/src/store.ts:79`). | Highest origin rank wins; later item wins for equal rank. |
| Selected definition fails merged validation | The resolver is available during pass 2 (`packages/workflow-engine/src/store.ts:81-89`). | Records errors and excludes the ID; no lower-ranked fallback is attempted. |
| Optional status override | Called only after selected definition passes validation (`packages/workflow-engine/src/store.ts:90-94`). | Different status replaces the returned workflow status and appends override notes. |

`loadWorkflow` returns either `{ ok: false, problems }` or `{ ok: true, workflow, warnings }`; syntax, schema, and validation errors are represented as problems, while warnings preserve a successful load (`packages/workflow-engine/src/validate.ts:456-472`).

## Business rules

- Source precedence is `builtin` < `global` < `project`; selection occurs after each entry has passed `loadWorkflow` (`packages/workflow-engine/src/store.ts:39`, `packages/workflow-engine/src/store.ts:71-79`).
- Cross-workflow checks run after precedence selection. A selected definition that fails those checks is omitted rather than replaced by a lower-ranked definition (`packages/workflow-engine/src/store.ts:81-90`).
- `resolve(id, version)` returns `null` when the ID is absent or the requested version differs (`packages/workflow-engine/src/store.ts:98-101`).

## Public API

| Export | Purpose |
|---|---|
| `loadWorkflowStore(input)` | Build the merged store and diagnostics (`packages/workflow-engine/src/store.ts:50-104`). |
| `WorkflowFileSource` | Inject directory listing and file reading, such as a host-provided source (`packages/workflow-engine/src/store.ts:9-14`). |
| `nodeFileSource` | Read sorted `.json` files from disk; missing directories are empty (`packages/workflow-engine/src/store.ts:16-22`). |
| `definitionSha256(workflow)` | Hash definition content without editor placement (`packages/workflow-engine/src/store.ts:40-41`). |

## Gotchas

- A structurally valid project definition can still remove that ID from the final store if merged subworkflow validation fails; the valid global or built-in version does not become fallback (`packages/workflow-engine/src/store.ts:86-90`).
- The default source lists `.json` files only; another format requires a supplied `WorkflowFileSource` (`packages/workflow-engine/src/store.ts:16-22`).
- The store catches directory/file I/O errors, but the exception branches are limited to listing and reading. Validation and hashing are outside those catches (`packages/workflow-engine/src/store.ts:63-78`, `packages/workflow-engine/src/store.ts:86-94`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Definitions and Validation](definitions-validation.md)
