---
title: Workflow Definition and Expression Internals
type: component
created: 2026-10-27
updated: 2026-10-28
status: active
confidence: high
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
| Bare `date`, `run_id`, or `slug` | Run variable | Only an exact run-variable head with no remaining path takes this branch (`packages/workflow-engine/src/expr.ts:25-28`, `packages/workflow-engine/src/expr.ts:66`). |
| Other name with `itemScope: true` | Current-item path | The full dotted path is retained as an item reference (`packages/workflow-engine/src/expr.ts:67`). |
| Other name without item scope | Node reference | The first segment becomes node ID and the rest is its output path (`packages/workflow-engine/src/expr.ts:68`). |

The classifier does not throw for an unknown bare name; it returns a node reference, leaving existence and field errors for `checkRef` (`packages/workflow-engine/src/expr.ts:57-69`, `packages/workflow-engine/src/expr.ts:219-228`).

### Parsing: `parseExpr`

1. Tokenize the expression and keep a cursor into the token list. Each parser layer consumes the tokens belonging to its precedence level (`packages/workflow-engine/src/expr.ts:34-54`, `packages/workflow-engine/src/expr.ts:72-79`).
2. Parse primaries as numeric/string literals, parenthesized expressions, lists, booleans, null, `visits(node)`, or references. Inside a list, an unqualified bare identifier other than `true`, `false`, `null`, and `visits` is a string literal; dotted and `$` names are parsed as expressions (`packages/workflow-engine/src/expr.ts:80-110`).
3. Apply unary `!`, then repeated `+`/`-`, one comparison or `in`, repeated `&&`, then repeated `||`. Parentheses recurse through the full `or` parser, so they override this precedence (`packages/workflow-engine/src/expr.ts:112-126`).
4. Require the cursor to reach the end token. Any leftover token raises `ExprSyntaxError`; primary parsing, missing delimiters, malformed `visits(...)`, and tokenization can raise the same syntax error with an offset (`packages/workflow-engine/src/expr.ts:41-54`, `packages/workflow-engine/src/expr.ts:78-130`).

The parser returns an AST, not a value and not a validation verdict. `validateWorkflow` catches expression parse errors at its `parseOrReport` boundary and records a `bad_expr` diagnostic (`packages/workflow-engine/src/validate.ts:212-214`).

Primary parsing branches on token kind and value:

| Input token | AST or result | Failure branch |
|---|---|---|
| Number or quoted string | Literal with numeric or decoded string value (`packages/workflow-engine/src/expr.ts:80-83`). | Tokenization failures throw `ExprSyntaxError` with the source offset (`packages/workflow-engine/src/expr.ts:34-54`). |
| `(` expression `)` | Parses the full `or` expression, then requires `)` (`packages/workflow-engine/src/expr.ts:84`). | Missing closing delimiter throws at the current token offset (`packages/workflow-engine/src/expr.ts:78`, `packages/workflow-engine/src/expr.ts:84`). |
| `[items]` | Builds a list AST. Unqualified bare words other than `true`, `false`, `null`, and `visits` become string literals; other entries parse as expressions (`packages/workflow-engine/src/expr.ts:85-96`). | Missing `]` or malformed item syntax throws `ExprSyntaxError` (`packages/workflow-engine/src/expr.ts:87-95`). |
| `true`, `false`, `null` | Boolean or null literal (`packages/workflow-engine/src/expr.ts:97-100`). | No special failure. |
| `visits(id)` | Visit-count AST; the argument must be an identifier or quoted string (`packages/workflow-engine/src/expr.ts:101-107`). | Wrong argument kind or missing `)` throws `ExprSyntaxError` with offset (`packages/workflow-engine/src/expr.ts:103-106`). |
| Other identifier | Reference AST classified by `refOf` and `itemScope` (`packages/workflow-engine/src/expr.ts:108-109`). | Any other primary token, including end of input, throws as unexpected (`packages/workflow-engine/src/expr.ts:110`). |

After primary parsing, precedence is unary `!`, repeated `+`/`-`, one comparison or `in`, repeated `&&`, and repeated `||`. Comparison chaining is therefore not consumed as one comparison expression; the remaining token causes the final end-token check to fail (`packages/workflow-engine/src/expr.ts:112-130`).

### Structured conditions: `conditionToExpr`

1. Recursively translate `all` children into left-associated `&&`, `any` children into left-associated `||`, and `not` into unary negation (`packages/workflow-engine/src/expr.ts:133-137`).
2. Convert a leaf's dotted `field` to a node reference rooted at the supplied `source`. Convert array values to expression list literals and scalar values to one literal (`packages/workflow-engine/src/expr.ts:138-140`).
3. Map `exists` to `!= null` (or `not == null` when its value is false); map `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, and `in` to the matching expression operator. The default branch represents not-in as `not (ref in list)` (`packages/workflow-engine/src/expr.ts:141-151`).

It returns an AST and does not resolve the source field. The schema constrains conditions to the listed operators and recursive shapes (`packages/workflow-engine/src/schema.ts:41-58`).

### Static checking: `checkExpr`

`checkExpr` visits each AST branch, accumulates problem strings in the caller's array, and returns a best-effort type for the whole expression (`packages/workflow-engine/src/expr.ts:233-266`).

| AST branch | Type result and checks |
|---|---|
| Literal, reference, `visits` | Primitive literal type, `checkRef` result, or number. An unknown `visits` node adds a problem while retaining type `number` (`packages/workflow-engine/src/expr.ts:236-238`). |
| `not`, list | Boolean after checking the child, or array after checking each element (`packages/workflow-engine/src/expr.ts:239-240`). |
| `&&`, `||` | Boolean; both operands are type-checked (`packages/workflow-engine/src/expr.ts:241-244`). |
| `+`, `-` | Number; each known operand must be numeric. `any` operands do not add a type error (`packages/workflow-engine/src/expr.ts:244-247`). |
| Ordering comparisons | Boolean; each known operand must be numeric. `any` is permitted (`packages/workflow-engine/src/expr.ts:248-251`). |
| `in` and equality | Boolean; empty-list membership, list equality, out-of-enum literals, and incompatible known operand types add problems. Enum/string comparison is allowed (`packages/workflow-engine/src/expr.ts:252-263`). |

`checkRef` adds an error for unavailable `$mode`, unknown context names, absent input/output paths, unknown nodes, and forward references. When a field path cannot be determined, it adds the problem and returns `any`; an unknown output schema also returns `any` without a problem (`packages/workflow-engine/src/expr.ts:203-230`). Callers must inspect diagnostics as well as the returned type.

Its branch order is:

1. Mode returns the `quick|standard|full` enum and reports a problem only when the environment says mode is unavailable; run variables, index, and item return string, number, and any respectively (`packages/workflow-engine/src/expr.ts:205-208`).
2. Context checks the first path segment against `CTX_VARS`; unknown names add a diagnostic. `ctx.merged_commits` is typed as an array and other context values as `any` (`packages/workflow-engine/src/expr.ts:209-212`).
3. Input with an empty path returns `any`; otherwise `fieldPath` resolves declared input fields. A path error is appended and returns `any` (`packages/workflow-engine/src/expr.ts:213-218`).
4. Node references report an unknown node and return `any`; known nodes are checked for execution order. A root reference or unknown/null output fields returns `any`; a bad declared path reports a diagnostic and returns `any`, while a valid path returns its field type (`packages/workflow-engine/src/expr.ts:219-230`).

`checkExpr` then walks the AST recursively. Literals infer their primitive type; references delegate to `checkRef`; `visits` is numeric but adds a problem for an unknown node; `not` and lists check their children and return bool/array (`packages/workflow-engine/src/expr.ts:234-240`). For binary expressions both operands are checked first. Logical operators return bool; arithmetic returns number and reports known nonnumeric operands; ordering returns bool and reports known nonnumeric operands; membership and equality return bool and report empty membership, list comparison, invalid enum literals, or incompatible known types. `any` suppresses some type diagnostics rather than short-circuiting traversal (`packages/workflow-engine/src/expr.ts:241-266`).

### Runtime evaluation: `evalExpr` and `evalCondition`

1. Literals return their value, `visits` calls the environment counter, lists evaluate each item, and `not` negates the workflow truth rule. A reference calls `env.read`; `ran: false` throws `MissingValueError` with code `condition_field_missing` (`packages/workflow-engine/src/expr.ts:276-289`).
2. `&&` and `||` short-circuit. Arrays, including empty arrays, count as true; other values use JavaScript boolean conversion (`packages/workflow-engine/src/expr.ts:276`, `packages/workflow-engine/src/expr.ts:291-294`).
3. Equality and inequality use strict equality, treat `undefined`, `null`, and `""` as equivalent blanks, and compare non-null objects by JSON serialization. `in` checks array members with the same equality rule and returns false when the right side is not an array (`packages/workflow-engine/src/expr.ts:277-278`, `packages/workflow-engine/src/expr.ts:294-299`).
4. Addition and subtraction require two numbers or throw `MissingValueError` with `condition_type`. Ordering comparisons return false for non-numeric operands; otherwise they apply the requested numeric comparison (`packages/workflow-engine/src/expr.ts:299-306`).

`evalExpr` returns the branch value or throws on a missing reference or invalid arithmetic. `evalCondition` converts that value through the same truth rule and returns a boolean; evaluation errors propagate (`packages/workflow-engine/src/expr.ts:280-312`).

| AST branch | Evaluation | Outcome or failure |
|---|---|---|
| Literal, `visits`, list | Return the literal, call `env.visits`, or evaluate each item in order (`packages/workflow-engine/src/expr.ts:281-285`). | Visit callback errors propagate; list element errors stop evaluation. |
| Reference | Call `env.read` (`packages/workflow-engine/src/expr.ts:286-290`). | `ran: false` throws `condition_field_missing`; a read marked as run returns its value, including `undefined` (`packages/workflow-engine/src/expr.ts:287-289`). |
| `not`, `&&`, `||` | Negate or short-circuit using workflow truth, where any array including `[]` is true (`packages/workflow-engine/src/expr.ts:276`, `packages/workflow-engine/src/expr.ts:284`, `packages/workflow-engine/src/expr.ts:292-293`). | The right side of `&&` runs only for a truthy left side; the right side of `||` runs only for a falsey left side. |
| Equality and membership | Compare with the shared equality function; `in` searches an array (`packages/workflow-engine/src/expr.ts:278`, `packages/workflow-engine/src/expr.ts:296-298`). | `undefined`, `null`, and `""` compare as blanks; non-null objects compare by JSON; `in` returns false when its right operand is not an array. |
| Arithmetic and ordering | Evaluate both operands before applying the operator (`packages/workflow-engine/src/expr.ts:294-306`). | `+`/`-` throw `condition_type` unless both values are numbers; ordering returns false for nonnumeric values. |

`evalCondition` is the boolean boundary: it applies `truthy` to the value returned by `evalExpr`, and does not catch `condition_field_missing`, `condition_type`, or callback errors (`packages/workflow-engine/src/expr.ts:312`).

### Value-position parsing: `valueSpecOf`

`valueSpecOf` returns non-strings unchanged as literals. For strings it trims outer whitespace, then checks in order: empty text; one complete `{{ref}}`; matching single/double quotes; JSON-looking array/object text; `true`, `false`, or `null`; a numeric literal; a bare identifier; a slash-containing path; and finally expression parsing (`packages/workflow-engine/src/expr.ts:321-336`).

Valid JSON-looking input becomes a literal. Invalid JSON-looking input falls through to `parseExpr`, as does any unclassified string; a parse error propagates as `ExprSyntaxError`. Quoted values lose their surrounding quote characters; bare words and recognized paths remain literal strings (`packages/workflow-engine/src/expr.ts:325-336`).

### Definition schemas

| Schema | Accepted branches and bounds | Failure behavior |
|---|---|---|
| `conditionSchema` / `whenSchema` | A strict `{field, op, value?}` leaf with a 1–120 character field and an operator from `CONDITION_OPS`; strict recursive `all` or `any` with 1–20 children; or strict recursive `not`. `whenSchema` also accepts a nonempty expression string up to 600 characters (`packages/workflow-engine/src/schema.ts:41-58`). | Zod rejects missing/extra keys, empty groups, more than 20 children, unsupported operators, and empty/overlong strings. Leaf `value` is optional and unrestricted at this structural layer (`packages/workflow-engine/src/schema.ts:51-58`). |
| `nodeSchema` | The `type` discriminator selects nine strict shapes (`packages/workflow-engine/src/schema.ts:194-228`). Agent supplies role/prompt/session settings; legacy model fields are accepted but ignored in favor of role-based selection; lp-task supplies contract and owned-path/stage settings; action supplies action/params/map; decision optionally names `reads_node`; human requires question and offers timeout options; parallel defines iteration/concurrency/child/join settings; join names its parallel and policy; subworkflow names an ID/version/input map; note carries text only (`packages/workflow-engine/src/schema.ts:117-131`, `packages/workflow-engine/src/schema.ts:194-228`). A parallel child has no authoring ID and is restricted to agent, lp-task, action, or subworkflow (`packages/workflow-engine/src/schema.ts:178-185`). | A missing/unknown discriminator or a field rejected by the selected strict schema fails parsing; graph-level relationships are checked later by `validateWorkflow` (`packages/workflow-engine/src/schema.ts:178-228`, `packages/workflow-engine/src/validate.ts:70-129`). |
| `consumesSchema` | Strict artifact declaration: lowercase artifact kind, integer version 1–99, `required` default true, optional `from` of 1–48 characters, and optional field-name `as` (`packages/workflow-engine/src/schema.ts:68-77`). | Zod rejects malformed shape and extra keys. It does not establish that the artifact is registered or that `from` produces it; graph checks add those errors (`packages/workflow-engine/src/validate.ts:307-333`). |

`conditionSchema` is lazy so recursive groups can contain conditions of the same union. Its accepted shapes are one strict leaf, a strict `all` list, a strict `any` list, or a strict `not` wrapper; group lists must contain 1–20 entries. `whenSchema` adds the string-expression branch, nonempty and at most 600 characters (`packages/workflow-engine/src/schema.ts:51-58`).

`consumesSchema` parses a strict object in this order: required `kind` matching the artifact-name pattern; required integer `version` from 1 to 99; optional `required`, defaulting to true; optional nonempty `from` up to 48 characters; and optional field-name `as`. Zod rejects invalid values and unknown keys; registry existence, source production, and execution order are separate `validateWorkflow` checks (`packages/workflow-engine/src/schema.ts:68-77`, `packages/workflow-engine/src/validate.ts:322-330`).

### Workflow validation: `validateWorkflow`

The validator accumulates diagnostics and continues through ordered passes (`packages/workflow-engine/src/validate.ts:70-73`).

1. Check the source form for reserved/duplicate IDs and fields, entry conflicts, schedule diagnostics, emit output requirements, and parallel child/join requirements (`packages/workflow-engine/src/validate.ts:81-123`).
2. Lower shorthand and check endpoints, sentinels, entry and exit counts, reachability, branch shape, and conditional-route fallback (`packages/workflow-engine/src/validate.ts:124-168`).
3. Parse expressions/templates and verify reference scope/order/types; check bounded cycles, values supplied by skipped nodes, and artifact producer/consumer/gate contracts (`packages/workflow-engine/src/validate.ts:170-346`).
4. Check executor availability when configured, warn that node-level model fields (`provider`, `model`, `reasoning`, `service_tier`, and `model_preset`) are ignored because model choice belongs to the role, then check agent options, prompt coverage, human defaults, decisions, parallel branches, and subworkflow mappings. A supplied specialist lookup rejects an unknown literal `specialist:<id>`; prompt enum coverage is a warning (`packages/workflow-engine/src/validate.ts:351-367`).
5. When a resolver exists, reject recursive subworkflow calls and depth beyond the smaller workflow/schema limit (`packages/workflow-engine/src/validate.ts:456-460`). Return all collected problems. `loadWorkflow` treats any error as failure and warnings alone as success; `parseWorkflow` throws `WorkflowError` on that failure (`packages/workflow-engine/src/validate.ts:467-487`).

The passes distinguish errors from warnings: authoring, graph, reference, contract, and node violations call `error`; budget, schedule, fallback, ignored-model, environment, and prompt-coverage findings use warnings. Validation continues after ordinary problems and returns the accumulated list; only an error makes `loadWorkflow` fail (`packages/workflow-engine/src/validate.ts:67-76`, `packages/workflow-engine/src/validate.ts:81-123`, `packages/workflow-engine/src/validate.ts:351-367`, `packages/workflow-engine/src/validate.ts:475-476`). The checks proceed from authoring constraints and lowered graph shape to expressions and references, cycles/skip outputs/contracts, then executor availability and node-specific rules (`packages/workflow-engine/src/validate.ts:98-119`, `packages/workflow-engine/src/validate.ts:121-168`, `packages/workflow-engine/src/validate.ts:170-346`, `packages/workflow-engine/src/validate.ts:345-456`).

### `loadWorkflow`

1. If `source` is a string, parse it as JSONC with trailing commas enabled. Syntax errors return `{ok:false}` with `syntax` problems containing parse-code and offset; non-string input skips this stage (`packages/workflow-engine/src/validate.ts:464-470`).
2. Pass the resulting value to `parseWorkflowObject`. Schema failure returns `{ok:false}` with each Zod issue converted to a `schema` problem and a dotted path (`packages/workflow-engine/src/validate.ts:471-474`).
3. Run `validateWorkflow` on the normalized definition. If any problem is level `error`, return all problems as `{ok:false}`; otherwise return `{ok:true, workflow, warnings}`, including an empty warnings list when there are no warnings (`packages/workflow-engine/src/validate.ts:475-476`).
4. `parseWorkflow` is the throwing wrapper: it returns the workflow for an `ok` result or throws `WorkflowError` with the problem list (`packages/workflow-engine/src/validate.ts:479-483`).

| Source and check result | `loadWorkflow` result | `parseWorkflow` result |
|---|---|---|
| Object or valid JSONC; no validation errors | `ok: true`, workflow plus warnings | Returns workflow (`packages/workflow-engine/src/validate.ts:471-476`). |
| JSONC syntax error | `ok: false`, `syntax` problems | Throws `WorkflowError` (`packages/workflow-engine/src/validate.ts:467-470`, `packages/workflow-engine/src/validate.ts:480-483`). |
| Structural schema error | `ok: false`, `schema` problems | Throws `WorkflowError` (`packages/workflow-engine/src/validate.ts:471-474`, `packages/workflow-engine/src/validate.ts:480-483`). |
| Validation errors only or mixed with warnings | `ok: false`, all validation problems | Throws `WorkflowError` (`packages/workflow-engine/src/validate.ts:475-476`, `packages/workflow-engine/src/validate.ts:480-483`). |
| Warning-only validation | `ok: true`, warnings retained | Returns workflow; warnings are not thrown (`packages/workflow-engine/src/validate.ts:475-476`). |

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
