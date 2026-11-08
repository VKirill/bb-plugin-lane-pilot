---
title: Bounded workspace file reads
type: component
created: 2026-11-08
updated: 2026-11-08
status: active
confidence: high
tags: [kit, bounded-read, security, filesystem]
sources:
  - packages/kit/src/bounded-read.ts
  - packages/kit/src/hash.ts
  - packages/kit/package.json
  - packages/kit/tests/bounded-read.test.ts
  - src/rooms/tools/server/tools.ts
---

# Bounded workspace file reads

TL;DR: `readBoundedWorkspaceFile` provides bounded file reads for workspace inspection tools with strict path validation, symlink traversal prevention, binary rejection, and line/byte caps (`packages/kit/src/bounded-read.ts:28-87`).

## Purpose

The bounded read helper implements the file reading protocol for the `lane_pilot_read` tool (`packages/kit/src/bounded-read.ts:6`). It allows agents to inspect source files while preventing path traversal outside the project directory, rejecting any symbolic link, rejecting non-UTF-8 or binary assets, and capping returned memory slices (`packages/kit/src/bounded-read.ts:35-68`).

## How it works

1. **Verify workspace root:** The helper checks `projectCwd` with `lstat`; if the path is not a directory or is a symbolic link, it throws an error (`packages/kit/src/bounded-read.ts:35-38`). It then resolves the canonical path with `realpath` (`packages/kit/src/bounded-read.ts:39`).
2. **Syntactic path validation:** The relative path is normalized to forward slashes. The call fails if the path is absolute, contains null bytes or backslashes, includes empty or relative segments (`.` or `..`), starts with a Windows drive letter, or exceeds 1024 characters (`packages/kit/src/bounded-read.ts:40-51`).
3. **Segment-by-segment traversal check:** Each path component is joined incrementally from the root and inspected via `lstat`. Any symlink encountered aborts execution. Intermediate components must be directories, and the target leaf must be a regular file (`packages/kit/src/bounded-read.ts:53-60`).
4. **Boundary escape verification:** The canonical target path is checked via `relative(rootReal, actual)`. If the path escapes the workspace root, or if the target is a symbolic link, execution halts (`packages/kit/src/bounded-read.ts:61-65`).
5. **Pre-read size check:** The file size reported by `lstat` is compared against `BOUNDED_READ_MAX_FILE_BYTES` (8 MB); exceeding files are rejected before stream allocation (`packages/kit/src/bounded-read.ts:66-68`).
6. **Streaming read:** The file is consumed via `createReadStream` using 64 KB chunks (`packages/kit/src/bounded-read.ts:104-106`). If `scannedBytes` exceeds `BOUNDED_READ_MAX_FILE_BYTES`, reading halts (`packages/kit/src/bounded-read.ts:107-109`). Chunks with null bytes throw `lane_pilot_read_binary_rejected` (`packages/kit/src/bounded-read.ts:110`). Stream bytes update the `hash` digest and are decoded via `decoder` (`packages/kit/src/bounded-read.ts:70-71`, `packages/kit/src/bounded-read.ts:111-125`).
7. **Line slicing and byte bounds:** Lines are split on newlines. Lines before `offset` are skipped. Subsequent lines accumulate until `maxLines` count is reached (`packages/kit/src/bounded-read.ts:85-90`), while `acceptLine` continues counting `totalLines` to the end of the file (`packages/kit/src/bounded-read.ts:81-84`). When slice bytes exceed `BOUNDED_READ_MAX_SLICE_BYTES` (256 KB), collection stops (`packages/kit/src/bounded-read.ts:91-101`).
8. **Result assembly:** The `BoundedReadResult` payload returned from `readBoundedWorkspaceFile` sets `LANE_PILOT_READ_SCHEMA_VERSION` along with line numbers and truncation flags (`packages/kit/src/bounded-read.ts:28-34`, `packages/kit/src/bounded-read.ts:132-147`).

### Modes, variants, and thresholds

| Boundary or parameter | Condition or limit | Consequence | Evidence |
|---|---|---|---|
| `BOUNDED_READ_MAX_FILE_BYTES` | 8 MB (8,388,608 bytes) | Files exceeding this limit throw `lane_pilot_read_file_exceeds_8388608_bytes` | `packages/kit/src/bounded-read.ts:8`, `packages/kit/src/bounded-read.ts:66-68` |
| `BOUNDED_READ_MAX_SLICE_BYTES` | 256 KB (262,144 bytes) | When accumulated line bytes exceed 256 KB, line collection stops and `truncated` is set to `true` | `packages/kit/src/bounded-read.ts:9`, `packages/kit/src/bounded-read.ts:94-98` |
| Chunk buffer size | 64 KB (65,536 bytes) | Streaming read buffer allocation for `createReadStream` | `packages/kit/src/bounded-read.ts:104` |
| Max path length | 1024 characters | Paths longer than 1024 characters throw `lane_pilot_read_path_escaped_workspace` | `packages/kit/src/bounded-read.ts:48-50` |
| Null byte detection | Byte `0x00` in chunk | Throws `lane_pilot_read_binary_rejected` | `packages/kit/src/bounded-read.ts:110` |
| UTF-8 encoding | Invalid UTF-8 sequence | Throws `lane_pilot_read_not_valid_utf8` | `packages/kit/src/bounded-read.ts:123` |
| Line budget | `idx >= offset + maxLines` | Line collection halts and `truncated` is set to `true` | `packages/kit/src/bounded-read.ts:86-90` |

### Failures

| Failure condition | Resulting error | Evidence |
|---|---|---|
| Root is symlink or not directory | `Error("writer workspace root must be a real directory")` | `packages/kit/src/bounded-read.ts:35-38` |
| Illegal path syntax or escape | `Error("lane_pilot_read_path_escaped_workspace")` | `packages/kit/src/bounded-read.ts:43-51`, `packages/kit/src/bounded-read.ts:63` |
| Symlink in path traversal | `Error("lane_pilot_read_path_cannot_traverse_symlink")` | `packages/kit/src/bounded-read.ts:57` |
| Parent segment not directory | `Error("lane_pilot_read_parent_must_be_directory")` | `packages/kit/src/bounded-read.ts:58` |
| Target not a regular file | `Error("lane_pilot_read_target_must_be_regular_file")` | `packages/kit/src/bounded-read.ts:59`, `packages/kit/src/bounded-read.ts:65` |
| File size over limit | `BOUNDED_READ_MAX_FILE_BYTES` exceeded | Throws size limit error | `packages/kit/src/bounded-read.ts:66-68` |
| Null byte in stream | `Error("lane_pilot_read_binary_rejected")` | `packages/kit/src/bounded-read.ts:110` |
| Non-UTF-8 stream encoding | `Error("lane_pilot_read_not_valid_utf8")` | `packages/kit/src/bounded-read.ts:123` |

## Business rules

- **Workspace confinement:** Files cannot be read outside `projectCwd`, nor may any intermediate or target path component be a symlink (`packages/kit/src/bounded-read.ts:35-65`).
- **Full-stream verification:** The SHA-256 hash and `totalLines` reflect the complete file, even when the returned content slice is truncated by `maxLines` or the 256 KB slice limit (`packages/kit/src/bounded-read.ts:70-75`, `packages/kit/src/bounded-read.ts:138-145`).
- **Line indices:** Input `offset` is 0-based, while returned `lineStart` is 1-based (`input.offset + 1`); `lineEnd` equals `input.offset + selected.length` (or `offset` if empty) (`packages/kit/src/bounded-read.ts:143-144`).
- **Trailing newline preservation:** Files ending in a trailing newline emit an empty final line rather than omitting the trailing line break (`packages/kit/src/bounded-read.ts:128`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `LANE_PILOT_READ_NAME` | `const string` | Tool name constant (`"lane_pilot_read"`) | `packages/kit/src/bounded-read.ts:6` |
| `LANE_PILOT_READ_SCHEMA_VERSION` | `const number` | Result schema version (`1`) | `packages/kit/src/bounded-read.ts:7` |
| `BOUNDED_READ_MAX_FILE_BYTES` | `const number` | Maximum allowable file size in bytes (`8388608`) | `packages/kit/src/bounded-read.ts:8` |
| `BOUNDED_READ_MAX_SLICE_BYTES` | `const number` | Maximum content slice size in bytes (`262144`) | `packages/kit/src/bounded-read.ts:9` |
| `BoundedReadResult` | `type` | Structured response containing content, hash, lines, and truncation flags | `packages/kit/src/bounded-read.ts:11-26` |
| `readBoundedWorkspaceFile` | `function` | Secure streaming workspace file reader | `packages/kit/src/bounded-read.ts:28-87` |

## Gotchas

- **In-workspace symlinks blocked:** Even if a symlink targets a file entirely within the workspace, `readBoundedWorkspaceFile` rejects it with `lane_pilot_read_path_cannot_traverse_symlink` or `lane_pilot_read_target_must_be_regular_file` (`packages/kit/src/bounded-read.ts:57`, `packages/kit/src/bounded-read.ts:65`). See [Kit gotchas](../gotchas.md).
- **Slice boundary truncation:** When a file line is very long, the 256 KB slice cap can truncate the result before reaching `maxLines` (`packages/kit/src/bounded-read.ts:94-98`). Callers must inspect `result.truncated`.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
