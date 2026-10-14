---
title: Writer validation decisions
type: decisions
created: 2026-09-23
updated: 2026-10-14
status: active
confidence: medium
tags: [writer, validation, ownership]
sources:
  - src/rooms/writer/server/verify.ts
  - src/rooms/verification/ownership.ts
  - packages/kit/src/owns-paths.ts
  - src/rooms/verification/git-integrate.ts
  - src/rooms/host-worker/host-handlers.ts
  - src/rooms/contracts/host.ts
  - tests/owns-overlap.test.ts
---

# Writer validation decisions

TL;DR: A writer attempt is accepted only when its changed paths satisfy task and run ownership, its checks pass, and its acceptance receipt validates against the upstream schema. (`src/rooms/writer/server/verify.ts:177-216`, `:350-384`).

| Input or condition | Decision | Code evidence |
|---|---|---|
| Changed file is outside `owns_paths` or matches `never_touch` | Reject ownership validation as `validation_failed` (`src/rooms/verification/ownership.ts:89-97`). | `packages/kit/src/owns-paths.ts:51-72` |
| A wildcard names a folder or folder pattern | Treat the matched folder and its descendants as owned; `*` and `?` stay within one path segment, while `**` can cross folders (`packages/kit/src/owns-paths.ts:13-29`, `:36-63`). | `tests/owns-overlap.test.ts:35-60` |
| Two tasks' ownership patterns have overlapping literal bases | Treat the tasks as potentially overlapping so a task waits; a false overlap delays work rather than allowing concurrent edits (`packages/kit/src/owns-paths.ts:74-92`). | `tests/owns-overlap.test.ts:62-70` |
| One changed path is in a shared run workspace | It is owned when at least one task owns it and that same task does not mark it `never_touch`; another task's `never_touch` does not veto the owner (`src/rooms/verification/ownership.ts:100-107`). | `src/rooms/writer/server/verify.ts:350-384` |
| A verification command exits nonzero once, then passes on its second run | Keep the passing result and mark it flaky; do not rerun exit code 0 or timeout code 124 (`src/rooms/writer/server/verify.ts:28-40`). | `src/rooms/writer/server/verify.ts:113-124` |
| The main checkout moved and the attempt rebased onto it | Run the task's replay checks before merging. If a check remains red, return `conflict` with the failed checks; do not merge (`src/rooms/verification/git-integrate.ts:251-263`). | `src/rooms/host-worker/host-handlers.ts:82-101` |
| Replay check cannot run, or reports a host environment failure | Do not block integration on that check; post-merge verification still runs (`src/rooms/host-worker/host-handlers.ts:82-101`). | `src/rooms/verification/git-integrate.ts:255-263` |
| An attempt owns a bookkeeping file ignored by Git | Force-stage that owned file so it enters the attempt commit; machine-written bookkeeping not owned by the task resolves to the base checkout's version (`src/rooms/verification/git-integrate.ts:348-366`, `:399-419`). | `src/rooms/verification/git-integrate.ts:214-239` |
| Generated acceptance JSON fails upstream validation | Throw before acceptance artifacts are written (`src/rooms/writer/server/verify.ts:187-216`). | `src/rooms/writer/server/verify.ts:193-216` |

The ownership comparison uses normalized project-relative paths and rejects unsafe patterns, absolute paths, and verification working directories outside the task workspace (`src/rooms/verification/ownership.ts:17-43`). When the run scope cannot be built because a task id, project path, contract, or requested task is invalid, scope resolution returns a failure instead of an empty ownership set (`src/rooms/verification/ownership.ts:46-83`).

A failed replay check is reported as a conflict without conflict filenames; the host contract carries the check command, exit code, stdout, and stderr in the result (`src/rooms/verification/git-integrate.ts:257-261`, `src/rooms/contracts/host.ts:61-71`). A successful merged commit is followed by rebuild results for changed workspace packages (`src/rooms/verification/git-integrate.ts:263-266`).
