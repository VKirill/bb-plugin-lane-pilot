---
title: Kit gotchas
type: gotchas
created: 2026-11-08
updated: 2026-11-11
status: active
confidence: medium
tags: [kit, gotchas, pitfalls]
sources:
  - packages/kit/src/owns-paths.ts
  - packages/kit/src/redact.ts
  - packages/kit/src/spawn-async.ts
  - packages/kit/src/bounded-read.ts
  - packages/kit/src/miss.ts
  - packages/kit/src/hook-shape.ts
  - packages/kit/src/output-excerpt.ts
  - packages/kit/package.json
  - packages/kit/tests/bounded-read.test.ts
  - packages/kit/tests/spawn-async.test.ts
  - packages/kit/tests/redact.test.ts
  - packages/kit/src/output-capture.ts
  - packages/kit/src/index.ts
---

# Kit gotchas

TL;DR: Buffer limits, first-in first-out secret cache eviction, strict symlink rejection, conservative glob overlap locking, and browser bundling constraints affect callers across the workspace (`packages/kit/src/spawn-async.ts:17-19`, `packages/kit/src/redact.ts:10-71`, `packages/kit/src/bounded-read.ts:57`, `packages/kit/src/owns-paths.ts:88-92`).

## Critical

None found in the inspected package code.

## High

### Default 1 MB stream buffer kills verbose checks

**Problem:** `spawnAsync` imposes a default `maxBuffer` cap of 1 MB (1,048,576 bytes) per stream when `options.keepEnds` is not specified (`packages/kit/src/spawn-async.ts:22`). If a process generates more than 1 MB of stdout or stderr, it is sent `SIGTERM` and terminated with `error.code = "ENOBUFS"` (`packages/kit/src/spawn-async.ts:45-49`).

**Risk:** Test suites or build scripts that log large quantities of debug output are terminated prematurely and reported as failed, even when their underlying test execution would have succeeded (`packages/kit/src/spawn-async.ts:14-15`, `packages/kit/src/spawn-async.ts:45-49`).

**Workaround:** Pass `keepEnds` (such as `keepEnds: 200_000`) for test runs and check executions that produce extensive logs (`packages/kit/src/spawn-async.ts:14-15`, `packages/kit/src/spawn-async.ts:24-25`). When `keepEnds` is supplied, processes are never killed due to output volume, and `createCapture` retains stream beginnings and ends (`packages/kit/src/output-capture.ts:2-19`).

### Evicted secrets are no longer masked

**Problem:** When the registry evicts a value, later `redactKnown` calls no longer mask it; the cache limit and eviction rule are documented in [Secret redaction and credential protection](features/redaction.md) (`packages/kit/src/redact.ts:71`, `packages/kit/src/redact.ts:81-85`).

**Risk:** Long-running processes that register secrets continuously will lose older secrets from memory. If an evicted secret subsequently appears in check output, logs, or retry briefs, `redactKnown` will not mask it (`packages/kit/src/redact.ts:81-85`).

**Workaround:** For critical redaction boundaries where specific secret values must be guaranteed masked, use `redactSecrets(text, values)` with explicit secret iterables rather than relying solely on the process-level `redactKnown` registry (`packages/kit/src/redact.ts:40-43`).

### Symlinks inside workspace are strictly rejected

**Problem:** `readBoundedWorkspaceFile` traverses every path segment with `lstat` and rejects any symlink with `lane_pilot_read_path_cannot_traverse_symlink` or `lane_pilot_read_target_must_be_regular_file` (`packages/kit/src/bounded-read.ts:57`, `packages/kit/src/bounded-read.ts:65`).

**Risk:** Tool calls to inspect files fail even when a symbolic link points to a target completely within the workspace root (`packages/kit/src/bounded-read.ts:53-65`).

**Workaround:** Ensure agents reference the canonical relative file path rather than symlink aliases when invoking bounded file reads (`packages/kit/src/bounded-read.ts:31`, `packages/kit/src/bounded-read.ts:57`).

## Medium

### Conservative overlap matching serializes tasks sharing literal bases

**Problem:** `ownsPathsOverlap` extracts `literalBase` prefixes to evaluate task concurrency conflicts (`packages/kit/src/owns-paths.ts:75-82`). When one task's literal base equals another's or is an ancestor directory prefix of the other's, `ownsPathsOverlap` returns `true` (`packages/kit/src/owns-paths.ts:88-92`).

**Risk:** Independent tasks operating on disjoint file patterns in the same directory tree cannot execute concurrently and are queued sequentially (`packages/kit/src/owns-paths.ts:84-87`).

**Workaround:** Narrow the literal base directory paths when defining task ownership partitions (`packages/kit/src/owns-paths.ts:75-82`).

### Secrets under 4 characters are never masked

**Problem:** `MIN_SECRET_LENGTH` is set to 4 characters (`packages/kit/src/redact.ts:9`). `secretNeedles` and `registerSecrets` ignore any string shorter than 4 characters (`packages/kit/src/redact.ts:15-19`, `packages/kit/src/redact.ts:66-68`).

**Risk:** Very short passwords, pin codes, or environment tokens (such as 1 to 3 characters) remain unmasked in outputs and persistent files (`packages/kit/src/redact.ts:9`, `packages/kit/src/redact.ts:19`).

**Workaround:** Ensure all credentials stored in environment catalogs or injected into task environments are at least 4 characters in length (`packages/kit/src/redact.ts:9`).

### Lingering background pipes delay process completion by 2 seconds

**Problem:** When a child process starts background commands that hold its standard streams open after process exit (`packages/kit/src/spawn-async.ts:58-59`), a 2000 ms grace timer is armed before resolving (`packages/kit/src/spawn-async.ts:59`).

**Risk:** Fast commands that start background daemons incur a 2-second delay before resolving (`packages/kit/src/spawn-async.ts:59`).

### Process groups are signalled only when a run is stopped

**Problem:** With `group: true`, `spawnAsync` sends `SIGTERM` to the process group and schedules `SIGKILL` after 2 seconds only for timeout or `ENOBUFS`; normal child exit does not signal the group (`packages/kit/src/spawn-async.ts:16-18`, `packages/kit/src/spawn-async.ts:39-42`).

**Risk:** A background process started by a command can remain alive after the command exits normally (`packages/kit/src/spawn-async.ts:29`, `packages/kit/src/spawn-async.ts:39-42`).

**Workaround:** Commands that must not leave background processes should manage their child lifecycle (`packages/kit/src/spawn-async.ts:16-18`, `packages/kit/src/spawn-async.ts:39-42`).

### Strict UTF-8 and null-byte rejection aborts reads on binary content

**Problem:** Files containing null bytes throw `lane_pilot_read_binary_rejected` (`packages/kit/src/bounded-read.ts:110`), and invalid UTF-8 throws `lane_pilot_read_not_valid_utf8` (`packages/kit/src/bounded-read.ts:123`), following a `TextDecoder` configured with fatal UTF-8 enforcement (`packages/kit/src/bounded-read.ts:71`).

**Risk:** Attempting to read compiled binaries, compressed files, images, or files with invalid UTF-8 byte sequences throws `lane_pilot_read_binary_rejected` or `lane_pilot_read_not_valid_utf8` (`packages/kit/src/bounded-read.ts:110`, `packages/kit/src/bounded-read.ts:123`).

**Workaround:** Target text-based source files when using bounded workspace reads (`packages/kit/src/bounded-read.ts:110-123`). Binary formats require specialized tools.

### Root package import pulls Node built-ins into browser bundles

**Problem:** The root entry point of `@lane-pilot/kit` imports Node runtime built-ins from child modules (`packages/kit/src/index.ts:1-15`, `packages/kit/package.json:4`).

**Risk:** Importing `@lane-pilot/kit` from client-side UI code causes bundler failures in browser environments (`packages/kit/package.json:4`, `packages/kit/package.json:11-15`).

**Workaround:** UI code must import browser-safe subpaths directly: `@lane-pilot/kit/owns-paths` for path matching and `@lane-pilot/kit/prompt-coverage` for schema validation (`packages/kit/package.json:13-14`).

## Low

### Non-absence filesystem errors propagate through `readTextOrNull`

**Problem:** `isFsAbsent` only treats `ENOENT` and `ENOTDIR` as absence (`packages/kit/src/miss.ts:11-14`).

**Risk:** Attempting to read a directory as a file throws `EISDIR`, and reading files with restricted permissions throws `EACCES` rather than returning `null` (`packages/kit/src/miss.ts:41-43`).

**Workaround:** Handle non-absence filesystem errors at the call site; `readTextOrNull` rethrows them instead of returning `null` (`packages/kit/src/miss.ts:38-47`).

### Hook commands with shell metacharacters lose structured shape

**Problem:** `hookCommandWords` rejects any command containing shell operators (`;`, `&`, `|`, `<`, `>`, `$`, backticks, wildcards) (`packages/kit/src/hook-shape.ts:11-28`).

**Risk:** Shell scripts with pipes or variable expansions return `null` for `hookCommandShape`, falling back to exact trimmed string comparison in `hookCommandIdentity` (`packages/kit/src/hook-shape.ts:40-45`, `packages/kit/src/hook-shape.ts:48-52`).

**Workaround:** Define hook commands using standard command syntax without inline shell pipelines or expansions (`packages/kit/src/hook-shape.ts:40-45`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Bounded workspace file reads](features/bounded-reads.md)
- [Path ownership and task overlap matching](features/path-ownership.md)
- [Async process spawning and output handling](features/process-spawning.md)
- [Prompt vocabulary and schema enum coverage](features/prompt-coverage.md)
- [Secret redaction and credential protection](features/redaction.md)
- [Resilience, absence detection, and best effort](features/resilience-and-absence.md)
- [System paths, hashing, hooks, and value helpers](features/system-helpers.md)
- [Kit workspace overview](overview.md)
