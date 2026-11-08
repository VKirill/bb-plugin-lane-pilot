---
title: System paths, hashing, hooks, and value helpers
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: high
tags: [kit, paths, hashing, hooks, utilities]
sources:
  - packages/kit/src/hash.ts
  - packages/kit/src/paths.ts
  - packages/kit/src/hook-shape.ts
  - packages/kit/src/pace.ts
  - packages/kit/src/values.ts
  - packages/kit/package.json
  - src/rooms/platform/server/thread-keys.ts
  - src/rooms/tasks/task-v2.ts
---

# System paths, hashing, hooks, and value helpers

TL;DR: The system helpers provide centralized SHA-256 hashing, directory tree fingerprinting, path resolution, hook identity normalization, test pace scaling, and safe property extraction (`packages/kit/src/hash.ts:8-69`, `packages/kit/src/paths.ts:5-43`, `packages/kit/src/hook-shape.ts:11-52`, `packages/kit/src/pace.ts:5-8`, `packages/kit/src/values.ts:3-22`).

## Purpose

These utilities unify foundational system operations across the plugin: ensuring consistent hashing via `sha256Hex` (`packages/kit/src/hash.ts:8-14`), standardizing directories via `resolveHome` (`packages/kit/src/paths.ts:5-15`), normalizing hooks via `hookCommandShape` (`packages/kit/src/hook-shape.ts:40-45`), and pacing via `pollPause` (`packages/kit/src/pace.ts:5-8`).

## How it works

1. **Cryptographic hashing (`hash.ts`):**
   - `createSha256`: centralized factory calling `createHash` with `"sha256"` (`packages/kit/src/hash.ts:8`).
   - `sha256Hex`: hashes strings or buffers to lowercase hex strings (`packages/kit/src/hash.ts:11-13`).
   - `sha256File`: streams a file from disk into a SHA-256 hash in `sha256File` (`packages/kit/src/hash.ts:15-23`).
   - `sha256Tree`: deterministically hashes directory trees by sorting directory entries alphabetically and formatting entries as L, D, or F in `sha256Tree` (`packages/kit/src/hash.ts:25-45`).
   - `hashPath`: inspects a path via `lstat` and returns its entity kind along with its SHA-256 hash in `hashPath` (`packages/kit/src/hash.ts:47-60`).
   - `sha256FileOrNull`: returns the file hash or `null` if the file is absent in `sha256FileOrNull` (`packages/kit/src/hash.ts:62-68`).
2. **Directory and path resolution (`paths.ts`):**
   - `resolveHome`: determines home directory precedence: homeDir parameter, environment variable, or operating system directory (`packages/kit/src/paths.ts:5-7`).
   - `expandHomePath`: expands `~` and `$HOME` prefixes (`packages/kit/src/paths.ts:9-14`).
   - `agentsDir` and `lanePilotRoot`: resolve `.agents` and `lane-pilot` paths (`packages/kit/src/paths.ts:16-22`).
   - `upstreamDir` and `managedEngineDir`: locate commit-pinned directories under `upstream` and `engines` (`packages/kit/src/paths.ts:24-30`).
   - `pluginRootFromModule`: walks directory ancestors of a module URL until locating the parent of `src` or `dist` (`packages/kit/src/paths.ts:33-39`).
   - `defaultGuardSource`: locates guard script path (`packages/kit/src/paths.ts:41-43`).
3. **Hook identity normalization (`hook-shape.ts`):**
   - `hookCommandWords`: parses simple shell commands into arguments while unwrapping quotes (`packages/kit/src/hook-shape.ts:11-37`).
   - `hookCommandShape`: derives normalized program and script paths joined by a null byte (`packages/kit/src/hook-shape.ts:40-45`).
   - `hookCommandIdentity`: concatenates shape with normalized command arguments, or falls back to trimmed command strings (`packages/kit/src/hook-shape.ts:48-52`).
4. **Pacing and loop overrides (`pace.ts`):**
   - `pollPause`: reads `process.env.LANE_PILOT_POLL_SCALE`. If positive, returns scaled time; otherwise returns milliseconds as written (`packages/kit/src/pace.ts:5-8`).
5. **Safe value helpers (`values.ts`):**
   - `id`: generates prefix-tagged IDs using random UUID values (`packages/kit/src/values.ts:3-5`).
   - `valueAt`: safely retrieves a property via `Reflect.get` on objects (`packages/kit/src/values.ts:7-9`).
   - `stringAt`: returns the property value if it is a non-empty string, or `null` otherwise (`packages/kit/src/values.ts:11-14`).
   - `outputText`: searches for text or content properties, falling back to stringified representation (`packages/kit/src/values.ts:16-22`).

### Modes, variants, and thresholds

| Helper or parameter | Setting or condition | Behavior | Evidence |
|---|---|---|---|
| Deterministic tree sort | Alphabetical sort on entry names | Ensures reproducible hash across varying filesystem orderings in `sha256Tree` | `packages/kit/src/hash.ts:25-30` |
| `LANE_PILOT_POLL_SCALE` | Positive floating point number | Scales pause times in polling loops, clamping to a minimum of 1 ms in `pollPause` | `packages/kit/src/pace.ts:6-7` |
| Hook command metacharacters | Shell characters | Returns null shape via `hookCommandWords` | `packages/kit/src/hook-shape.ts:11-34` |
| ID generation | Random UUID without dashes | Produces 32-character hexadecimal suffix in `id` | `packages/kit/src/values.ts:3-5` |

### Failures

| Operation | Trigger condition | Result | Evidence |
|---|---|---|---|
| `sha256File` | Path missing or unreadable | Stream error rejects in `sha256File` | `packages/kit/src/hash.ts:15-22` |
| `sha256FileOrNull` | Path is missing | Returns `null` without throwing in `sha256FileOrNull` | `packages/kit/src/hash.ts:62-68` |
| `hookCommandWords` | Unclosed quotes or metacharacters present | Returns `null` in `hookCommandWords` | `packages/kit/src/hook-shape.ts:11-34` |
| `stringAt` | Property is absent, non-string, or empty | Returns `null` in `stringAt` | `packages/kit/src/values.ts:11-14` |

## Business rules

- **Alphabetical tree hashing:** Directory tree hashes must sort directory entries by name in `sha256Tree` (`packages/kit/src/hash.ts:25-30`).
- **Hook identity equivalence:** Hook definitions differing only in quotes, whitespace, or trailing argument flags share the same identity in `hookCommandIdentity` (`packages/kit/src/hook-shape.ts:48-52`).
- **Root detection heuristic:** `pluginRootFromModule` stops at the immediate parent of the nearest `src` or `dist` segment (`packages/kit/src/paths.ts:35-37`).
- **Pacing floor:** Scaled pauses must never be less than 1 millisecond in `pollPause` (`packages/kit/src/pace.ts:5-8`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `createSha256` | `function` | Creates a new SHA-256 hash instance | `packages/kit/src/hash.ts:8` |
| `sha256Hex` | `function` | Computes SHA-256 hex string for binary or text data | `packages/kit/src/hash.ts:11-13` |
| `sha256File` | `function` | Streams and computes SHA-256 hex string for a file | `packages/kit/src/hash.ts:15-23` |
| `sha256Tree` | `function` | Computes deterministic SHA-256 fingerprint for a directory tree | `packages/kit/src/hash.ts:25-45` |
| `hashPath` | `function` | Hashes any path according to its filesystem kind | `packages/kit/src/hash.ts:47-60` |
| `sha256FileOrNull` | `function` | Returns file hash or `null` if absent | `packages/kit/src/hash.ts:62-69` |
| `resolveHome` | `function` | Resolves home directory path | `packages/kit/src/paths.ts:5-7` |
| `expandHomePath` | `function` | Expands `~` and `$HOME` in paths | `packages/kit/src/paths.ts:9-14` |
| `agentsDir` | `function` | Returns `.agents` path | `packages/kit/src/paths.ts:16-18` |
| `lanePilotRoot` | `function` | Returns `.agents/lane-pilot` path | `packages/kit/src/paths.ts:20-22` |
| `upstreamDir` | `function` | Returns path to upstream clone for a commit SHA | `packages/kit/src/paths.ts:24-26` |
| `managedEngineDir` | `function` | Returns path to managed engine for a commit SHA | `packages/kit/src/paths.ts:28-30` |
| `pluginRootFromModule` | `function` | Finds plugin root above `src/` or `dist/` | `packages/kit/src/paths.ts:33-39` |
| `defaultGuardSource` | `function` | Returns path to default shell guard hook script | `packages/kit/src/paths.ts:41-43` |
| `hookCommandWords` | `function` | Splits command string into unquoted arguments | `packages/kit/src/hook-shape.ts:11-37` |
| `hookCommandShape` | `function` | Normalizes program and script identity | `packages/kit/src/hook-shape.ts:40-45` |
| `hookCommandIdentity` | `function` | Produces canonical hook identity string | `packages/kit/src/hook-shape.ts:48-52` |
| `pollPause` | `function` | Calculates sleep time respecting `LANE_PILOT_POLL_SCALE` | `packages/kit/src/pace.ts:5-8` |
| `id` | `function` | Generates prefixed UUID string | `packages/kit/src/values.ts:3-5` |
| `valueAt` | `function` | Retrieves object property safely | `packages/kit/src/values.ts:7-9` |
| `stringAt` | `function` | Retrieves non-empty string property or null | `packages/kit/src/values.ts:11-14` |
| `outputText` | `function` | Extracts primary text output from unknown response objects | `packages/kit/src/values.ts:16-22` |

## Gotchas

- **Complex shell commands in hook shapes:** Commands with pipes or variable expansions return null shape via `hookCommandWords` (`packages/kit/src/hook-shape.ts:11-34`). See [Kit gotchas](../gotchas.md).
- **Module URL resolution:** `pluginRootFromModule` requires a file module URL; passing arbitrary filesystem paths without file URL formatting causes incorrect root detection (`packages/kit/src/paths.ts:33-39`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
