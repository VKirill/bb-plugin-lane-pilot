---
title: The task folder (one home per task, lp.task-manifest/1)
type: component
created: 2026-11-14
updated: 2026-11-14
status: active
confidence: medium
tags: [sma, tasks, writer, handoff, manifest]
sources:
  - src/rooms/storage/task-manifest.ts
  - src/rooms/writer/server/task-home.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/dispatch-workflow.ts
  - src/rooms/writer/server/spawn-brief.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/critique-gate.ts
  - src/rooms/writer/server/plan-fact.ts
  - src/rooms/writer/server/finish-attempt-body.ts
  - src/rooms/writer/server/attempt-reactions.ts
  - src/rooms/tasks/server/contract-lint.ts
  - src/rooms/native-agent/server/helper-bb-shim.ts
  - lane-stack/hooks/guard_shell.py
  - src/rooms/migrations.ts
  - tests/task-manifest.test.ts
  - tests/task-home-transitions.test.ts
  - tests/lp-drill-task-home.test.ts
  - scripts/lp_drill/scenes/task_home.py
---

# The task folder

Everything of one task lives in one folder, its **home**: `.agents/tasks/<task-id>/` in the task's base checkout. The
home holds the contract, the plan text, the plan critic's verdicts, every attempt's brief, report, checks, critique rounds
and notes, the acceptance receipts, the outcome and the lessons. A `manifest.json` in the home lists every file. Nodes of
the main path pass each other `{task_id, kind}` and find the file through the manifest. Nothing searches a folder.

This is the owner's rule 4б (`sma-parity-tz.md`) and step 1 of the handoff audit (`handoff-map.md` §5.2). Step 2 (the
workflow engine's step packets, `consumes`, `fs.write` and the other graphs) is still open.

## Where the home is (one root rule)

The home is under the **task's base checkout**, the same folder `taskBasePath` names. The old `.agents/plans/items/<id>/`
used the same rule. `.agents/tasks/` is not a planning path (`isPlanningPath` and `planningText` don't match it), so a
project with a separate planning home never splits a task between two roots. `openTaskHome` is idempotent: the first
base a task gets is kept, and a task never moves.

`.agents/tasks/` is git-excluded (`**/.agents/tasks/`, the line that excluded `**/.agents/plans/items/` before). A merge
never carries a home to main, and removing a worktree never removes a home: the home in the base is the record.

## Layout

```
.agents/tasks/<task-id>/
  manifest.json                     rendered from the database; agents never write it
  contract.v1.json                  the contract at dispatch; contract.v<N>.json per lane_pilot_update_task edition
  PLAN.md                           the plan TEXT (a plan that was one path line is replaced by that file's text)
  PLAN.v<N>.md                      the plan of contract edition N (lane_pilot_update_task or a planner round), superseding the last
  context/plan-source.md            the shared .agents/plans/* files the plan named: source_path + sha256 + their text
  REFLEXES.md, FILECARDS.md         the guard hook's notes for this task
  critique/plan.r<K>.json           plan-critique verdict K (it records the PLAN.md sha it judged)
  attempts/<attempt-id>/
    brief.md                        what the writer was given
    report.md                       the writer's real thread output (kind writer-report)
    checks.json                     every check: command, exit code, duration, log path
    logs/NN-<cmd>.log               a failed check's full output (kind check-log)
    plan-fact.json                  plan against fact, naming the report it read
    barrier-input.json              what the code critic judged
    code-critique.r<K>.json         critique round K: verdict and repair ledger
    PROGRESS.md, QA.md              the attempt's journal and Q&A
    QUESTIONS.md, CHECKPOINT.md     the writer's notes, copied back from the worktree by plugin code
  acceptance.json, receipt.json     written once, in the base, at acceptance
  OUTCOME.md, lessons.md            the close: state, merge, changed files; each attempt's LESSON line
```

The PM sees `acceptancePath` pointing at `.agents/tasks/<id>/acceptance.json` in the base. The file is still there after
the merge removes the worktree.

## The manifest (`lp.task-manifest/1`)

The source of truth is three additive tables: `lane_pilot_task_home` (one row per task: project, run, base path, host,
phase), `lane_pilot_task_file` (one row per file: path in the home, kind, attempt, round, sha256, bytes, producer, plugin
version, declared readers, supersedes / superseded_by) and `lane_pilot_task_file_read` (every read: reader, sha256,
legacy flag). `recordTaskFile` is the only writer. It writes the file, then its row, then `manifest.json` again. Writes
of one task's manifest are serialized.

```json
{
  "schema": "lp.task-manifest/1",
  "task_id": "t-42", "project_id": "proj_x", "run_id": "lprun_x", "phase_id": null,
  "parent": { "kind": "run", "id": "lprun_x" },
  "contract": { "edition": 1, "sha256": "…", "path": "contract.v1.json" },
  "files": [
    { "path": "PLAN.md", "kind": "plan", "produced_by": { "node": "dispatch", "graph": "lp-task-pipeline", "stage_id": "dispatch" },
      "plugin_version": "0.1.560", "sha256": "…", "bytes": 812, "created_at": 1763100000000,
      "readers": ["pm-read", "plan-critique", "writer"],
      "read_by": [{ "node": "pm-read", "at": 1763100001000, "sha256": "…" }] }
  ],
  "legacy": []
}
```

The closed list of kinds is `TASK_FILE_KINDS` in `src/rooms/storage/task-manifest.ts`. A task of a phase names the phase
as its `parent`, with the phase's manifest path given as a reference.

## The resolver

`resolveTaskFile(db, taskId, kind, { attemptId? })` returns the one current file of that kind. "Current" means the end of
the `supersedes` chain, never "newest by time". Two current rows of one kind are ambiguous, and the resolver returns null
instead of guessing (SMA n132). `readTaskFile` also reads the file, records the read in `read_by`, and flags `drift` when
the content no longer matches the hash in the row. Main-path readers today: pm-read and plan-critique read `PLAN.md`;
plan-fact and lessons read `report.md`; lessons read `acceptance.json`. A stage whose manifest has no `PLAN.md` stops. It
does not fall back to an in-memory plan.

A failed write of the home at dispatch (contract, `PLAN.md`, plan-source) **stops the dispatch**: the task gets no
attempt. The same holds if the home can't be placed into the worktree at spawn. Later best-effort records (QA, progress)
log a failure and go on.

## What a worktree gets

`placeTaskHome` copies the files the task's manifest lists, plus `manifest.json`, into the worktree under the same path.
It copies nothing of another task and never a folder listing (SMA n397, n405). The spawn gives the writer's thread
`laneTaskDir`, so the provider env resolvers set `LANE_TASK_DIR`. The guard hook (`guard_shell.py`) reads `REFLEXES.md` /
`FILECARDS.md` only from that folder. On the old layout it uses `LANE_TASK_FILE`. The old "newest task folder by mtime"
fallback is gone.

A helper's writes under `.bb/chats/` are limited to the chats in `LANE_PILOT_CHATS`: its own thread and its PM chat, from
the thread metadata. With no list, every chat folder is refused.

## read_first rules

`readFirstScopeFindings` (contract-lint) refuses a `read_first` entry that points:

- into another task's home (`.agents/tasks/<other>/`), with code `read_first_foreign_task`;
- into the shared `.agents/plans/*`, except the task's own old `.agents/plans/items/<id>/`, with code `read_first_shared_plan`. Send
  the plan as text, or the path as the whole plan, and the dispatch snapshots it into `context/plan-source.md`;
- into another chat's `.bb/chats/<id>/` (anything but the dispatching PM chat), with code `read_first_foreign_chat`.

## Old files (the rule for the switch)

- Nothing old is deleted.
- New records go only to the new layout, starting from the commit that switched the writer. A task dispatched before the
  switch has no `lane_pilot_task_home` row and finishes on the old layout. One task never mixes the two layouts.
- For an old task, the resolver reads the kind's **fixed old path by exact name** (`legacyTaskFilePath`, for example
  `.agents/plans/items/<id>/PLAN.md` or `.agents/runs/<run>/artifacts/<id>/acceptance.json`). It never uses a glob. Each
  such read is counted (`legacyReadCount`). The old reader can go once the count has stayed at 0 for 30 days.
- A task with a home never falls back to an old path. If its manifest lacks a kind, the resolver returns null.

## How to inspect a task's home

```bash
cat <base>/.agents/tasks/<task-id>/manifest.json | jq '.files[] | {kind, path, read_by: [.read_by[].node]}'
sqlite3 <lane-pilot.db> "select kind, path, attempt_id, round, superseded_by from lane_pilot_task_file where task_id='<task-id>' order by created_at"
sqlite3 <lane-pilot.db> "select count(*) from lane_pilot_task_file_read where legacy=1 and at > (strftime('%s','now','-30 days')*1000)"
```

The drill scene `task_home` (`python3 scripts/lp-drill.py --scenario task_home`, also in the `--series` suite `task`) runs
two note tasks through the main path. It passes only if each home's manifest lists every expected kind, the files are
there after the worktrees went, and nothing new appeared in `.agents/plans/`, `.agents/planning/`,
`.agents/runs/<run>/artifacts/` or `.bb/chats/` for those tasks.
