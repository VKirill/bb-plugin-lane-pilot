---
title: Workflow Definitions and Validation
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [workflow-engine, schema, validation]
sources:
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/expr.ts
---
# Workflow Definitions and Validation
TL;DR: Workflow definitions are versioned typed graphs that are normalized, parsed, checked for graph and reference errors, and lowered before execution.

## Purpose

This capability defines the JSONC workflow format, its typed nodes and edges, the expression language used by conditions and mapped values, and the validation path used by individual definitions and merged workflow stores (`packages/workflow-engine/src/schema.ts:3-8`, `packages/workflow-engine/src/validate.ts:459-482`).

## How it works

1. `loadWorkflow` accepts an object or JSONC text, parses text with trailing commas enabled, and reports syntax errors as structured problems (`packages/workflow-engine/src/validate.ts:459-465`).
2. `parseWorkflowObject` normalizes supported authoring spellings, then validates against the closed Zod schema; unknown keys and malformed field definitions are rejected (`packages/workflow-engine/src/schema.ts:3-8`, `packages/workflow-engine/src/schema.ts:25-38`, `packages/workflow-engine/src/validate.ts:466-471`).
3. `validateWorkflow` checks node and edge references, graph reachability, loops, subworkflow depth, contracts, and lowered graph constraints; errors make `loadWorkflow` return `ok: false` (`packages/workflow-engine/src/validate.ts:67-130`, `packages/workflow-engine/src/validate.ts:470-472`).
4. `loadWorkflowStore` loads built-ins and files, chooses the narrowest valid definition by origin, then validates subworkflow references against the merged set (`packages/workflow-engine/src/store.ts:45-48`, `packages/workflow-engine/src/store.ts:71-93`).
5. `lowerWorkflow` expands shorthand such as `for_each` and parallel constructs into graph nodes used by the engine (`packages/workflow-engine/src/lower.ts:52-101`).

## Modes and variants

| Variant | Behavior |
|---|---|
| Definition input as object or JSONC string | Both pass through object parsing and graph checks; JSONC allows trailing commas (`packages/workflow-engine/src/validate.ts:459-471`). |
| Built-in, global, and project files | Parse/schema-invalid files are omitted before origin precedence is applied; structurally valid files are ranked built-in < global < project and then checked for graph/reference errors (`packages/workflow-engine/src/store.ts:39-48`, `packages/workflow-engine/src/store.ts:71-89`). |
| Workflow graph node | Typed node forms have node-specific schemas; node IDs use lowercase letters, digits, `_` and `-`, start with a letter, and are at most 48 characters (`packages/workflow-engine/src/schema.ts:19-20`, `packages/workflow-engine/src/schema.ts:223`). |
| Expression condition or structured condition | Conditions accept bounded recursive `all`, `any`, `not` trees or expression strings; operators include equality, ordering, membership, and existence (`packages/workflow-engine/src/schema.ts:41-57`). |
| Subworkflow call | Resolver checks the requested workflow and optional version; nesting depth is capped at three (`packages/workflow-engine/src/schema.ts:17`, `packages/workflow-engine/src/validate.ts:50-66`). |
| Syntax, schema, or graph error | JSONC parse, closed schema, or graph checks fail | `loadWorkflow` returns `ok: false` and a list of structured problems; `parseWorkflow` throws `WorkflowError` containing those problems (`packages/workflow-engine/src/validate.ts:459-482`). |
| Invalid source override | A higher-precedence workflow file has parse or validation errors | The invalid source is added to `problems` and omitted from the final store, so it does not shadow a valid lower-precedence workflow (`packages/workflow-engine/src/store.ts:71-93`). |

## Business rules

- A workflow's entry and exit are represented internally by `$start` and `$end`; they are reserved unless the definition has corresponding ordinary node names under the documented normalization rules (`packages/workflow-engine/src/schema.ts:11-17`).
- Field names begin with a letter or underscore and permit letters, digits, and underscores up to 48 characters. Enum fields require a `values` list, while non-enum fields reject it (`packages/workflow-engine/src/schema.ts:25-38`).
- Workflow schema version is `1`; quality modes are `quick`, `standard`, and `full`; pass modes are `artifact`, `same-session`, `read-prior-session`, and `fork` (`packages/workflow-engine/src/schema.ts:10`, `packages/workflow-engine/src/schema.ts:59-64`).
- Parse/schema-invalid files are omitted before origin precedence is applied. A structurally valid higher-precedence definition is selected before merged graph/reference validation; if that validation fails, the ID is omitted from the final store rather than falling back to a lower-precedence definition (`packages/workflow-engine/src/store.ts:71-93`).

## Public API

| Import | Purpose |
|---|---|
| `workflowSchema`, `parseWorkflowObject`, `Workflow`, node and edge types | Definition format and normalization (`packages/workflow-engine/src/schema.ts:1-8`, `packages/workflow-engine/src/schema.ts:223-237`). |
| `loadWorkflow`, `parseWorkflow`, `validateWorkflow`, `WorkflowError` | Parse definitions and return or throw structured validation problems (`packages/workflow-engine/src/validate.ts:22-29`, `packages/workflow-engine/src/validate.ts:67-126`, `packages/workflow-engine/src/validate.ts:459-482`). |
| `loadWorkflowStore`, `definitionSha256`, `globalWorkflowDir`, `projectWorkflowDir` | Merge workflow sources, resolve definitions, and calculate content identity (`packages/workflow-engine/src/store.ts:24-43`, `packages/workflow-engine/src/store.ts:50-104`). |
| `parseExpr`, `evalExpr`, `evalCondition`, `renderValue` | Parse and evaluate workflow expressions and templates (`packages/workflow-engine/src/expr.ts:72-131`, `packages/workflow-engine/src/expr.ts:280-340`). |

## Package shape

`schema.ts` owns types and structural schemas; `validate.ts` adds graph-level checks; `store.ts` merges definitions from sources; `lower.ts` converts shorthand into executable graph forms; `expr.ts` and `values.ts` implement expression and template semantics (`packages/workflow-engine/src/schema.ts:1-8`, `packages/workflow-engine/src/validate.ts:1-8`, `packages/workflow-engine/src/store.ts:1-8`).

## Internal model

The stored workflow is a typed directed graph with declared output fields. References and conditions are checked against the graph’s declared outputs, which allows validation to catch misspelled or unavailable values before execution (`packages/workflow-engine/src/schema.ts:3-8`, `packages/workflow-engine/src/expr.ts:203-269`).

The store parses all sources first, applies origin precedence by workflow ID, then checks subworkflow references against that merged collection. Definition hashes omit editor `ui` placement, so moving cards does not change workflow content identity (`packages/workflow-engine/src/store.ts:39-43`, `packages/workflow-engine/src/store.ts:71-93`).

## Dependencies

The schemas use Zod; file parsing and hashing are delegated to the store and `@lane-pilot/kit` (`packages/workflow-engine/src/schema.ts:1-2`, `packages/workflow-engine/src/store.ts:1-7`).

## Gotchas

- Unknown schema keys are errors; authoring aliases are accepted only through normalization before the closed schema validation (`packages/workflow-engine/src/schema.ts:3-8`).
- A syntactically valid file can still be excluded because graph validation or a subworkflow reference fails (`packages/workflow-engine/src/store.ts:71-93`).

## Lowering, expression checks, and schema details

### `lowerWorkflow`

`lowerWorkflow` makes a shallow transformed workflow; it does not run validation itself. It walks each source node and constructs a new node list plus generated edges, then retargets incoming edges, appends only generated edges whose `(from,to)` pair is not already present, adds a `$start` edge for `entry` when no start edge exists, removes `entry`, and returns the copy (`packages/workflow-engine/src/lower.ts:52-100`).

| Source form | Lowering branch | Output |
|---|---|---|
| `parallel` with a `child` | Split into `<id>:fan`, `<id>:child`, and a `join` retaining `<id>`; default join policy is `all`. Incoming edges retarget to the fan node; generated edges carry branch artifacts into the child and child outputs to the join (`packages/workflow-engine/src/lower.ts:57-76`). |
| `action: emit` | Normalize `map` to an object; assign declared workflow output fields where names match and optional JSON fields otherwise; default executor to `builtin:emit`; add an edge to `$end` carrying declared output names (`packages/workflow-engine/src/lower.ts:78-85`). |
| `subworkflow` with no declared outputs | If the optional resolver returns the requested child/version, copy its outputs onto the node; if not resolved, retain the original node (`packages/workflow-engine/src/lower.ts:87-90`). |
| Other node | Copy unchanged into the lowered node list (`packages/workflow-engine/src/lower.ts:57-58`, `packages/workflow-engine/src/lower.ts:92`). |

The function does not catch errors from a supplied resolver. Invalid generated graphs are reported by validation at the caller boundary; the function itself returns the transformed workflow (`packages/workflow-engine/src/lower.ts:17-18`, `packages/workflow-engine/src/lower.ts:52-100`). Lowering is documented as idempotent and is used by both validation and execution (`packages/workflow-engine/src/lower.ts:4-9`).

### Condition and node schemas

`conditionSchema` lazily validates either a strict field/operator/value object, a nonempty `all` or `any` list capped at 20 children, or a strict recursive `not` object. `whenSchema` also accepts a nonempty expression string up to 600 characters; unsupported object shapes and extra keys fail Zod parsing (`packages/workflow-engine/src/schema.ts:41-57`).

`nodeSchema` dispatches on the required `type` discriminator to one of nine strict schemas: agent, lp-task, action, decision, human, parallel, join, subworkflow, or note. The selected node schema enforces its required fields, defaults, and type-specific constraints; a missing/unknown discriminator, wrong field type, or unknown property fails parsing (`packages/workflow-engine/src/schema.ts:223-227`, `packages/workflow-engine/src/schema.ts:180-221`).

`edgeSchema` requires nonempty `from` and `to` strings no longer than 48 characters; `when` is optional; `label` is optional and capped at 80 characters; `with` maps strings to strings; `pass` defaults to `artifact` and accepts the pass-mode enum. The object is strict, so extra fields fail schema parsing (`packages/workflow-engine/src/schema.ts:229-238`).

### Expression type checking

`checkRef` returns an inferred `Typed` shape while adding problems to the caller-owned array instead of throwing for ordinary invalid references. `$mode` is an enum and reports an issue when mode is unavailable; `$var`, `index`, and `item` are typed as string, number, and any; context names are checked against `CTX_VARS`. Input paths resolve against workflow input fields. Node references must name an existing node that runs before the use; when output fields are known, `fieldPath` checks the referenced path. Unknown field schemas yield `any`, while bad paths append a problem and also return `any` (`packages/workflow-engine/src/expr.ts:203-230`).

`checkExpr` recursively visits literals, refs, visits, negation, lists, and binary expressions. It returns the resulting type while collecting diagnostics: arithmetic and ordering require numeric operands; `in []` is diagnosed; list equality, incompatible types, and enum literals outside the declared set are diagnosed. Logical operators return boolean, and unknown `any` types avoid a false incompatibility report (`packages/workflow-engine/src/expr.ts:233-266`).

### Expression evaluation and value specs

`evalExpr` evaluates literal, visit-count, negation, list, reference, and binary nodes. `&&` and `||` short-circuit using the engine's truth rule (arrays count as true, including empty arrays); ordinary references throw `MissingValueError` if their `read` result says the value has not run. Equality uses strict equality plus null/undefined/empty-string equivalence and JSON equality for non-null objects. `in` requires an array on the right; `+` and `-` throw `condition_type` unless both values are numbers; ordering comparisons with nonnumeric values return false (`packages/workflow-engine/src/expr.ts:270-310`).

`evalCondition` applies that same truth rule to the result, so nonempty strings/numbers/objects and all arrays are true while false, zero, empty string, null, and undefined are false (`packages/workflow-engine/src/expr.ts:276-278`, `packages/workflow-engine/src/expr.ts:312`). Missing references and invalid arithmetic propagate as `MissingValueError`; callers decide whether to surface the issue as validation/runtime failure (`packages/workflow-engine/src/expr.ts:286-301`).

`valueSpecOf` classifies non-strings as literal; trims strings; then checks, in order, empty text, a whole `{{ref}}`, matching single/double quotes, JSON-looking text, booleans/null, numbers, bare identifier, path-like text, and finally parses an expression. Invalid JSON-looking text falls through to expression parsing; expression parse errors propagate. `evalSpec` returns a literal directly or passes the stored expression to `evalExpr`, so missing-value and arithmetic failures propagate (`packages/workflow-engine/src/expr.ts:319-338`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
