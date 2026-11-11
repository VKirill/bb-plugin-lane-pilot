---
title: Async process spawning and output handling
type: component
created: 2026-11-08
updated: 2026-11-11
status: active
confidence: high
tags: [kit, child-process, spawn, streams, output]
sources:
  - packages/kit/src/spawn-async.ts
  - packages/kit/src/output-capture.ts
  - packages/kit/src/output-excerpt.ts
  - packages/kit/package.json
  - packages/kit/tests/spawn-async.test.ts
  - packages/kit/tests/output-excerpt.test.ts
  - src/rooms/checkers/drill.ts
---

# Async process spawning and output handling

TL;DR: `spawnAsync` executes child processes without blocking the Node event loop (`packages/kit/src/spawn-async.ts:20-60`), while `failureExcerpt` and `cleanCheckOutput` sanitize outputs (`packages/kit/src/output-excerpt.ts:20-42`).

## Purpose

Host daemon workers avoid blocking in synchronous execution via `spawnAsync` (`packages/kit/src/spawn-async.ts:8-20`), and clean logs via `cleanCheckOutput` (`packages/kit/src/output-excerpt.ts:20-29`).

## How it works

1. **Child process initialization:** `spawnAsync` executes `child_process.spawn` with `windowsHide: true`, configuring `stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]` (`packages/kit/src/spawn-async.ts:20-38`).
2. **Standard input dispatch:** When `options.input` is passed, the string is written to `child.stdin` and closed immediately (`packages/kit/src/spawn-async.ts:38`).
3. **Stream accumulation strategy:**
   - **Default buffering:** Accumulates chunks into memory arrays. If accumulated stream size exceeds `maxBuffer` (default 1 MB per stream), the process is sent `SIGTERM` and terminated with code `ENOBUFS` (`packages/kit/src/spawn-async.ts:22-24`, `packages/kit/src/spawn-async.ts:45-49`).
   - **`keepEnds` capture:** When `options.keepEnds` is set, instances of `createCapture` handle output streams without buffer errors (`packages/kit/src/spawn-async.ts:24-25`, `packages/kit/src/output-capture.ts:2-6`).
4. **Head/tail stream retention (`createCapture`):** `createCapture(cap)` divides the byte budget into `headMax = Math.floor(cap / 4)` and `tailMax = cap - headMax` (`packages/kit/src/output-capture.ts:2-3`). Early bytes fill `head`. Subsequent bytes append to `tail`; when `tail` exceeds `tailMax`, older excess bytes are dropped and counted in `dropped` (`packages/kit/src/output-capture.ts:8-16`). `text()` returns either the combined content or formatted head and tail slices separated by `\n[... ${dropped} bytes cut ...]\n` (`packages/kit/src/output-capture.ts:18`).
5. **Execution timeout:** If `options.timeout` is specified, a timer fires after the elapsed milliseconds, sending `SIGTERM` and setting `error.code = "ETIMEDOUT"` (`packages/kit/src/spawn-async.ts:39-44`).
6. **Background process decoupling:** If a spawned command starts a background daemon that holds open standard output or error descriptors, the exit event triggers a 2000 ms `grace` timer (`packages/kit/src/spawn-async.ts:58-59`). Once the timer expires, the promise settles with the exit status without waiting indefinitely for stream closures.
7. **Stream sanitization:**
   - `stripAnsi` removes ANSI terminal escape codes and CSI formatting (`packages/kit/src/output-excerpt.ts:10-11`).
   - `cleanCheckOutput` invokes `redactKnown`, strips OSC escape sequences, CSI control codes, non-printable ASCII characters (U+0000..U+0008, U+000B..U+001F, U+007F), npm notice lines with npx spinner prefixes, spinner-only residue lines, and repeated blank lines (`packages/kit/src/output-excerpt.ts:20-29`).
8. **Failure extraction:** `failureExcerpt(text, limit)` searches cleaned text for `FAIL`, `AssertionError`, `Error:`, `Expected`, `Received`, TypeScript `error TS`, or any line containing `error` or `fail`, case-insensitively (`packages/kit/src/output-excerpt.ts:13-14`, `packages/kit/src/output-excerpt.ts:36-40`). It extracts up to `limit` characters (default 1500) from the first matching line, then appends `Test Files` and `Tests` summary lines if they fall outside the excerpt (`packages/kit/src/output-excerpt.ts:16-17`, `packages/kit/src/output-excerpt.ts:36-42`). Without a match, it returns the cleaned tail (`packages/kit/src/output-excerpt.ts:40`).

### Modes, variants, and thresholds

| Setting or threshold | Value | Purpose | Evidence |
|---|---|---|---|
| Default `maxBuffer` | 1 MB (1,048,576 bytes) | Buffer limit per stream when `keepEnds` is omitted; triggers `ENOBUFS` termination | `packages/kit/src/spawn-async.ts:22`, `packages/kit/src/spawn-async.ts:47-49` |
| `keepEnds` head ratio | 25% (`Math.floor(cap / 4)`) | Proportion of `keepEnds` budget reserved for the beginning of stream output | `packages/kit/src/output-capture.ts:3` |
| `keepEnds` tail ratio | 75% (`cap - headMax`) | Proportion of `keepEnds` budget reserved for the end of stream output | `packages/kit/src/output-capture.ts:3` |
| Pipe grace timer | 2000 ms | Delay after process exit before resolving if streams remain unclosed | `packages/kit/src/spawn-async.ts:59` |
| `group` | `true` or omitted/`false` | Starts a process-group leader; only timeout and `ENOBUFS` signal the group, with `SIGKILL` scheduled 2 seconds after `SIGTERM` | `packages/kit/src/spawn-async.ts:16-18`, `packages/kit/src/spawn-async.ts:29-42` |
| Default `failureExcerpt` limit | 1500 characters | Maximum length of failure details extracted from check output | `packages/kit/src/output-excerpt.ts:36` |

### Failures

| Failure condition | Behavior and error | Evidence |
|---|---|---|
| Execution timeout elapsed | Process sent `SIGTERM`; `error.code = "ETIMEDOUT"`; `status: null`; `signal: "SIGTERM"` | `packages/kit/src/spawn-async.ts:39-44` |
| `maxBuffer` exceeded (without `keepEnds`) | Process sent `SIGTERM`; `error.code = "ENOBUFS"`; `status: null`; `signal: "SIGTERM"` | `packages/kit/src/spawn-async.ts:39-42`, `packages/kit/src/spawn-async.ts:45-49` |
| Timeout or `ENOBUFS` with `group: true` | Sends `SIGTERM` to the process group and schedules `SIGKILL` for the group after 2 seconds | `packages/kit/src/spawn-async.ts:39-42` |
| Binary missing or unexecutable | Process error event triggers; `status: null`; `pid: undefined` | `packages/kit/src/spawn-async.ts:53-56` |

## Business rules

- **Non-blocking host seam:** Host worker routines must execute external processes through `spawnAsync` (`packages/kit/src/spawn-async.ts:20-22`).
- **Verdict preservation under high output:** When `keepEnds` is supplied to `spawnAsync`, output volume does not terminate execution (`packages/kit/src/spawn-async.ts:14-18`, `packages/kit/src/spawn-async.ts:24-25`), and `createCapture` retains stream boundaries (`packages/kit/src/output-capture.ts:2-6`).
- **Lingering pipe cutoff:** Child processes that fork background processes retaining inherited descriptors are cut off after the `grace` timeout (`packages/kit/src/spawn-async.ts:58-59`).
- **Process-group scope:** `group: true` kills the process group only when a timeout or output-buffer limit stops the command; a normal child exit does not signal remaining group members (`packages/kit/src/spawn-async.ts:16-18`, `packages/kit/src/spawn-async.ts:39-42`).
- **Summary retention:** `failureExcerpt` always retains lines matching `SUMMARY_MARK` (`Test Files` or `Tests`) even when the failure diff exceeds the character limit (`packages/kit/src/output-excerpt.ts:17`, `packages/kit/src/output-excerpt.ts:40`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `SpawnResult` | `type` | Execution result containing pid, status, signal, stdout, stderr, and optional error | `packages/kit/src/spawn-async.ts:4-6` |
| `spawnAsync` | `function` | Non-blocking child process runner | `packages/kit/src/spawn-async.ts:20-60` |
| `createCapture` | `function` | Fixed-capacity stream capture tracking head, tail, and dropped bytes | `packages/kit/src/output-capture.ts:2-20` |
| `stripAnsi` | `function` | Removes ANSI escape sequences from text | `packages/kit/src/output-excerpt.ts:10-11` |
| `cleanCheckOutput` | `function` | Redacts known secrets and removes escape sequences, controls, npm notice/spinner residue and repeated blank lines | `packages/kit/src/output-excerpt.ts:20-29` |
| `failureExcerpt` | `function` | Extracts failure details and run summaries from test output | `packages/kit/src/output-excerpt.ts:36-42` |

## Gotchas

- **Default 1 MB output cap:** Omitting `keepEnds` triggers `ENOBUFS` when stream bytes exceed `maxBuffer` (`packages/kit/src/spawn-async.ts:22-49`). Check runners and test commands that output large logs must supply `keepEnds`. See [Kit gotchas](../gotchas.md).
- **Background child pipe leaks:** Background tasks that hold pipe descriptors open delay resolution until the `grace` timer expires (`packages/kit/src/spawn-async.ts:58-59`).
- **Process-group scope:** `group: true` kills the process group only when a timeout or output-buffer limit stops the command; a normal child exit does not signal remaining group members (`packages/kit/src/spawn-async.ts:16-18`, `packages/kit/src/spawn-async.ts:39-42`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
