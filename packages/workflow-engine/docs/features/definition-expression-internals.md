---
title: Workflow Definition and Expression Internals
type: component
created: 2026-10-27
updated: 2026-11-07
status: active
confidence: medium
tags: [workflow-engine, expressions, validation, schema]
sources:
  - packages/workflow-engine/src/expr.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/lower.ts
---
# Workflow Definition and Expression Internals
TL;DR: This page traces how workflow expressions and structured conditions become checked and evaluated values, and how definitions pass through local and merged-store validation.

## Purpose

The authoring overview is in [Workflow Definitions and Validation](definitions-validation.md). This page gives the detailed branches and failure behavior of its parser, expression checker/evaluator, schemas, validator, and store loader.

## How it works

### Reference classification: `refOf`

1. Split reference text on dots into a head and remaining path.
2. Classify `$inputs` and `input` as workflow inputs; `$mode` as quality mode; `ctx` as context; `item` and `index` as loop values; and bare `date`, `run_id`, or `slug` as run variables.
3. If no reserved form matched, `itemScope: true` makes the entire split path a current-item reference; otherwise the head is a workflow node and the rest is its output path (`packages/workflow-engine/src/expr.ts:57-69`).

`refOf` only classifies names; `checkRef` checks the resulting reference against `CheckEnv`, including node existence, execution order, and declared fields (`packages/workflow-engine/src/expr.ts:203-230`).

| Reference form | Classified result | Classification outcome |
|---|---|---|
| `$inputs.x` or `input.x` | Input path after the head | An empty path is still classified as input; `checkRef` returns `any` for it (`packages/workflow-engine/src/expr.ts:60-63`, `packages/workflow-engine/src/expr.ts:213-218`). |
| `$mode`, `ctx.x`, `item.x`, `index` | Mode, context, item, or index reference | `$mode` and `index` discard any suffix; `ctx` and `item` keep their remaining path (`packages/workflow-engine/src/expr.ts:61-65`). |
| Bare `date`, `run_id`, or `slug` | Run variable | Only an exact run-variable head with no remaining path takes this branch (`packages/workflow-engine/src/expr.ts:25-28`, `packages/workflow-engine/src/expr.ts:28`). |
| Other name with `itemScope: true` | Current-item path | The full dotted path is retained as an item reference (`packages/workflow-engine/src/expr.ts:67`). |
| Other name without item scope | Node reference | The first segment becomes node ID and the rest is its output path (`packages/workflow-engine/src/expr.ts:68`). |

The classifier `refOf` does not throw for an unknown bare name; it returns a node reference (`packages/workflow-engine/src/expr.ts:57-69`), leaving existence and field errors for `checkRef` (`packages/workflow-engine/src/expr.ts:203-230`).

### Parsing: `parseExpr`

1. Tokenize the expression and keep a cursor into the token list. Each parser layer consumes the tokens belonging to its precedence level (`packages/workflow-engine/src/expr.ts:34-54`, `packages/workflow-engine/src/expr.ts:72-79`).
2. Parse primaries as numeric/string literals, parenthesized expressions, lists, booleans, null, `visits(node)`, or references. Inside a list, an unqualified bare identifier other than `true`, `false`, `null`, and `visits` is a string literal; dotted and `$` names are parsed as expressions (`packages/workflow-engine/src/expr.ts:80-110`).
3. Apply unary `!`, then repeated `+`/`-`, one comparison or `in`, repeated `&&`, then repeated `||`. Parentheses recurse through the full `or` parser, so they override this precedence (`packages/workflow-engine/src/expr.ts:112-126`).
4. Require the cursor to reach the end token. Any leftover token raises `ExprSyntaxError`; primary parsing, missing delimiters, malformed `visits(...)`, and tokenization can raise the same syntax error with an offset (`packages/workflow-engine/src/expr.ts:41-54`, `packages/workflow-engine/src/expr.ts:78-130`).

The parser returns an AST, not a value and not a validation verdict. `validateWorkflow` catches expression parse errors at its `parseOrReport` boundary and records a `bad_expr` diagnostic (`packages/workflow-engine/src/validate.ts:244`).

Primary parsing branches on token kind and value:

| Input token | AST or result | Failure branch |
|---|---|---|
| Number or quoted string | Literal `lit` with numeric or decoded string value (`packages/workflow-engine/src/expr.ts:80-83`). | Tokenization failures throw `ExprSyntaxError` with the source offset (`packages/workflow-engine/src/expr.ts:34-54`). |
| `(` expression `)` | Parses the full `or` expression, then requires `)` (`packages/workflow-engine/src/expr.ts:84`). | Missing closing delimiter throws at the current token offset (`packages/workflow-engine/src/expr.ts:78`, `packages/workflow-engine/src/expr.ts:84`). |
| `[items]` | Builds a list AST. Unqualified bare words other than `true`, `false`, `null`, and `visits` become string literals; other entries parse as expressions (`packages/workflow-engine/src/expr.ts:85-96`). | Missing `]` or malformed item syntax throws `ExprSyntaxError` (`packages/workflow-engine/src/expr.ts:87-95`). |
| `true`, `false`, `null` | Boolean or null literal (`packages/workflow-engine/src/expr.ts:97-100`). | No special failure. |
| `visits(id)` | Visit-count AST; the argument must be an identifier or quoted string (`packages/workflow-engine/src/expr.ts:101-107`). | Wrong argument kind or missing `)` throws `ExprSyntaxError` with offset (`packages/workflow-engine/src/expr.ts:103-106`). |
| Other identifier | Reference AST classified by `refOf` and `itemScope` (`packages/workflow-engine/src/expr.ts:108-109`). | Any other primary token, including end of input, throws `ExprSyntaxError` as unexpected (`packages/workflow-engine/src/expr.ts:110`). |

After primary parsing, precedence is unary `!`, repeated `+`/`-`, one comparison or `in`, repeated `&&`, and repeated `||`. Comparison chaining is therefore not consumed as one comparison expression; the remaining token causes the final end-token check to fail (`packages/workflow-engine/src/expr.ts:112-130`).

### Structured conditions: `conditionToExpr`

How `conditionToExpr` works (`packages/workflow-engine/src/expr.ts:134-153`):
1. **Compound groups**: If `all` is present, recursively converts each child and reduces them into left-associated `&&` binary nodes (`packages/workflow-engine/src/expr.ts:135`). If `any` is present, reduces children into left-associated `||` binary nodes (`packages/workflow-engine/src/expr.ts:136`). If `not` is present, wraps the child in unary `{ t: "not", e: ... }` (`packages/workflow-engine/src/expr.ts:137`).
2. **Leaf conversion**: Splits `condition.field` on dots and creates a node reference rooted at `source` (`packages/workflow-engine/src/expr.ts:138-139`).
Converts array values into `{ t: "list", items }` and scalar values into `{ t: "lit", v }` (`packages/workflow-engine/src/expr.ts:140`).
3. **Operator translation**:
   - `exists`: if `condition.value === false`, outputs `not (ref == null)`; otherwise outputs `ref != null` (`packages/workflow-engine/src/expr.ts:142`).
   - `eq`: outputs `ref == value` (`packages/workflow-engine/src/expr.ts:143`).
   - `ne`: outputs `ref != value` (`packages/workflow-engine/src/expr.ts:144`).
   - `gt`, `gte`, `lt`, `lte`: output numeric comparison expressions (`packages/workflow-engine/src/expr.ts:145-148`).
   - `in`: outputs `ref in value` (`packages/workflow-engine/src/expr.ts:149`).
   - Default negation: outputs `not (ref in value)` (`packages/workflow-engine/src/expr.ts:150`).
- **Conditions and modes**: Distinguishes compound groups from leaf comparisons (`packages/workflow-engine/src/expr.ts:141-151`).
- **Outcomes and failures**: Returns an executable `Expr` AST without evaluating types; reference and type validation are deferred to `checkExpr` (`packages/workflow-engine/src/expr.ts:134-153`).

### Static checking: `checkExpr`

How `checkExpr` works (`packages/workflow-engine/src/expr.ts:234-269`):
1. **Primary node checking**:
   - Literals infer `number`, `bool`, `string`, or `any` (`packages/workflow-engine/src/expr.ts:236`).
   - References delegate to `checkRef(expr.ref, env, problems, at)` (`packages/workflow-engine/src/expr.ts:237`).
   - `visits`: calls `env.nodeExists`, appending a problem if unknown, and returns `number` (`packages/workflow-engine/src/expr.ts:238`).
   - `not`: checks child `e` and returns `bool` (`packages/workflow-engine/src/expr.ts:239`).
   - `list`: checks every item and returns `array` (`packages/workflow-engine/src/expr.ts:240`).
2. **Binary operand inspection**: Evaluates `left = checkExpr(expr.l)` and `right = checkExpr(expr.r)` (`packages/workflow-engine/src/expr.ts:242`).
3. **Operator rules and problem collection**:
   - `&&` and `||`: return `bool` (`packages/workflow-engine/src/expr.ts:243`).
   - `+` and `-`: verify each side is numeric, appending problems on mismatch, and return `number` (`packages/workflow-engine/src/expr.ts:244-247`).
   - Relational comparisons (`<`, `<=`, `>`, `>=`): verify numeric operands and return `bool` (`packages/workflow-engine/src/expr.ts:248-251`).
   - `in`: rejects empty literal lists (`in [] never matches`) (`packages/workflow-engine/src/expr.ts:252`).
   - `==` and `!=`: reject list comparisons (`packages/workflow-engine/src/expr.ts:253`).
   - Enum validation: checks literal values against allowed enum `values` (`packages/workflow-engine/src/expr.ts:254-258`).
   - Incompatible types: appends diagnostics for mismatched types other than enum-string comparisons (`packages/workflow-engine/src/expr.ts:259-262`).
- **Conditions and modes**: Accommodates `any` operands to suppress cascading diagnostics while continuing branch inspection (`packages/workflow-engine/src/expr.ts:235-264`).
- **Outcomes and failures**: Returns an inferred `Typed` descriptor; appends human-readable diagnostics to `problems` without throwing exceptions (`packages/workflow-engine/src/expr.ts:234-266`).

`checkRef` adds an error for unavailable `$mode`, unknown context names, absent input/output paths, unknown nodes, and forward references. When a field path cannot be determined, it adds the problem and returns `any`; an unknown output schema also returns `any` without a problem (`packages/workflow-engine/src/expr.ts:203-230`). Callers must inspect diagnostics as well as the returned type.

Its branch order is:

1. Mode returns the `quick|standard|full` enum and reports a problem only when the environment says mode is unavailable; run variables, index, and item return string, number, and any respectively (`packages/workflow-engine/src/expr.ts:205-208`).
2. Context checks the first path segment against `CTX_VARS`; unknown names add a diagnostic. `ctx.merged_commits` is typed as an array and other context values as `any` (`packages/workflow-engine/src/expr.ts:209-212`).
3. Input with an empty path returns `any`; otherwise `fieldPath` resolves declared input fields. A path error is appended and returns `any` (`packages/workflow-engine/src/expr.ts:213-218`).
4. Node references report an unknown node and return `any`; known nodes are checked for execution order. A root reference or unknown/null output fields returns `any`; a bad declared path reports a diagnostic and returns `any`, while a valid path returns its field type (`packages/workflow-engine/src/expr.ts:219-230`).

### Runtime evaluation: `evalExpr` and `evalCondition`

1. Literals return their value, `visits` calls the environment counter, lists evaluate each item, and `not` negates the workflow truth rule. A reference calls `env.read`; `ran: false` throws `MissingValueError` with code `condition_field_missing` (`packages/workflow-engine/src/expr.ts:276-289`).
2. `&&` and `||` short-circuit through `truthy`. Arrays, including empty arrays, count as true; other values use `Boolean` conversion (`packages/workflow-engine/src/expr.ts:276`, `packages/workflow-engine/src/expr.ts:291-294`).
3. Equality and inequality use strict equality, treat `undefined`, `null`, and `""` as equivalent blanks, and compare non-null objects by JSON serialization. `in` checks array members with the same equality rule and returns false when the right side is not an array (`packages/workflow-engine/src/expr.ts:277-278`, `packages/workflow-engine/src/expr.ts:278`).
4. Addition and subtraction require two numbers or throw `MissingValueError` with `condition_type`. Ordering comparisons return false for non-numeric operands; otherwise they apply the requested numeric comparison (`packages/workflow-engine/src/expr.ts:299-306`).

`evalExpr` returns the branch value or throws on a missing reference or invalid arithmetic. `evalCondition` converts that value through the same truth rule and returns a boolean; evaluation errors propagate (`packages/workflow-engine/src/expr.ts:280-312`).

| AST branch | Evaluation | Outcome or failure |
|---|---|---|
| Literal, `visits`, list | Return the literal, call `env.visits`, or evaluate each item in order (`packages/workflow-engine/src/expr.ts:281-285`). | Visit callback errors propagate; list element errors stop evaluation. |
| Reference | Call `env.read` (`packages/workflow-engine/src/expr.ts:286-290`). | `ran: false` throws `condition_field_missing`; a read marked as run returns its value, including `undefined` (`packages/workflow-engine/src/expr.ts:287-289`). |
| `not`, `&&`, `||` | Negate or short-circuit using workflow truth, where any array including `[]` is true (`packages/workflow-engine/src/expr.ts:271`, `packages/workflow-engine/src/expr.ts:284`, `packages/workflow-engine/src/expr.ts:288`). | The right side of `&&` runs only for a truthy left side; the right side of `||` runs only for a falsey left side. |
| Equality and membership | Compare with the shared equality function; `in` searches an array (`packages/workflow-engine/src/expr.ts:278`, `packages/workflow-engine/src/expr.ts:278`). | `undefined`, `null`, and `""` compare as blanks; non-null objects compare by JSON; `in` returns false when its right operand is not an array. |
| Arithmetic and ordering | Evaluate both operands before applying the operator (`packages/workflow-engine/src/expr.ts:294-306`). | `+`/`-` throw `condition_type` unless both values are numbers; ordering returns false for nonnumeric values. |

`evalCondition` is the boolean boundary: it applies `truthy` to the value returned by `evalExpr`, and does not catch `condition_field_missing`, `condition_type`, or callback errors (`packages/workflow-engine/src/expr.ts:312`).

### Value-position parsing: `valueSpecOf`

`valueSpecOf` returns non-strings unchanged as literals. For strings it trims outer whitespace, then checks in order: empty text; one complete `{{ref}}`; matching single/double quotes; JSON-looking array/object text; `true`, `false`, or `null`; a numeric literal; a bare identifier; a slash-containing path; and finally expression parsing (`packages/workflow-engine/src/expr.ts:321-336`).

Valid JSON-looking input becomes a literal. Invalid JSON-looking input falls through to `parseExpr`, as does any unclassified string; a parse error propagates as `ExprSyntaxError`. Quoted values lose their surrounding quote characters; bare words and recognized paths remain literal strings (`packages/workflow-engine/src/expr.ts:325-336`).

### Definition schemas

| Schema | Accepted branches and bounds | Failure behavior |
|---|---|---|
| `conditionSchema` / `whenSchema` | A strict `{field, op, value?}` leaf with a 1–120 character field and an operator from `CONDITION_OPS`; strict recursive `all` or `any` with 1–20 children; or strict recursive `not`. `whenSchema` also accepts a nonempty expression string up to 600 characters (`packages/workflow-engine/src/schema.ts:41-58`). | Zod rejects missing/extra keys, empty groups, more than 20 children, unsupported operators, and empty/overlong strings. Leaf `value` is optional and unrestricted at this structural layer (`packages/workflow-engine/src/schema.ts:51-58`). |
| `nodeSchema` | The `type` discriminator selects nine strict shapes (`packages/workflow-engine/src/schema.ts:194-228`). Agent supplies role/prompt/session settings; legacy model fields are accepted but ignored in favor of role-based selection; lp-task supplies contract and owned-path/stage settings; action supplies action/params/map; decision optionally names `reads_node`; human requires question and offers timeout options; parallel defines iteration/concurrency/child/join settings; join names its parallel and policy; subworkflow names an ID/version/input map; note carries text only (`packages/workflow-engine/src/schema.ts:101`, `packages/workflow-engine/src/schema.ts:194-228`). A parallel child has no authoring ID and is restricted to agent, lp-task, action, or subworkflow (`packages/workflow-engine/src/schema.ts:178-185`). | A missing/unknown discriminator or a field rejected by the selected strict schema fails parsing; graph-level relationships are checked later by `validateWorkflow` (`packages/workflow-engine/src/schema.ts:178-228`, `packages/workflow-engine/src/validate.ts:70-129`). |
| `consumesSchema` | Strict artifact declaration: lowercase artifact kind, integer version 1–99, `required` default true, optional `from` of 1–48 characters, and optional field-name `as` (`packages/workflow-engine/src/schema.ts:68-77`). | Zod rejects malformed shape and extra keys. It does not establish that the artifact is registered or that `from` produces it; graph checks add those errors (`packages/workflow-engine/src/validate.ts:307-333`). |

### `conditionSchema`

How `conditionSchema` works (`packages/workflow-engine/src/schema.ts:51-57`):
1. **Lazy union**: Uses `z.lazy` to permit recursive nesting of condition groups within conditions (`packages/workflow-engine/src/schema.ts:51`).
2. **Branch matching**: Validates four strict object shapes:
   - Leaf condition: requires `field` string (1–120 characters), `op` enum from `CONDITION_OPS`, and optional `value` (`packages/workflow-engine/src/schema.ts:52`).
   - `all` group: array of 1 to 20 recursive conditions (`packages/workflow-engine/src/schema.ts:53`).
   - `any` group: array of 1 to 20 recursive conditions (`packages/workflow-engine/src/schema.ts:54`).
   - `not` group: exactly one nested recursive condition (`packages/workflow-engine/src/schema.ts:55`).
- **Conditions and modes**: Strict object constraints reject unrecognized properties at each level (`packages/workflow-engine/src/schema.ts:52-56`).
- **Outcomes and failures**: Successful validation yields a typed `Condition` AST. Zod throws validation errors for empty fields, unknown operators, or invalid child counts (`packages/workflow-engine/src/schema.ts:51-57`). `whenSchema` additionally accepts a non-empty expression string up to 600 characters (`packages/workflow-engine/src/schema.ts:58`).

`consumesSchema` parses a strict object in this order: required `kind` matching the artifact-name pattern; required integer `version` from 1 to 99; optional `required`, defaulting to true; optional nonempty `from` up to 48 characters; and optional field-name `as`. Zod rejects invalid values and unknown keys; registry existence, source production, and execution order are separate `validateWorkflow` checks (`packages/workflow-engine/src/schema.ts:68-77`, `packages/workflow-engine/src/validate.ts:320`).

### Workflow validation: `validateWorkflow`

How `validateWorkflow` works (`packages/workflow-engine/src/validate.ts:67-126`):
1. **Budget inspection**: Checks `workflow.budget`, warning on missing wall-time bounds or ignored step counts (`packages/workflow-engine/src/validate.ts:73-77`).
2. **Node ID integrity**: Rejects reserved identifiers and duplicate node IDs (`packages/workflow-engine/src/validate.ts:81-86`).
3. **Entry point validation**: Validates `workflow.entry` and entry edge conflicts (`packages/workflow-engine/src/validate.ts:87-88`).
4. **Duplicate field checking**: Verifies no duplicate field names exist within inputs, outputs, and node out fields (`packages/workflow-engine/src/validate.ts:89-100`).
5. **Trigger validation**: Inspects schedule triggers, calling `cronProblem` to check cron expressions (`packages/workflow-engine/src/validate.ts:95-99`).
6. **Emit node validation**: Validates emit nodes for required outputs, allowed status values, and no outgoing edges (`packages/workflow-engine/src/validate.ts:101-114`).
7. **Parallel structure**: Verifies child, join, and for_each constraints on parallel nodes (`packages/workflow-engine/src/validate.ts:115-121`).
- **Conditions and modes**: Evaluates authoring-level syntax, schedule triggers, emit nodes, and parallel constructs (`packages/workflow-engine/src/validate.ts:80-122`).
- **Outcomes and failures**: Accumulates `WorkflowProblem` entries with error or warning level without throwing (`packages/workflow-engine/src/validate.ts:68-71`).

Following these authoring checks, the validator lowers shorthand and checks endpoints, sentinels, entry and exit counts, reachability, branch shape, and conditional-route fallback (`packages/workflow-engine/src/validate.ts:124-168`). It parses expressions/templates and verifies reference scope/order/types, checks bounded cycles, values supplied by skipped nodes, and artifact producer/consumer/gate contracts (`packages/workflow-engine/src/validate.ts:170-346`). Finally it checks executor availability when configured, specialist existence (`packages/workflow-engine/src/validate.ts:395-397`), prompt coverage (`packages/workflow-engine/src/validate.ts:402-404`), and subworkflow recursion/depth (`packages/workflow-engine/src/validate.ts:488-493`).

### `loadWorkflow`

1. If `source` is a string, parse it as JSONC with trailing commas enabled. Syntax errors return `{ok:false}` with `syntax` problems containing parse-code and offset; non-string input skips this stage (`packages/workflow-engine/src/validate.ts:499-505`).
2. Pass the resulting value to `parseWorkflowObject`. Schema failure returns `{ok:false}` with each Zod issue converted to a `schema` problem and a dotted path (`packages/workflow-engine/src/validate.ts:506-509`).
3. Run `validateWorkflow` on the normalized definition. If any problem is level `error`, return all problems as `{ok:false}`; otherwise return `{ok:true, workflow, warnings}`, including an empty warnings list when there are no warnings (`packages/workflow-engine/src/validate.ts:510-512`).
4. `parseWorkflow` is the throwing wrapper: it returns the workflow for an `ok` result or throws `WorkflowError` with the problem list (`packages/workflow-engine/src/validate.ts:514-519`).

| Source and check result | `loadWorkflow` result | `parseWorkflow` result |
|---|---|---|
| Object or valid JSONC parsed by `parseJsonc`; no validation errors | `ok: true`, workflow plus warnings | Returns workflow (`packages/workflow-engine/src/validate.ts:503`). |
| JSONC syntax error | `ok: false`, `syntax` problems | Throws `WorkflowError` (`packages/workflow-engine/src/validate.ts:501-505`, `packages/workflow-engine/src/validate.ts:515-519`). |
| Structural schema error | `ok: false`, `schema` problems | Throws `WorkflowError` (`packages/workflow-engine/src/validate.ts:506-509`, `packages/workflow-engine/src/validate.ts:515-519`). |
| Validation errors only or mixed with warnings | `ok: false`, all validation problems | Throws `WorkflowError` (`packages/workflow-engine/src/validate.ts:514`, `packages/workflow-engine/src/validate.ts:515-519`). |
| Warning-only validation | `ok: true`, warnings retained | Returns workflow; warnings are not thrown (`packages/workflow-engine/src/validate.ts:510-512`). |

### Merged sources: `loadWorkflowStore`

1. Convert built-ins to raw entries, then list/read configured global and project sources. Missing directory options are skipped; listing and per-file read exceptions become source problems, while processing continues (`packages/workflow-engine/src/store.ts:58-68`).
2. First-pass each raw entry with `loadWorkflow` without a subworkflow resolver. Failed entries are recorded and excluded; successful entries retain warnings and receive a content hash (`packages/workflow-engine/src/store.ts:71-78`).
3. Sort successful entries by origin rank and assign them by workflow ID, so narrower origins replace broader ones. Resolve subworkflow references against that merged map, including optional version matching (`packages/workflow-engine/src/store.ts:39`, `packages/workflow-engine/src/store.ts:79-85`).
4. Validate each selected entry again. An error records problems and removes that ID without restoring a shadowed lower-ranked definition. A passing entry may receive a status and notes from `resolveStatus` (`packages/workflow-engine/src/store.ts:86-94`).
5. Return snapshot-style `list`, nullable `get`, version-aware nullable `resolve`, and accumulated read/validation `problems` (`packages/workflow-engine/src/store.ts:95-103`).

Failures in listing/reading affect only the affected source/file; per-definition failures do not enter precedence selection. Merged-reference failures occur after selection and therefore leave the ID absent rather than falling back (`packages/workflow-engine/src/store.ts:63-68`, `packages/workflow-engine/src/store.ts:74-90`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Definitions and Validation](definitions-validation.md)
