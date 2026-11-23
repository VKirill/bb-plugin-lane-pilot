---
title: Workflow Validation and Expression Internals
type: component
created: 2026-10-26
updated: 2026-11-23
status: active
confidence: medium
tags: [workflow-engine, validation, expressions, schema]
sources:
  - packages/workflow-engine/src/expr.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/prompt-coverage.ts
  - packages/workflow-engine/src/index.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/lower.ts
---
# Workflow Validation and Expression Internals
TL;DR: Workflow parsing, static checking, runtime evaluation, schema parsing, and store merging are separate stages with distinct diagnostics and failure behavior.

## Purpose

This page records the detailed branches of the parser, expression checker, runtime evaluator, workflow schemas, validator, and multi-source workflow store. The overview and authoring rules are in [Workflow Definitions and Validation](definitions-validation.md).

## How it works

1. `loadWorkflow` parses JSONC text when given a string, turns syntax errors into `syntax` problems, parses the normalized object against `workflowSchema`, and returns `schema` problems when parsing fails. It returns a workflow plus warnings when validation has no errors. `parseWorkflow` returns that workflow or throws `WorkflowError` containing every load problem (`packages/workflow-engine/src/validate.ts:560-580`, `packages/workflow-engine/src/schema.ts:266-341`). The public input contract is documented in [Workflow Definitions and Validation](definitions-validation.md).
2. `validateWorkflow` checks authoring-level rules (including `category_label_required` when a dynamic category lacks bilingual labels, `packages/workflow-engine/src/validate.ts:78-80`), lowers shorthand forms, validates the resulting graph, checks expressions, references, and prompt reachability (`ref_may_not_run`, `packages/workflow-engine/src/validate.ts:309-313`), then checks node contracts, `subworkflow.with` bare `$ref` inputs and edge-exact incoming `with` delivery (`subworkflow_input`, `packages/workflow-engine/src/validate.ts:484-514`), `lp.propose_workflow` actions (`propose_workflow_missing` and `propose_workflow_input`, `packages/workflow-engine/src/validate.ts:523-546`), and node-specific constraints. Node-level model fields are accepted for older definitions but are ignored and reported with a `model_ignored` warning because the model belongs to the role (`packages/workflow-engine/src/validate.ts:401-402`). It also checks literal specialist IDs when a lookup is supplied (`packages/workflow-engine/src/validate.ts:406-408`). `promptCoverageProblems` warns when produced-artifact enum values are absent from the agent prompt and generated output contract (`packages/workflow-engine/src/prompt-coverage.ts:21-31`, `packages/workflow-engine/src/validate.ts:413`). It returns diagnostics with `error` or `warning` levels (`packages/workflow-engine/src/validate.ts:67-555`).
3. Expression strings are tokenized and parsed into an AST; structured conditions are converted to that same AST. Static checking collects reference/type diagnostics, while runtime evaluation returns a value or throws `MissingValueError` (`packages/workflow-engine/src/expr.ts:10-155`, `packages/workflow-engine/src/expr.ts:204-321`).
4. `loadWorkflowStore` reads built-ins and configured files, excludes per-definition failures, selects the highest-ranked remaining definition per ID, then validates references against that selected set (`packages/workflow-engine/src/store.ts:50`).
5. The store exposes only its final map through `list`, `get`, and version-aware `resolve`; source and validation problems remain available in `problems` (`packages/workflow-engine/src/store.ts:95-103`).

## Modes and outcomes

| Branch | Condition | Result or failure |
|---|---|---|
| Expression source | A string enters `parseExpr`; a structured `Condition` enters `conditionToExpr` | Both become an `Expr` AST. Tokenization or parsing failures throw `ExprSyntaxError`; validation catches these at `parseOrReport` and reports `bad_expr` (`packages/workflow-engine/src/expr.ts:34-54`, `packages/workflow-engine/src/expr.ts:72-155`, `packages/workflow-engine/src/validate.ts:248-250`). |
| Reference scope | Explicit `$inputs`, `$mode`, `input`, `ctx`, `item`, `index`, or run variable; otherwise `itemScope` decides between item and node reference | `refOf` returns a typed reference descriptor; it does not check that the referenced node or field exists (`packages/workflow-engine/src/expr.ts:57-69`). |
| Store source read | Directory missing, list/read succeeds, or listing/reading throws | Missing directories are governed by the file source; caught list/read exceptions become source problems and processing continues (`packages/workflow-engine/src/store.ts:61-68`). |
| Per-definition load | Syntax/schema/local graph checks pass or fail | Failed definitions add their problems and are excluded before precedence selection (`packages/workflow-engine/src/store.ts:74-79`, `packages/workflow-engine/src/validate.ts:560-573`). |
| Merged-reference check | Selected definition resolves all subworkflow references or has an error | Errors add problems and exclude that ID; the store does not retry with a lower-ranked definition (`packages/workflow-engine/src/store.ts:81-93`). |
| Static expression check | A reference or operator has known or unknown field types | Problems accumulate in the supplied array and a best-effort `Typed` result is still returned; unknown `any` types suppress some incompatibility diagnostics (`packages/workflow-engine/src/expr.ts:204-275`). |
| Runtime expression | Reference exists; operator operands have supported shapes | Evaluation returns a value, returns false for nonnumeric ordering or `in` with a non-array right side, or throws `condition_field_missing` / `condition_type` (`packages/workflow-engine/src/expr.ts:289-319`). |
| Template mode | A sole-key `{by_mode: ...}` object has a mode or lacks one | Current mode value is selected, otherwise `default`; null mode throws `mode_missing`, and a missing fallback resolves to `undefined` (`packages/workflow-engine/src/expr.ts:367-371`). |

## Business rules

- `conditionSchema` accepts a strict field/operator/value leaf, strict recursive `all` and `any` arrays of 1–20 conditions, or a strict recursive `not`; `whenSchema` also accepts a nonempty expression string up to 600 characters (`packages/workflow-engine/src/schema.ts:56-63`).
- `nodeSchema` dispatches on `type` to agent, lp-task, action, decision, human, parallel, join, subworkflow, or note schemas. Each branch is strict; the child schema permits agent, lp-task, action, or subworkflow and has no authoring `id`; lowering assigns the generated child ID (`packages/workflow-engine/src/schema.ts:186-235`, `packages/workflow-engine/src/lower.ts:66-115`).
- `edgeSchema` requires nonempty `from` and `to` strings up to 48 characters; `when` is optional; `label` is optional and capped at 80 characters; `with` maps strings to strings; `pass` defaults to `artifact`; extra fields fail parsing (`packages/workflow-engine/src/schema.ts:241-249`).
- `consumesSchema` requires an artifact kind and integer version 1–99, defaults `required` to true, and permits optional `from` and `as` (`packages/workflow-engine/src/schema.ts:82-88`). Its strict shape check does not prove the artifact exists or that its source produces it; `validateWorkflow` checks those relations (`packages/workflow-engine/src/validate.ts:350-389`).
- `category` accepts built-in IDs from `BUILTIN_WORKFLOW_CATEGORIES` or slugs matching `categorySlugSchema`; `normalizeWorkflow` promotes bare string categories and labels, and `validateWorkflow` enforces bilingual `{ en, ru }` labels for dynamic categories via `category_label_required` (`packages/workflow-engine/src/schema.ts:23-26`, `packages/workflow-engine/src/schema.ts:275`, `packages/workflow-engine/src/schema.ts:447-450`, `packages/workflow-engine/src/validate.ts:78-80`).
- `refOf` maps `$inputs` and `input` to input paths, `$mode` to a mode reference, `ctx` to context, `item` and `index` to loop references, and `date`, `run_id`, and `slug` to run variables. Bare names are item paths only when `itemScope` is enabled; otherwise they name workflow nodes (`packages/workflow-engine/src/expr.ts:26-28`, `packages/workflow-engine/src/expr.ts:57-69`).
- Parser precedence is unary `!`, arithmetic `+`/`-`, one comparison or `in`, repeated `&&`, then repeated `||`; parentheses recurse to the full expression parser (`packages/workflow-engine/src/expr.ts:80-130`).
- A node reference must name an existing node before the point being checked. Known output fields are resolved through `fieldPath`; unknown output schemas and unresolvable nested JSON paths return `any`, while invalid known paths append a problem and also return `any` (`packages/workflow-engine/src/expr.ts:193-202`, `packages/workflow-engine/src/expr.ts:204-240`).
- `validateWorkflow` treats errors as unusable definitions and warnings as diagnostics that do not make `loadWorkflow` return `ok: false` (`packages/workflow-engine/src/validate.ts:560-573`).
- `budget.maxSteps` is accepted for compatibility but ignored with a `budget_max_steps_ignored` warning; the runtime budget contract is described in [Workflow Execution Engine](execution-engine.md) (`packages/workflow-engine/src/validate.ts:73-77`).
- Store precedence is project over global over built-in. Per-definition failures are removed before precedence; merged resolver failures remove the selected ID after precedence (`packages/workflow-engine/src/store.ts:71-90`).

## Public API

| Export | Purpose |
|---|---|
| `refOf`, `parseExpr`, `conditionToExpr`, `toExpr` | Convert reference text or condition input to expression descriptors and ASTs (`packages/workflow-engine/src/expr.ts:57-155`). |
| `checkRef`, `checkExpr`, `evalExpr`, `evalCondition`, `renderValue` | Statically check references and expressions; evaluate ASTs and templates (`packages/workflow-engine/src/expr.ts:204-321`, `packages/workflow-engine/src/expr.ts:354-375`). |
| `conditionSchema`, `consumesSchema`, `edgeSchema`, `nodeSchema` | Parse the corresponding workflow definition shapes (`packages/workflow-engine/src/schema.ts:56-63`, `packages/workflow-engine/src/schema.ts:82-88`, `packages/workflow-engine/src/schema.ts:201-249`). |
| `validateWorkflow`, `loadWorkflow`, `parseWorkflow` | Return validation diagnostics, a success/failure load result, or throw `WorkflowError` (`packages/workflow-engine/src/validate.ts:22-26`, `packages/workflow-engine/src/validate.ts:560-580`). |
| `artifactEnums`, `promptCoverageProblems` | Read enum vocabularies from registered artifact schemas and report values not named in an agent prompt or its generated output contract; both are exported from the `prompt` coverage entry point (`packages/workflow-engine/src/prompt-coverage.ts:10-31`, `packages/workflow-engine/src/index.ts:23`). |
| `loadWorkflowStore` | Merge built-in, global, and project definitions and provide lookup methods (`packages/workflow-engine/src/store.ts:50-104`). |

## Declaration details

### `parseExpr` and `conditionToExpr`

`parseExpr` tokenizes numbers, quoted strings, identifiers, and operators. Its primary parser handles literals, parenthesized expressions, lists, booleans, null, `visits(node)`, and references. Bare words inside lists become string literals except booleans, null, `visits`, dotted names, and `$` names, which go through expression parsing. The parser then applies the precedence layers and rejects trailing tokens (`packages/workflow-engine/src/expr.ts:80-130`).

An invalid character, missing delimiter, malformed `visits` argument, unexpected token, or leftover token throws `ExprSyntaxError` with an offset. In `validateWorkflow`, the `parseOrReport` wrapper turns that exception into a `bad_expr` problem instead of aborting the validation pass (`packages/workflow-engine/src/expr.ts:41-53`, `packages/workflow-engine/src/expr.ts:78-130`, `packages/workflow-engine/src/validate.ts:248-250`).

`conditionToExpr` recursively combines `all` with `&&`, `any` with `||`, and `not` with unary negation. Leaf fields become references on the supplied source node; `eq`, `ne`, ordering, and `in` map to their expression operators. `exists` compares with null, negating the equality when its value is false. `toExpr` chooses parsing for string conditions and conversion for structured conditions (`packages/workflow-engine/src/expr.ts:134-155`).

### `checkRef` and `checkExpr`

`checkRef` returns enum for `$mode` and records a problem if the environment has no mode; run variables are strings, `index` is a number, and `item` is `any`. Context references are checked against `CTX_VARS`. Input paths use declared input fields. Node references report unknown nodes and forward references, then resolve declared output paths; missing known fields add a problem (`packages/workflow-engine/src/expr.ts:204-240`).

`checkExpr` walks every AST variant. Literals infer primitive types; `visits` is numeric and reports unknown node names; `not`, logical operators, and comparisons return boolean; lists return array; arithmetic returns number. Arithmetic and ordering report known non-number operands. `in []`, array equality, enum values outside a declared set, and incompatible non-`any` types also add diagnostics. Checking accumulates problems without throwing for these ordinary invalid expressions (`packages/workflow-engine/src/expr.ts:243-275`).

### `evalExpr`

Evaluation returns literal values, visit counts, mapped list values, or a boolean negation. A reference calls `env.read`; `ran: false` throws `MissingValueError` with `condition_field_missing`. `&&` and `||` evaluate the right side only when needed and convert operands with the workflow truth rule, where every array including an empty one is true (`packages/workflow-engine/src/expr.ts:285`, `packages/workflow-engine/src/expr.ts:289-302`).

Other binary operations evaluate both operands. Equality uses strict equality, treats undefined/null/empty string as equivalent blanks, and compares non-null objects by JSON serialization. `in` tests equality against array members and returns false when the right side is not an array. `+` and `-` throw `condition_type` unless both operands are numbers. Ordering comparisons return false if either operand is not numeric (`packages/workflow-engine/src/expr.ts:286-287`, `packages/workflow-engine/src/expr.ts:303-315`).

### `renderValue`

For a string consisting of one `{{ref}}`, `renderValue` returns the resolved value with its original type. For text containing placeholders, it substitutes strings directly, JSON-serializes other non-null values, and writes null or undefined as empty text. A missing reference in an embedded placeholder therefore becomes empty text; a missing placeholder in a list is removed when the recursively rendered array filters undefined entries (`packages/workflow-engine/src/expr.ts:354-364`). `valueSpecOf` and `evalSpec` also classify and render mixed-placeholder strings via `{ template }` and `renderValue` (`packages/workflow-engine/src/expr.ts:329-351`).

Arrays and ordinary objects recurse into their values. An object containing only `by_mode` chooses the exact mode key when present, otherwise `default`, then recursively renders that value. A null mode throws `MissingValueError` with `mode_missing`; if the selected key and default are both absent, the result is undefined. Read callback errors are not caught in this function (`packages/workflow-engine/src/expr.ts:364-375`).

### `validateWorkflow`

The validator first checks authoring form, including a warning when legacy `budget.maxSteps` is present and an error when a dynamic category omits bilingual labels, then checks reserved and duplicate IDs, entry declarations, duplicate input/output/node fields, schedule warnings, emit requirements, and parallel child/join combinations. See [Workflow Definitions and Validation](definitions-validation.md) for the budget and category contracts (`packages/workflow-engine/src/validate.ts:67-125`).

It lowers the definition and checks edge endpoints, sentinel direction, note-node edges, one unconditional entry, an exit, dead ends, conditional branch shape, parallel edge conditions, and fallback warnings (`packages/workflow-engine/src/validate.ts:160-203`).

The expression pass parses edge conditions, mappings, node templates, `skip_when`, `skip_out`, action emit specs, and declared reads. It records references so that skips have outputs for fields their consumers read. Parsing failures become `bad_expr`; item/index references outside a `for_each` branch and invalid reference/type paths become diagnostics (`packages/workflow-engine/src/validate.ts:205-322`).

It then warns (`ref_may_not_run`) if an agent prompt reads `{{node.field}}` while any path from `$start` reaches it without running `node`, rejects unbounded graph cycles unless a loop node has `maxVisits` or an internal edge condition counts visits to a node in that cycle, checks that skippable nodes provide the fields read by downstream nodes, and validates artifact producer/consumer relations and output gates (`packages/workflow-engine/src/validate.ts:309-389`).

The node pass checks configured executor availability, warns about ignored node-level model fields, and checks agent environment and prompt rules, contracts, human defaults, decision source/order/type compatibility, parallel list/filter/join shape, bare `$ref` values in `subworkflow.with`, edge-exact incoming `with` mappings for required child inputs, `lp.propose_workflow` actions, and subworkflow input/output mappings. With a resolver, it also checks subworkflow cycles and caps depth at the smaller of the workflow guard and `MAX_SUBWORKFLOW_DEPTH`. Diagnostics are returned together; `loadWorkflow` fails only when at least one is an error (`packages/workflow-engine/src/validate.ts:392-553`, `packages/workflow-engine/src/validate.ts:560-573`).

### `loadWorkflowStore`

The store starts with built-ins, then lists and reads configured global and project directories. Listing and reading exceptions are recorded against their source while other sources continue loading. `loadWorkflow` applies syntax, schema, and checks that need no other workflow; failed entries are recorded and excluded (`packages/workflow-engine/src/store.ts:58-77`).

Remaining definitions are sorted by origin rank and inserted by workflow ID, so the narrower source replaces the wider one. The second pass validates each selected definition with a resolver backed by that merged map. An error excludes the chosen ID and records its issues; it does not restore a shadowed definition. `resolveStatus`, when provided, can replace the workflow status and append its notes to warnings (`packages/workflow-engine/src/store.ts:79-93`).

The returned `list` reads final values, `get` reads by ID, and `resolve` additionally enforces an optional version. Missing IDs or version mismatches return null. `problems` exposes read and validation problems accumulated during both passes (`packages/workflow-engine/src/store.ts:95-103`).

## Gotchas

- `refOf` classifies a name but does not validate it; `checkRef` checks node existence, order, and fields against `CheckEnv` (`packages/workflow-engine/src/expr.ts:57-69`, `packages/workflow-engine/src/expr.ts:203-230`).
- Static checking can return `any` after adding a problem, so callers must inspect the diagnostics array as well as the inferred type (`packages/workflow-engine/src/expr.ts:213-230`, `packages/workflow-engine/src/expr.ts:252-263`).
- Merged-reference errors exclude the selected store entry after precedence; lower-ranked definitions are not reconsidered (`packages/workflow-engine/src/store.ts:81-93`).

## Related pages

- [Workflow Definitions and Validation](definitions-validation.md)
- [Expression Parsing and Conditions](expression-parsing.md)
- [Workflow Store Loading and Validation](workflow-store-loading.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Definitions and Validation](definitions-validation.md)
