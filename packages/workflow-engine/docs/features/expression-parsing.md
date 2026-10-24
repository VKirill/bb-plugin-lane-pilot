---
title: Expression Parsing and Conditions
type: component
created: 2026-10-24
updated: 2026-10-24
status: active
confidence: high
tags: [workflow-engine, expressions, conditions]
sources:
  - packages/workflow-engine/src/expr.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/validate.ts
---
# Expression Parsing and Conditions
TL;DR: Expression text is tokenized into an AST, while structured conditions are translated into the same AST before validation and evaluation.

## Purpose

The expression module parses conditions, skip rules, loop filters, and value expressions into a shared AST. References are classified during parsing; validation later checks them against workflow fields and runtime evaluation reads their values (`packages/workflow-engine/src/expr.ts:4-8`, `packages/workflow-engine/src/expr.ts:17-23`).

## How it works

1. `parseExpr` tokenizes whitespace-separated numbers, quoted strings, identifiers, and supported operators. An unterminated quote or unknown character throws `ExprSyntaxError` with its offset (`packages/workflow-engine/src/expr.ts:30-54`, `packages/workflow-engine/src/expr.ts:72-74`).
2. The parser reads a primary expression: number/string literal, parenthesized expression, list, boolean/null literal, `visits(node)`, or reference. A bare identifier inside a list is a string literal unless it is dotted, `$`-prefixed, or one of the reserved words (`packages/workflow-engine/src/expr.ts:80-110`).
3. Recursive unary parsing handles `!`; then the parser folds `+`/`-`, consumes at most one comparison or `in`, folds `&&`, and finally folds `||`. This establishes precedence in that order (`packages/workflow-engine/src/expr.ts:112-126`).
4. Parsing succeeds only when the next token is the end marker. Missing operands or delimiters fail at the parser that expects them; trailing tokens fail with `ExprSyntaxError` (`packages/workflow-engine/src/expr.ts:78`, `packages/workflow-engine/src/expr.ts:128-130`).
5. `refOf` classifies each identifier: `$inputs` and `input` map to workflow inputs; `$mode` to run mode; `ctx` to context; `item` and `index` to loop data; run variables to `var`; other identifiers to node references. With `itemScope`, otherwise-bare names become item fields (`packages/workflow-engine/src/expr.ts:25-28`, `packages/workflow-engine/src/expr.ts:57-69`).
6. `conditionToExpr` recursively translates `all`, `any`, and `not`. A leaf creates a reference rooted at the supplied source node, converts array values to list ASTs, and maps its operator to the expression operator (`packages/workflow-engine/src/expr.ts:133-151`).

## Modes and branches

| Input branch | Parsing or conversion behavior | Result or failure |
|---|---|---|
| Expression string | `parseExpr` applies tokenizer then precedence parser; `itemScope` changes only fallback reference classification (`packages/workflow-engine/src/expr.ts:72-131`). | AST, or `ExprSyntaxError` for invalid tokens, expected syntax, or trailing tokens (`packages/workflow-engine/src/expr.ts:34-54`, `packages/workflow-engine/src/expr.ts:78-130`). |
| Primary literal | Numeric and quoted tokens become literals; `true`, `false`, and `null` are recognized identifiers (`packages/workflow-engine/src/expr.ts:80-84`, `packages/workflow-engine/src/expr.ts:97-100`). | Literal AST. |
| List | `[]` is accepted; items parse recursively, and a bare unqualified word becomes a string (`packages/workflow-engine/src/expr.ts:85-96`). | List AST; missing `]` or malformed item fails parsing. |
| `visits(...)` | Recognized only when the identifier `visits` is followed by `(`; argument must be a string or identifier, then `)` is required (`packages/workflow-engine/src/expr.ts:101-107`). | Visit-count AST, or syntax error for an invalid argument/delimiter. |
| Reference | Explicit prefixes have fixed kinds; bare names use node scope unless item scope applies (`packages/workflow-engine/src/expr.ts:57-69`). | Reference AST; validation determines whether the target/path exists (`packages/workflow-engine/src/expr.ts:203-230`). |
| Structured condition | `all` and `any` become left-folded `&&` and `||`; `not` becomes unary negation; leaf operators map to AST operators (`packages/workflow-engine/src/expr.ts:134-151`). | Expression AST. `exists: false` means null equality negated; other `exists` values mean non-null. `notIn` maps to negated `in` (`packages/workflow-engine/src/expr.ts:141-150`). |
| Invalid structured condition | `conditionSchema` accepts one strict leaf, nonempty bounded `all`/`any`, or recursive `not`; unknown keys and other shapes fail Zod parsing (`packages/workflow-engine/src/schema.ts:51-56`). | Schema issue; no expression AST is produced. |

## Business rules

- The structured `all` and `any` arrays must contain 1–20 conditions; each recursive child must match one of the strict union forms (`packages/workflow-engine/src/schema.ts:51-56`).
- Expression boolean operators bind after comparisons, which bind after addition/subtraction; parentheses can override this order (`packages/workflow-engine/src/expr.ts:112-126`).
- `conditionToExpr` uses `source` as the node name for every leaf field reference, even when the condition is nested under `all`, `any`, or `not` (`packages/workflow-engine/src/expr.ts:134-140`).

## Public API

| Export | Purpose |
|---|---|
| `parseExpr(text, options?)` | Parse expression text, optionally interpreting bare identifiers as item fields (`packages/workflow-engine/src/expr.ts:71-131`). |
| `refOf(text, options?)` | Convert a reference string into a typed reference (`packages/workflow-engine/src/expr.ts:57-69`). |
| `conditionToExpr(condition, source)` | Translate a validated structured condition into the expression AST (`packages/workflow-engine/src/expr.ts:133-152`). |
| `conditionSchema` | Validate the structured condition union (`packages/workflow-engine/src/schema.ts:51-56`). |

## Gotchas

- Parsing builds syntax trees; it does not verify node names, field paths, types, or runtime availability. Those checks happen in validation and evaluation (`packages/workflow-engine/src/expr.ts:72-131`, `packages/workflow-engine/src/validate.ts:191-207`).
- Quoted strings terminate at the next matching quote; the tokenizer does not decode escapes (`packages/workflow-engine/src/expr.ts:41-45`).
- `refOf` classifies strings but does not reject an empty or malformed path by itself; callers rely on parser and validation boundaries (`packages/workflow-engine/src/expr.ts:57-69`, `packages/workflow-engine/src/validate.ts:191-198`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Definitions and Validation](definitions-validation.md)
