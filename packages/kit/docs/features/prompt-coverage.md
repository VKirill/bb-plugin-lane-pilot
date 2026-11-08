---
title: Prompt vocabulary and schema enum coverage
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: high
tags: [kit, prompt-coverage, schema, json-schema, validation]
sources:
  - packages/kit/src/prompt-coverage.ts
  - packages/kit/tests/prompt-coverage.test.ts
  - packages/kit/package.json
---

# Prompt vocabulary and schema enum coverage

TL;DR: The `prompt-coverage` module verifies that prompt instructions explicitly name the string literals and enum tokens required by schema validators (`packages/kit/src/prompt-coverage.ts:1-66`).

## Purpose

When language models produce structured outputs, instructions must name required enum values (`packages/kit/src/prompt-coverage.ts:1-5`).

This module audits instruction texts via `literalCoverage` (`packages/kit/src/prompt-coverage.ts:20-29`) and `schemaEnums` (`packages/kit/src/prompt-coverage.ts:42-61`).

The entry point is exported as a browser-safe subpath (`packages/kit/package.json:14`).

## How it works

1. **Text normalization:** Input strings are converted to Unix line endings and normalized to NFC (`packages/kit/src/prompt-coverage.ts:13`).
2. **Word-boundary matching (`literalCoverage`):**
   - For each target literal, a regular expression is constructed with `WORD` boundaries (`packages/kit/src/prompt-coverage.ts:12-25`).
   - Texts are evaluated individually so tokens do not bridge across array boundaries (`packages/kit/src/prompt-coverage.ts:21-26`).
   - Returns a `LiteralCoverage` object categorizing literals into `mentioned` and `missing`, setting `partial: true` if some but not all literals are present (`packages/kit/src/prompt-coverage.ts:28`).
3. **Recursive schema traversal (`schemaEnums`):**
   - Traverses a schema node hierarchy starting from root pointer in `schemaEnums` (`packages/kit/src/prompt-coverage.ts:42-45`).
   - Collects non-empty string items from enum arrays under `${path}/enum` (`packages/kit/src/prompt-coverage.ts:48`).
   - Collects non-empty string const properties under `${path}/const` (`packages/kit/src/prompt-coverage.ts:49`).
   - Resolves local reference pointers recursively in `schemaEnums` (`packages/kit/src/prompt-coverage.ts:42-53`).
   - Traverses schema combinators, object properties, and items (`packages/kit/src/prompt-coverage.ts:54-57`).
   - Maintains a `seen` set to avoid loops on shared sub-schemas (`packages/kit/src/prompt-coverage.ts:43-46`).
4. **Combined schema audit (`enumCoverage`):** Calls `schemaEnums` on the schema and tests each discovered enum group against the provided instruction texts (`packages/kit/src/prompt-coverage.ts:64-66`).

### Modes, variants, and thresholds

| Setting or parameter | Option value | Matching effect | Evidence |
|---|---|---|---|
| `CoverageOptions.ignoreCase` | `false` (default) | Case-sensitive matching using RegExp flag `"u"` | `packages/kit/src/prompt-coverage.ts:16`, `packages/kit/src/prompt-coverage.ts:22` |
| `CoverageOptions.ignoreCase` | `true` | Case-insensitive matching using Unicode case folding with flags `"iu"` | `packages/kit/src/prompt-coverage.ts:22` |
| Unicode word boundaries | `WORD` pattern | Hyphens and punctuation act as word boundaries, while underscores and accents do not | `packages/kit/src/prompt-coverage.ts:7-12` |
| Reference resolution | `#/` prefix | Resolves in-document reference paths; external URIs are not followed | `packages/kit/src/prompt-coverage.ts:50-53` |

### Failures

The module performs in-memory inspection without throwing exceptions:
- Invalid schemas passed to `schemaEnums` return an empty array (`packages/kit/src/prompt-coverage.ts:42-45`).
- Unresolvable `$ref` reference pointers evaluate safely to undefined and are skipped (`packages/kit/src/prompt-coverage.ts:50-53`).
- Empty literal lists or empty texts return empty result sets without errors in `literalCoverage` (`packages/kit/src/prompt-coverage.ts:20-28`).

## Business rules

- **Whole-word isolation:** Literals must not have word characters immediately preceding or succeeding them (`packages/kit/src/prompt-coverage.ts:7-8`, `packages/kit/src/prompt-coverage.ts:25`).
- **Independent text boundaries:** Texts supplied as an array are checked independently to prevent concatenated word formation across text boundaries (`packages/kit/src/prompt-coverage.ts:9-10`, `packages/kit/src/prompt-coverage.ts:26`).
- **NFC normalization:** Accented characters match whether input was composed or decomposed due to `normalize` NFC conversion (`packages/kit/src/prompt-coverage.ts:9-13`).
- **Deduplicated schema reporting:** Each schema definition path is examined once and reported at its primary canonical path (`packages/kit/src/prompt-coverage.ts:40`, `packages/kit/src/prompt-coverage.ts:45`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `CoverageOptions` | `type` | Matching configuration supporting `ignoreCase` | `packages/kit/src/prompt-coverage.ts:16` |
| `LiteralCoverage` | `type` | Result structure containing `mentioned`, `missing`, and `partial` | `packages/kit/src/prompt-coverage.ts:17` |
| `literalCoverage` | `function` | Audits an array of literal strings against target texts | `packages/kit/src/prompt-coverage.ts:20-29` |
| `EnumGroup` | `type` | Discovered schema enum group containing `path` and `values` | `packages/kit/src/prompt-coverage.ts:31` |
| `EnumCoverage` | `type` | Intersection of `EnumGroup` and `LiteralCoverage` | `packages/kit/src/prompt-coverage.ts:32` |
| `schemaEnums` | `function` | Extracts all enum and const strings with JSON Pointers from a schema | `packages/kit/src/prompt-coverage.ts:42-61` |
| `enumCoverage` | `function` | Audits prompt text coverage across all enums in a schema | `packages/kit/src/prompt-coverage.ts:64-66` |

## Gotchas

- **Narrow scope to literals:** The coverage audit inspects only string literals and enum values; patterns and numeric ranges are not verified (`packages/kit/src/prompt-coverage.ts:4-5`). See [Kit gotchas](../gotchas.md).
- **Subpath import for browsers:** Browser modules must import `@lane-pilot/kit/prompt-coverage` to ensure bundlers do not pull in Node built-in dependencies from the package root (`packages/kit/package.json:14`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
