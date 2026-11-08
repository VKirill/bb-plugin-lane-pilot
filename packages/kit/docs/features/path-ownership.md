---
title: Path ownership and task overlap matching
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: medium
tags: [kit, owns-paths, concurrency, globs, tasks]
sources:
  - packages/kit/src/owns-paths.ts
  - packages/kit/package.json
  - src/rooms/tasks/server/contract-lint.ts
  - src/rooms/tasks/trusted-tooling.ts
  - src/rooms/tasks/test-fit.ts
  - src/rooms/tasks/task-base.ts
  - src/rooms/writer/live-folder.ts
---

# Path ownership and task overlap matching

TL;DR: The `owns-paths` module provides glob pattern matching, file permission checks, and conservative task overlap detection with zero Node runtime dependencies (`packages/kit/src/owns-paths.ts:1-93`).

## Purpose

To prevent concurrent tasks from modifying the same files or corrupting workspace directories, tasks declare path patterns to test if a file path falls under an ownership or exclusion pattern via `matchOwnsPath` (`packages/kit/src/owns-paths.ts:51-65`). This module evaluates file permissions using `fileAllowedByOwns` (`packages/kit/src/owns-paths.ts:66-69`) and `fileBlockedByNeverTouch` (`packages/kit/src/owns-paths.ts:70-74`), and determines whether tasks conflict using `ownsPathsOverlap` (`packages/kit/src/owns-paths.ts:88-93`).

The subpath `./owns-paths` maps to `./src/owns-paths.ts` for browser-safe path matching and task collision checks (`packages/kit/package.json:13`).

## How it works

1. **Path normalization:** `normalize` replaces backslashes with forward slashes and strips leading `./` (`packages/kit/src/owns-paths.ts:1-3`).
2. **Glob pattern compilation (`globRegex`):** The pattern is split by `/` in `globRegex` (`packages/kit/src/owns-paths.ts:13-18`). Within segments, `escapeRegExp` escapes literal characters while single star matches non-slash characters and double star crosses folders (`packages/kit/src/owns-paths.ts:19-28`). The compiled regular expression anchors to the start and end in `globRegex` (`packages/kit/src/owns-paths.ts:13-30`).
3. **Exact and parent matching (`fnmatch`, `underMatch`):** `fnmatch` tests a path directly against `globRegex` (`packages/kit/src/owns-paths.ts:32-34`). `underMatch` tests whether either the complete path or any of its parent directory prefixes match the pattern (`packages/kit/src/owns-paths.ts:37-41`).
4. **File scope resolution (`matchOwnsPath`):**
   - **Literal paths:** If the pattern contains no wildcards (`*`, `?`, `[`), the file matches if it is identical to the pattern or starts with `${pattern}/` (`packages/kit/src/owns-paths.ts:54`).
   - **Double-star suffix:** If the pattern ends with `/**`, the suffix is stripped; if the base has no wildcards, prefix checking applies; otherwise, `underMatch` evaluates the base against the path hierarchy (`packages/kit/src/owns-paths.ts:55-59`).
   - **Wildcard directories:** Any other wildcard pattern matches files directly or evaluates folder containment via `underMatch`, ensuring folders matched by wildcards encompass all nested files (`packages/kit/src/owns-paths.ts:60-64`).
5. **Ownership and restriction evaluation:**
   - `fileAllowedByOwns(file, ownsPaths)` returns `true` if the file matches at least one pattern in `ownsPaths` (`packages/kit/src/owns-paths.ts:66-68`).
   - `fileBlockedByNeverTouch(file, neverTouch)` returns `true` if the file matches at least one pattern in `neverTouch` (`packages/kit/src/owns-paths.ts:70-72`).
6. **Task concurrency conflict evaluation (`ownsPathsOverlap`):**
   - `literalBase` extracts the literal path segments preceding the first wildcard character (`packages/kit/src/owns-paths.ts:75-82`).
   - `ownsPathsOverlap(a, b)` checks pairwise combinations of patterns from sets `a` and `b`. An overlap is flagged if either literal base is empty (root match), if both bases match, or if one base is a directory ancestor of the other (`packages/kit/src/owns-paths.ts:88-92`).

### Modes, variants, and thresholds

| Pattern syntax | Example | Matching behavior | Evidence |
|---|---|---|---|
| Literal file | `src/config.ts` | Matches exact file path only | `packages/kit/src/owns-paths.ts:54` |
| Literal directory | `src/rooms/` | Matches directory itself and all descendants | `packages/kit/src/owns-paths.ts:54` |
| Double-star suffix | `packages/**` | Matches all paths and files nested under `packages/` | `packages/kit/src/owns-paths.ts:55-59` |
| Segment glob | `src/*.ts` | Matches `.ts` files directly inside `src/` | `packages/kit/src/owns-paths.ts:23`, `packages/kit/src/owns-paths.ts:32-34` |
| Recursive glob | `src/**/tests/*` | Matches files inside test directories at any depth | `packages/kit/src/owns-paths.ts:18` |
| Single character wildcard | `test-?.ts` | Matches single non-slash character | `packages/kit/src/owns-paths.ts:24` |

### Failures

The matching functions are purely functional and operate over strings without throwing errors:
- Passing empty pattern lists to `fileAllowedByOwns` returns `false` (`packages/kit/src/owns-paths.ts:66-68`), and `fileBlockedByNeverTouch` returns `false` (`packages/kit/src/owns-paths.ts:70-72`).
- Passing empty arrays to `ownsPathsOverlap` returns `false` (`packages/kit/src/owns-paths.ts:88-93`).

## Business rules

- **Folder inheritance:** Specifying a directory path (with or without a trailing slash) automatically grants ownership of all files and subdirectories located within it (`packages/kit/src/owns-paths.ts:54`).
- **Wildcard directory containment:** A folder matched by a wildcard pattern owns all files located within that folder (`packages/kit/src/owns-paths.ts:60-64`).
- **Conservative overlap resolution:** `ownsPathsOverlap` compares literal bases rather than calculating precise geometric glob intersections (`packages/kit/src/owns-paths.ts:84-92`). When in doubt, it flags an overlap to queue tasks sequentially rather than risking concurrent file edits.
- **Zero Node dependency constraint:** `owns-paths.ts` contains no Node built-in imports, enabling direct execution in web browsers and UI workers (`packages/kit/package.json:13`, `packages/kit/src/owns-paths.ts:1-93`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `fnmatch` | `function` | Tests if a path matches a glob pattern | `packages/kit/src/owns-paths.ts:32-34` |
| `matchOwnsPath` | `function` | Tests if a file path falls under an ownership or exclusion pattern | `packages/kit/src/owns-paths.ts:51-65` |
| `fileAllowedByOwns` | `function` | Verifies that a file matches at least one task rule | `packages/kit/src/owns-paths.ts:66-68` |
| `fileBlockedByNeverTouch` | `function` | Verifies if a file matches any task restriction | `packages/kit/src/owns-paths.ts:70-72` |
| `ownsPathsOverlap` | `function` | Determines whether two task ownership lists have conflicting path scopes | `packages/kit/src/owns-paths.ts:88-93` |

## Gotchas

- **Conservative false-positive overlaps:** Because `literalBase` extracts segments before wildcards (`packages/kit/src/owns-paths.ts:75-82`), tasks sharing literal bases are flagged as conflicting by `ownsPathsOverlap` (`packages/kit/src/owns-paths.ts:88-93`). This delays concurrent execution even when target files are disjoint. See [Kit gotchas](../gotchas.md).
- **Subpath import requirement:** UI code must import from `@lane-pilot/kit/owns-paths` rather than the package root `@lane-pilot/kit` to prevent bundling Node built-in modules (`packages/kit/package.json:13`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
