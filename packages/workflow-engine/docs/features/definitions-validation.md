---
title: Workflow Definitions and Validation
type: component
created: 2026-10-10
updated: 2026-10-28
status: active
confidence: medium
tags: [workflow-engine, schema, validation]
sources:
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/prompt-coverage.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/expr.ts
---
# Workflow Definitions and Validation
TL;DR: Workflow definitions are versioned typed graphs that are normalized, parsed, checked for graph and reference errors, and lowered before execution.

## Purpose

This capability defines the JSONC workflow format, its typed nodes and edges, the expression language used by conditions and mapped values, and the validation path used by individual definitions and merged workflow stores (`packages/workflow-engine/src/schema.ts:3-8`, `packages/workflow-engine/src/validate.ts:467-487`).

## How it works

1. `loadWorkflow` accepts an object or JSONC text, parses text with trailing commas enabled, and reports syntax errors as structured problems (`packages/workflow-engine/src/validate.ts:467-473`).
2. `parseWorkflowObject` normalizes supported authoring spellings, then validates against the closed Zod schema; unknown keys and malformed field definitions are rejected (`packages/workflow-engine/src/schema.ts:3-8`, `packages/workflow-engine/src/schema.ts:25-38`, `packages/workflow-engine/src/validate.ts:474-479`).
3. `validateWorkflow` checks node and edge references, graph reachability, loops, subworkflow depth, contracts, agent prompt coverage for produced-artifact enum values, and lowered graph constraints. Node-level model fields are accepted for older definitions but ignored and reported with a `model_ignored` warning; errors make `loadWorkflow` return `ok: false`, while warnings leave it successful (`packages/workflow-engine/src/validate.ts:70-133`, `packages/workflow-engine/src/validate.ts:351-367`, `packages/workflow-engine/src/validate.ts:478-487`).
4. `loadWorkflowStore` loads built-ins and files, chooses the narrowest valid definition by origin, then validates subworkflow references against the merged set; its two passes and lookup results are detailed in [Workflow Validation and Expression Internals](workflow-validation-internals.md) (`packages/workflow-engine/src/store.ts:71-104`).
5. `lowerWorkflow` expands shorthand such as `for_each` and parallel constructs into graph nodes used by the engine (`packages/workflow-engine/src/lower.ts:52-101`).

## Modes and variants

| Variant | Behavior |
|---|---|
| Definition input as object or JSONC string | Both pass through object parsing and graph checks; JSONC allows trailing commas (`packages/workflow-engine/src/validate.ts:467-479`). |
| Built-in, global, and project files | Definitions that fail per-definition loading checks are omitted before origin precedence is applied; the highest-ranked remaining definition is then checked for merged subworkflow references (`packages/workflow-engine/src/store.ts:71-90`). |
| Workflow graph node | Typed node forms have node-specific schemas; node IDs use lowercase letters, digits, `_` and `-`, start with a letter, and are at most 48 characters (`packages/workflow-engine/src/schema.ts:19-20`, `packages/workflow-engine/src/schema.ts:223`). |
| Expression condition or structured condition | Conditions accept bounded recursive `all`, `any`, `not` trees or expression strings; operators include equality, ordering, membership, and existence (`packages/workflow-engine/src/schema.ts:41-57`). |
| Subworkflow call | Resolver checks the requested workflow and optional version; nesting depth is capped at three (`packages/workflow-engine/src/schema.ts:17`, `packages/workflow-engine/src/validate.ts:53-69`). |
| Syntax, schema, or graph error | JSONC parse, closed schema, or graph checks fail | `loadWorkflow` returns `ok: false` and a list of structured problems; `parseWorkflow` throws `WorkflowError` containing those problems. Warning-only results remain successful (`packages/workflow-engine/src/validate.ts:467-487`). |
| Invalid source override | A higher-precedence workflow file has parse or validation errors | The invalid source is added to `problems` and omitted from the final store, so it does not shadow a valid lower-precedence workflow (`packages/workflow-engine/src/store.ts:71-93`). |

## Business rules

- A workflow's entry and exit are represented internally by `$start` and `$end`; they are reserved unless the definition has corresponding ordinary node names under the documented normalization rules (`packages/workflow-engine/src/schema.ts:11-17`).
- Field names begin with a letter or underscore and permit letters, digits, and underscores up to 48 characters. Enum fields require a `values` list, while non-enum fields reject it (`packages/workflow-engine/src/schema.ts:25-38`).
- Workflow schema version is `1`; quality modes are `quick`, `standard`, and `full`; pass modes are `artifact`, `same-session`, `read-prior-session`, and `fork` (`packages/workflow-engine/src/schema.ts:10`, `packages/workflow-engine/src/schema.ts:59-64`).
- Definitions that fail `loadWorkflow` checks without a merged resolver are omitted before origin precedence is applied. The highest-ranked remaining definition per ID is checked against the merged set for subworkflow references; if that check fails, the ID is omitted rather than falling back (`packages/workflow-engine/src/store.ts:71-90`).
- When `specialistKnown` is supplied, an agent role of the form `specialist:<id>` is an error if its literal ID is not known; templated roles and an unknown availability result are not rejected by this check (`packages/workflow-engine/src/validate.ts:21-22`, `packages/workflow-engine/src/validate.ts:357-365`).
- The model belongs to the agent's role. `provider`, `model`, `reasoning`, `service_tier`, and `model_preset` remain schema-compatible but do not select a model and produce a `model_ignored` warning when present (`packages/workflow-engine/src/schema.ts:117-118`, `packages/workflow-engine/src/schema.ts:123-131`, `packages/workflow-engine/src/validate.ts:353-356`).
- For agent nodes, validation warns when an enum accepted by a declared produced-artifact schema is not named in either the node prompt or the generated output contract. It checks literal vocabulary coverage; this finding does not make `loadWorkflow` fail (`packages/workflow-engine/src/prompt-coverage.ts:17-31`, `packages/workflow-engine/src/validate.ts:366-372`, `packages/workflow-engine/src/validate.ts:478-479`).

## Public API

| Import | Purpose |
|---|---|
| `workflowSchema`, `parseWorkflowObject`, `Workflow`, node and edge types | Definition format and normalization (`packages/workflow-engine/src/schema.ts:1-8`, `packages/workflow-engine/src/schema.ts:223-237`). |
| `consumesSchema`, `producesSchema` | Validate the declared artifact input/output contract shapes (`packages/workflow-engine/src/schema.ts:71-84`). |
| `loadWorkflow`, `parseWorkflow`, `validateWorkflow`, `WorkflowError` | Parse definitions and return or throw structured validation problems (`packages/workflow-engine/src/validate.ts:22-29`, `packages/workflow-engine/src/validate.ts:70-129`, `packages/workflow-engine/src/validate.ts:467-487`). |
| `loadWorkflowStore`, `definitionSha256`, `globalWorkflowDir`, `projectWorkflowDir` | Merge workflow sources, resolve definitions, and calculate content identity (`packages/workflow-engine/src/store.ts:24-43`, `packages/workflow-engine/src/store.ts:50-104`). |
| `refOf`, `parseExpr`, `conditionToExpr`, `toExpr`, `evalExpr`, `evalCondition`, `renderValue` | Resolve references, normalize conditions, and evaluate expressions and templates (`packages/workflow-engine/src/expr.ts:57-155`, `packages/workflow-engine/src/expr.ts:280-362`). |

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

The detailed parser, evaluator, schema, validator, and merged-store branches are in [Workflow Definition and Expression Internals](definition-expression-internals.md).

For the detailed expression parser and structured-condition conversion, see [Expression Parsing and Conditions](expression-parsing.md). The two-pass definition-store merge and validation phases are described in [Workflow Store Loading and Validation](workflow-store-loading.md).

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

The dispatch is a Zod discriminated union on `type`; each ordinary node variant requires an ID, while a parallel child uses the same runnable variants without an authoring ID. All variants except note include `nodeBase` fields such as outputs, executor key, retry/timeout bounds, quality-mode skips, inputs, and contracts (`packages/workflow-engine/src/schema.ts:87-120`, `packages/workflow-engine/src/schema.ts:180-230`).

| `type` | Variant-specific inputs and defaults | Parse failures |
|---|---|---|
| `agent` | Role defaults to `worker`, prompt to empty; accepts skills/plugins/MCP lists, environment/session/authorization, and 1–9 votes. Node model fields remain accepted for compatibility (`packages/workflow-engine/src/schema.ts:123-142`). | Strict-object errors, invalid enum/list bounds, or invalid field types fail Zod parsing (`packages/workflow-engine/src/schema.ts:196`, `packages/workflow-engine/src/schema.ts:128-141`). |
| `lp-task` | Optional quality mode and contract templates; owned paths and stages default to empty arrays, with optional per-stage proofs (`packages/workflow-engine/src/schema.ts:143-152`). | Invalid contract union, empty path/stage item, or list over its cap fails parsing (`packages/workflow-engine/src/schema.ts:143-152`, `packages/workflow-engine/src/schema.ts:197`). |
| `action` | Action key is optional; `params` defaults to `{}`; optional output `map` is a record or string (`packages/workflow-engine/src/schema.ts:153-159`). | Bad action key or wrong params/map shape fails parsing (`packages/workflow-engine/src/schema.ts:153-159`, `packages/workflow-engine/src/schema.ts:198`). |
| `decision` | Optional `reads_node` selects a prior node's output; otherwise the executor computes the decision (`packages/workflow-engine/src/schema.ts:199-203`). | Invalid node ID or extra field fails strict parsing (`packages/workflow-engine/src/schema.ts:199-203`). |
| `human` | Requires a 1–4,000 character question; options default empty; timeout defaults to `stop`; optional default option (`packages/workflow-engine/src/schema.ts:160-166`). | Missing/empty question, overlong options, bad timeout value, or unknown property fails parsing (`packages/workflow-engine/src/schema.ts:160-166`, `packages/workflow-engine/src/schema.ts:204`). |
| `parallel` | Optional list source/child/join; `max_fan_out` and concurrency cap at 50; `batch_size` caps at 500; overflow defaults to `fail` (`packages/workflow-engine/src/schema.ts:174-219`). | Invalid `for_each` union or bounds fail parsing. Missing child/join pairing and child without `for_each` are later validation errors, not schema errors (`packages/workflow-engine/src/schema.ts:174-219`, `packages/workflow-engine/src/validate.ts:113-119`). |
| `join` | Requires parallel ID; `wait` defaults to `all`; policy defaults to `all` and schema also accepts `majority` and `all_or_low_confidence` (`packages/workflow-engine/src/schema.ts:220-226`). | Invalid parallel ID, wait value, policy, or extra property fails parsing (`packages/workflow-engine/src/schema.ts:220-226`). |
| `subworkflow` | Requires a workflow ID; optional positive version; input mapping defaults to `{}` (`packages/workflow-engine/src/schema.ts:167-172`, `packages/workflow-engine/src/schema.ts:227`). | Invalid ID/version/input mapping or unknown property fails parsing; whether the workflow exists is checked later when a resolver is supplied (`packages/workflow-engine/src/schema.ts:167-172`, `packages/workflow-engine/src/validate.ts:435-449`). |
| `note` | Carries text, default empty and capped at 2,000 characters; position is optional (`packages/workflow-engine/src/schema.ts:228`). | It has no common `nodeBase`; extra fields or overlong text fail strict parsing (`packages/workflow-engine/src/schema.ts:228`). |

Parsing validates only each variant's shape. Cross-node rules such as executor availability, `reads_node` existence/order, parallel join topology, and subworkflow resolution belong to `validateWorkflow` (`packages/workflow-engine/src/validate.ts:345-456`).

Runnable nodes may declare a step contract: up to 12 consumed artifacts, up to 8 produced artifacts, up to 10 output gates, and a stage proof definition. Each consumed or produced artifact has a kind and version; production may select an output field or check each item. Gates are expressions over the node's own output, and `proof` uses the shared stage-proof schema (`packages/workflow-engine/src/schema.ts:87-95`, `packages/workflow-engine/src/schema.ts:77-83`).

`edgeSchema` requires nonempty `from` and `to` strings no longer than 48 characters; `when` is optional; `label` is optional and capped at 80 characters; `with` maps strings to strings; `pass` defaults to `artifact` and accepts the pass-mode enum. The object is strict, so extra fields fail schema parsing (`packages/workflow-engine/src/schema.ts:234-242`).

`consumesSchema` accepts a strict object with a lowercase artifact kind, version 1–99, `required` defaulting to true, optional nonempty `from` string up to 48 characters, and optional `as` field name. It validates this declaration's shape; graph validation checks that the source node declares the consumed artifact (`packages/workflow-engine/src/schema.ts:64-76`, `packages/workflow-engine/src/validate.ts:307-333`).

Detailed schema branches for conditions, nodes, edges, and consumed artifacts are in [Workflow Validation and Expression Internals](workflow-validation-internals.md) (`packages/workflow-engine/src/schema.ts:51-58`, `packages/workflow-engine/src/schema.ts:77-82`, `packages/workflow-engine/src/schema.ts:228-242`).

`refOf` maps `$inputs` and `input` to workflow inputs, `$mode` to run mode, `ctx` to context, `item` and `index` to loop values, and bare names in item scope to fields on the current item. Other names become node references with the remaining dotted path (`packages/workflow-engine/src/expr.ts:57-69`).

`conditionToExpr` recursively turns `all`, `any`, and `not` conditions into boolean expression nodes. A leaf condition reads its field from the supplied source node and maps comparison operators directly; `exists: false` becomes a negated null comparison, while `exists: true` becomes a non-null comparison. `toExpr` parses string conditions, forwarding `itemScope`, and converts structured conditions through `conditionToExpr` (`packages/workflow-engine/src/expr.ts:133-155`).

The parser precedence, reference classes, structured-condition conversion, and their syntax failures are detailed in [Workflow Validation and Expression Internals](workflow-validation-internals.md) (`packages/workflow-engine/src/expr.ts:57-155`).

### Expression type checking

`checkRef` returns an inferred `Typed` shape while adding problems to the caller-owned array instead of throwing for ordinary invalid references. `$mode` is an enum and reports an issue when mode is unavailable; `$var`, `index`, and `item` are typed as string, number, and any; context names are checked against `CTX_VARS`. Input paths resolve against workflow input fields. Node references must name an existing node that runs before the use; when output fields are known, `fieldPath` checks the referenced path. Unknown field schemas yield `any`, while bad paths append a problem and also return `any` (`packages/workflow-engine/src/expr.ts:203-230`).

`checkExpr` recursively visits literals, refs, visits, negation, lists, and binary expressions. It returns the resulting type while collecting diagnostics: arithmetic and ordering require numeric operands; `in []` is diagnosed; list equality, incompatible types, and enum literals outside the declared set are diagnosed. Logical operators return boolean, and unknown `any` types avoid a false incompatibility report (`packages/workflow-engine/src/expr.ts:233-266`).

The full reference-resolution and operator-check branches, including diagnostic fallback types, are detailed in [Workflow Validation and Expression Internals](workflow-validation-internals.md) (`packages/workflow-engine/src/expr.ts:203-269`).

### Expression evaluation and value specs

`evalExpr` evaluates literal, visit-count, negation, list, reference, and binary nodes. `&&` and `||` short-circuit using the engine's truth rule (arrays count as true, including empty arrays); ordinary references throw `MissingValueError` if their `read` result says the value has not run. Equality uses strict equality plus null/undefined/empty-string equivalence and JSON equality for non-null objects. `in` requires an array on the right; `+` and `-` throw `condition_type` unless both values are numbers; ordering comparisons with nonnumeric values return false (`packages/workflow-engine/src/expr.ts:270-310`).

Evaluation outcomes, failure codes, recursive template rendering, and `by_mode` selection are detailed in [Workflow Validation and Expression Internals](workflow-validation-internals.md) (`packages/workflow-engine/src/expr.ts:280-362`).

`evalCondition` applies that same truth rule to the result, so nonempty strings/numbers/objects and all arrays are true while false, zero, empty string, null, and undefined are false (`packages/workflow-engine/src/expr.ts:276-278`, `packages/workflow-engine/src/expr.ts:312`). Missing references and invalid arithmetic propagate as `MissingValueError`; callers decide whether to surface the issue as validation/runtime failure (`packages/workflow-engine/src/expr.ts:286-301`).

`valueSpecOf` classifies non-strings as literal; trims strings; then checks, in order, empty text, a whole `{{ref}}`, matching single/double quotes, JSON-looking text, booleans/null, numbers, bare identifier, path-like text, and finally parses an expression. Invalid JSON-looking text falls through to expression parsing; expression parse errors propagate. `evalSpec` returns a literal directly or passes the stored expression to `evalExpr`, so missing-value and arithmetic failures propagate (`packages/workflow-engine/src/expr.ts:319-338`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Definition and Expression Internals](definition-expression-internals.md)
- [Workflow Validation and Expression Internals](workflow-validation-internals.md)
- [Workflow Engine — Overview](../overview.md)
