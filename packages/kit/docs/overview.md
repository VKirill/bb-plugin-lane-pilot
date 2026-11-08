---
title: Kit workspace overview
type: overview
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: medium
tags: [kit, utilities, foundation, workspace]
sources:
  - packages/kit/package.json
  - packages/kit/src/index.ts
  - packages/kit/src/bounded-read.ts
  - packages/kit/src/redact.ts
  - packages/kit/src/spawn-async.ts
  - packages/kit/src/output-capture.ts
  - packages/kit/src/output-excerpt.ts
  - packages/kit/src/owns-paths.ts
  - packages/kit/src/miss.ts
  - packages/kit/src/best-effort.ts
  - packages/kit/src/hash.ts
  - packages/kit/src/paths.ts
  - packages/kit/src/prompt-coverage.ts
  - packages/kit/src/hook-shape.ts
  - packages/kit/src/pace.ts
  - packages/kit/src/values.ts
---

# Kit workspace overview

TL;DR: `@lane-pilot/kit` aggregates foundational utilities for hashing, secret redaction, process execution, bounded file reading, path ownership matching, resilience, and prompt validation (`packages/kit/src/index.ts:1-14`).

## What it is

The workspace is the lowest shared utility package in the monorepo (`packages/kit/package.json:1-16`). It has no runtime dependencies on other workspace packages or third-party libraries, relying strictly on Node built-in modules for its root entry point while exporting dedicated browser-safe subpaths for client bundles (`packages/kit/package.json:4`, `packages/kit/package.json:11-15`).

Every room in `src/rooms/` and shared packages under `packages/` rely on `@lane-pilot/kit` for consistent cryptographic hashing, safe child process spawning, sensitive credential masking, workspace boundary enforcement, and failure discrimination (`packages/kit/src/index.ts:1-14`).

## Stack

- **Module system:** Native ES modules with `"type": "module"` and `"sideEffects": false` (`packages/kit/package.json:5-8`).
- **Dependencies:** Zero external dependencies (`packages/kit/package.json:1-16`). Root exports utilize Node built-in modules for crypto, filesystem, process management, operating system, and paths.
- **Browser isolation:** Browser-safe modules without Node built-in imports are exposed via explicit export subpaths (`packages/kit/package.json:11-15`).

## Configuration

The package manifest exposes three entry points (`packages/kit/package.json:11-15`):
- `.` maps to `./src/index.ts` for Node runtime consumers (`packages/kit/package.json:12`).
- `./owns-paths` maps to `./src/owns-paths.ts` for browser-safe path matching and task collision checks (`packages/kit/package.json:13`).
- `./prompt-coverage` maps to `./src/prompt-coverage.ts` for browser-safe schema enum verification (`packages/kit/package.json:14`).

Environment configuration:
- `LANE_PILOT_POLL_SCALE`: Optional numeric environment variable read by `pollPause` to accelerate polling intervals during testing (`packages/kit/src/pace.ts:6-7`).

## Public entry points and capabilities

The package root aggregates fourteen core utility modules (`packages/kit/src/index.ts:1-14`):

- **[Bounded workspace file reads](features/bounded-reads.md):** Implements the `lane_pilot_read` protocol with workspace boundary enforcement, segment-by-segment symlink blocking, binary null-byte rejection, UTF-8 validation, and file/slice size bounds (`packages/kit/src/bounded-read.ts:6-28`).
- **[Secret redaction and credential protection](features/redaction.md):** Generates multi-format search needles for sensitive credentials via `secretNeedles`, maintains a process registry via `registerSecrets`, and sanitizes strings via `redactKnown` (`packages/kit/src/redact.ts:15-96`).
- **[Async process spawning and output handling](features/process-spawning.md):** Executes child processes asynchronously via `spawnAsync` with timeout controls and stream retention (`packages/kit/src/spawn-async.ts:17-56`), and provides check output cleaning via `cleanCheckOutput` and `failureExcerpt` extraction (`packages/kit/src/output-excerpt.ts:20-42`).
- **[Path ownership and task overlap matching](features/path-ownership.md):** Tests if a file path falls under an ownership or exclusion pattern via `matchOwnsPath` (`packages/kit/src/owns-paths.ts:51-65`), and detects task conflict overlaps via `ownsPathsOverlap` (`packages/kit/src/owns-paths.ts:88-93`).
- **[Resilience, absence detection, and best effort](features/resilience-and-absence.md):** Distinguishes expected file or RPC entity absence via `isNotFound` (`packages/kit/src/miss.ts:11-100`), and isolates non-critical side effects with warning logging via `bestEffort` (`packages/kit/src/best-effort.ts:8-24`).
- **[Prompt vocabulary and schema enum coverage](features/prompt-coverage.md):** Validates that prompt instructions contain required literals via `literalCoverage` and extracts schema tokens via `schemaEnums` (`packages/kit/src/prompt-coverage.ts:20-66`).
- **[System paths, hashing, hooks, and value helpers](features/system-helpers.md):** Centralizes SHA-256 hashing via `sha256Hex` (`packages/kit/src/hash.ts:8-69`), standard directories via `resolveHome` (`packages/kit/src/paths.ts:5-43`), hook command normalization via `hookCommandIdentity` (`packages/kit/src/hook-shape.ts:11-52`), and safe property retrieval via `stringAt` (`packages/kit/src/values.ts:3-22`).

## Workspace consumers

`@lane-pilot/kit` is imported throughout the monorepo:
- **Server rooms:**
  - `src/rooms/wall/`: utilizes `sha256Hex`, `bestEffort`, `redactKnownDeep`, `id`, `stringAt`, `orMiss`, `isNotFound`, `withoutSelectionMarkers`.
  - `src/rooms/tasks/`: utilizes `ownsPathsOverlap`, `matchOwnsPath`, `fileAllowedByOwns`, `fileBlockedByNeverTouch`, `cleanCheckOutput`, `failureExcerpt`, `pluginRootFromModule`, `sha256Hex`.
  - `src/rooms/workflow/`: utilizes `redactKnown`, `bestEffort`, `sha256Hex`, `stringAt`, `parseJsonOr`, `orMiss`, `isNotFound`, `outputText`.
  - `src/rooms/runs/`: utilizes `id`, `stringAt`, `valueAt`, `orMiss`, `isNotFound`, `pollPause`, `sha256Hex`.
  - `src/rooms/schedule/`: utilizes `stringAt`, `orMiss`, `isNotFound`, `redactKnown`, `pollPause`.
  - `src/rooms/checkers/`: utilizes `bestEffort`, `spawnAsync`.
  - `src/rooms/tools/`: utilizes `bestEffort`, `LANE_PILOT_READ_NAME`, `isNotFound`, `orMiss`, `outputText`, `stringAt`, `valueAt`.
  - `src/rooms/secrets/`: utilizes `registerSecrets`, `secretStrings`.
  - `src/rooms/baseline/`: utilizes `bestEffort`, `fileAllowedByOwns`, `ownsPathsOverlap`.
  - `src/rooms/platform/`: utilizes `stringAt`, `spawnAsync`, `sha256Hex`, `orMiss`, `isNotFound`.
- **UI modules and browser bundles:**
  - UI components and contract validators import browser-safe subpaths `@lane-pilot/kit/owns-paths` and `@lane-pilot/kit/prompt-coverage` (`packages/kit/package.json:13-14`).
- **Other packages:**
  - Packages including `packages/contracts`, `packages/host-calls`, and `packages/workflow-engine` utilize kit helpers for hashing, process execution, and error resilience.

## Where to look next

- [Bounded workspace file reads](features/bounded-reads.md) — file read constraints, traversal guards, and slice limits.
- [Secret redaction and credential protection](features/redaction.md) — secret needle expansion and known secret registries.
- [Async process spawning and output handling](features/process-spawning.md) — child process lifecycle, stream capture, and output excerpt cleaning.
- [Path ownership and task overlap matching](features/path-ownership.md) — path glob matching and concurrency lock detection.
- [Resilience, absence detection, and best effort](features/resilience-and-absence.md) — absence predicates and logged error boundaries.
- [Prompt vocabulary and schema enum coverage](features/prompt-coverage.md) — schema enum extraction and prompt literal audits.
- [System paths, hashing, hooks, and value helpers](features/system-helpers.md) — directory conventions, hashing, and hook normalization.
- [Kit gotchas](gotchas.md) — known traps, buffer limits, and subpath import requirements.
- [Monorepo architecture](../../../docs/architecture.md) — system-wide workspace layout and dependency structure.
