---
title: Resilience, absence detection, and best effort
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: high
tags: [kit, error-handling, absence, resilience, logging]
sources:
  - packages/kit/src/miss.ts
  - packages/kit/src/best-effort.ts
  - packages/kit/package.json
  - packages/kit/tests/miss.test.ts
  - src/rooms/wall/server/wall.ts
  - src/rooms/tools/server/cli.ts
  - src/rooms/lead/server/service.ts
---

# Resilience, absence detection, and best effort

TL;DR: The miss and best-effort helpers isolate expected entity absence from real system faults and encapsulate non-critical side effects with structured logging (`packages/kit/src/miss.ts:10-100`, `packages/kit/src/best-effort.ts:17-24`).

## Purpose

The absence module distinguishes anticipated non-existence from actionable errors via `isNotFound` and `isFsAbsent` (`packages/kit/src/miss.ts:11-35`). In parallel, `bestEffort` defines boundaries for optional side effects with structured logging (`packages/kit/src/best-effort.ts:17-24`).

## How it works

1. **Filesystem absence discrimination (`isFsAbsent`):** Checks the `code` property of a caught error (`packages/kit/src/miss.ts:11-13`). Returns `true` only for `ENOENT` (no such file or directory) and `ENOTDIR` (a path component is not a directory). Codes such as `EACCES` or `EISDIR` return `false` (`packages/kit/src/miss.ts:13-14`).
2. **Entity and RPC absence discrimination (`isNotFound`):** Examines error structures from SDK clients and gateways (`packages/kit/src/miss.ts:31-35`):
   - Verifies whether `code` or `serverCode` equals `"not_found"` or ends with `"_not_found"` (`packages/kit/src/miss.ts:16-17`, `packages/kit/src/miss.ts:34`).
   - Checks for HTTP 404 responses via `isNotFound` (`packages/kit/src/miss.ts:19-35`).
   - Rejects non-absence errors such as 500 and socket timeouts in `isNotFound` (`packages/kit/src/miss.ts:28-35`).
3. **Safe filesystem reads:**
   - `readTextOrNull`: reads file text via UTF-8; returns `null` on `ENOENT` or `ENOTDIR`, re-throwing all other errors (`packages/kit/src/miss.ts:38-44`).
   - `lstatOrNull`: retrieves file `Stats` or returns `null` if the target is absent (`packages/kit/src/miss.ts:48-54`).
   - `statOrNull`: retrieves dereferenced file `Stats` or returns `null` on absence (`packages/kit/src/miss.ts:58-64`).
   - `readTextOrNullSync`: synchronous counterpart of `readTextOrNull` for non-async initialization code (`packages/kit/src/miss.ts:68-75`).
4. **Resilient JSON parsing (`parseJsonOr`):** Parses JSON text; if `JSON.parse` fails due to syntax corruption, returns a supplied fallback value (`packages/kit/src/miss.ts:81-87`).
5. **Typed absence wrapper (`orMiss`):** Awaits a promise and returns its result; if an error occurs and satisfies a passed predicate (`isFsAbsent` or `isNotFound`), it returns the fallback value; otherwise, it re-throws the error (`packages/kit/src/miss.ts:93-100`).
6. **Isolated side-effect execution (`bestEffort`):** Awaits an asynchronous task. If the task fails, it formats the message, logs a single warning line using the provided `BestEffortLog`, and returns the fallback value without throwing (`packages/kit/src/best-effort.ts:10-23`).

### Modes, variants, and thresholds

| Helper or predicate | Evaluated condition | Return value | Evidence |
|---|---|---|---|
| `isFsAbsent` | Error code is `ENOENT` or `ENOTDIR` | `true`; otherwise `false` | `packages/kit/src/miss.ts:11-14` |
| `isNotFound` | `code`/`serverCode` is `"not_found"` or `"*_not_found"`, or 404 status | `true`; otherwise `false` | `packages/kit/src/miss.ts:16-35` |
| `readTextOrNull` | File path is absent | Returns `null`; otherwise string content | `packages/kit/src/miss.ts:38-45` |
| `readTextOrNullSync` | File path is absent synchronously | Returns `null`; otherwise string content | `packages/kit/src/miss.ts:68-75` |
| `parseJsonOr` | Malformed JSON string | Returns `fallback` value | `packages/kit/src/miss.ts:81-87` |
| `orMiss` | Error satisfies `expected(cause)` predicate | Returns `fallback`; otherwise throws | `packages/kit/src/miss.ts:93-100` |
| `bestEffort` | Any error during side-effect execution | Logs warning via `log` and returns `fallback` | `packages/kit/src/best-effort.ts:17-24` |

### Failures

| Operation | Trigger condition | Result | Evidence |
|---|---|---|---|
| `readTextOrNull` | Permission denied or directory target | Throws original error in `readTextOrNull` | `packages/kit/src/miss.ts:38-44` |
| `orMiss` | Error does not match predicate | Throws original error | `packages/kit/src/miss.ts:93-98` |
| `bestEffort` | Target operation throws an exception | Formats error message and returns fallback | `packages/kit/src/best-effort.ts:17-23` |

## Business rules

- **Absence is not an error:** Files or RPC entities that are deliberately missing return explicit `null` or fallback values without triggering alerts (`packages/kit/src/miss.ts:5-8`).
- **No masking of operational faults:** Permission issues and server errors are rejected by `isNotFound` and propagate (`packages/kit/src/miss.ts:28-35`).
- **Single warning emission:** `bestEffort` emits a warning line with the action label and error message upon failure (`packages/kit/src/best-effort.ts:17-23`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `isFsAbsent` | `function` | Predicate for filesystem absence (`ENOENT`, `ENOTDIR`) | `packages/kit/src/miss.ts:11-14` |
| `isNotFound` | `function` | Predicate for RPC and HTTP 404 absence | `packages/kit/src/miss.ts:31-35` |
| `readTextOrNull` | `function` | Asynchronously reads file text or returns `null` on absence | `packages/kit/src/miss.ts:38-45` |
| `lstatOrNull` | `function` | Asynchronously retrieves file stats or returns `null` on absence | `packages/kit/src/miss.ts:48-55` |
| `statOrNull` | `function` | Asynchronously retrieves dereferenced file stats or returns `null` on absence | `packages/kit/src/miss.ts:58-65` |
| `readTextOrNullSync` | `function` | Synchronously reads file text or returns `null` on absence | `packages/kit/src/miss.ts:68-75` |
| `parseJsonOr` | `function` | Parses JSON with an automatic fallback on syntax error | `packages/kit/src/miss.ts:81-87` |
| `orMiss` | `function` | Wraps promise execution with a typed absence fallback predicate | `packages/kit/src/miss.ts:93-100` |
| `BestEffortLog` | `type` | Logger interface accepting a log function or `{ warn(msg): void }` | `packages/kit/src/best-effort.ts:8` |
| `bestEffort` | `function` | Executes a promise with logged warning on error and returns fallback | `packages/kit/src/best-effort.ts:17-24` |

## Gotchas

- **Directories read with `readTextOrNull`:** Attempting to read a directory using `readTextOrNull` throws `EISDIR` (`packages/kit/src/miss.ts:38-44`). Callers must check path stats when path types are indeterminate. See [Kit gotchas](../gotchas.md).
- **Transport errors in `orMiss`:** When wrapping network calls with `orMiss`, unhandled errors propagate (`packages/kit/src/miss.ts:93-99`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
