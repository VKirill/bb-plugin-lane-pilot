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
  - src/rooms/storage/run-manifest.ts
  - src/rooms/workflow/server/workflow-run-home.ts
  - src/rooms/workflow/server/workflow-checkout-actions.ts
  - src/rooms/workflow/server/workflow-executors.ts
  - packages/workflow-engine/src/handoff.ts
  - tests/workflow/run-home.test.ts
  - scripts/lp_drill/scenes/run_home.py
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

This is the owner's rule 4б (`sma-parity-tz.md`) and step 1 of the handoff audit (`handoff-map.md` §5.2). Step 2, the same
idea for a workflow-graph run, is «The run folder» below.

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
of one task's manifest are serialized. Every one of these writes replaces the file and a write the bb core does not apply
throws: in the core `expectedSha256: null` means "the file must not exist" and answers `conflict` (HTTP 200, nothing
written) for a file that exists, so the task home writes through `writeReplacing` (no `expectedSha256` key). Until 0.1.567 it passed `null`, and `manifest.json` stayed at its first render.

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
plan-fact and lessons read `report.md`; lessons read `acceptance.json`; code-critique reads `context/plan-source.md` when
the plan named shared `.agents/plans/*` files. A stage whose manifest has no `PLAN.md` stops. It
does not fall back to an in-memory plan.

The code critic resolves a shared plan reference the same way: its prompt names the snapshot's repository path
(`.agents/tasks/<task-id>/context/plan-source.md`), and the snapshot's content hash is part of the stage input, so a
rewritten snapshot re-runs the critique. A homed task whose plan names shared files the snapshot does not cover — or
whose snapshot cannot be read — is a named `code_critique_plan_source_*` block before any critic spawns; the shared
`.agents/plans/` path itself is never read (0.1.570 live drill `task_home`).

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
two note tasks with `quality_mode: "full"` through the main path, including both critics even when ordinary sandbox tasks skip them. It passes only if each home's manifest lists every expected kind, the files are
there after the worktrees went, and nothing new appeared in `.agents/plans/`, `.agents/planning/`,
`.agents/runs/<run>/artifacts/` or `.bb/chats/` for those tasks.

## The run folder (step 2: a workflow-graph run, `lp.run-manifest/1`)

A graph run's nodes hand each other values by the engine's journal (`lane_pilot_wf_step.output_json`), not by folders. What they write
into the checkout, and what the engine spills for a long input, is listed in the run's own manifest, `.agents/runs/<run-id>/manifest.json`
in the checkout its nodes write to (`wfrun_<32 hex>`; the task pipeline's `lprun_*` folders are the task's old attempt artifacts and stay
as they were). The folder is made by the run's first file: a run that writes nothing gets none.

The source of truth is three additive tables (`lane_pilot_run_home`, `lane_pilot_run_file`, `lane_pilot_run_file_read`); the file is their
rendering. The module (`src/rooms/storage/run-manifest.ts`) is the sibling of the task manifest and reuses its `TaskFileIo` and producer
shape; the tables are separate because a run has no contract, attempts or `supersedes` chain, and its key is the engine's run id.

```json
{ "schema": "lp.run-manifest/1", "run_id": "wfrun_…", "project_id": "proj_x", "workflow_id": "web-research", "parent": null,
  "files": [ { "path": ".agents/research/research-2026-11-14-tides-wfrun_….md", "root": "checkout", "kind": "output",
               "produced_by": { "node": "deliver", "graph": "web-research", "run_id": "wfrun_…", "wf_step_key": "…" },
               "plugin_version": "0.1.568", "sha256": "…", "bytes": 4120, "created_at": 1763100000000,
               "replaces": "wfrun_old:.agents/research/…", "readers": ["done"], "read_by": [] } ] }
```

Kinds (`RUN_FILE_KINDS`): `output` (a file an `fs.write` node wrote, in the checkout or the planning home, per the row's `root`),
`step-input` (the engine's spill of a long step input), `latest-pointer` (a file at a fixed path that every run replaces on purpose).
`readers` are the nodes the writing node's edges lead to (declared); `read_by` is what `readRunFile` recorded. A reader asks
`resolveRunFile(db, runId, {kind, nodeId | repoPath})` or `readRunFile(...)`; two files that fit the question mean no answer, never
«the newest». Recording a file is best effort for the node (the file is already written): a failed manifest write is logged, and the
next record renders it again.

### Where a graph's files go now

- **`fs.write`** registers every file it wrote (checkout and planning home alike) in the run's manifest. 15 graphs wrote by `{{date}}`
  or `{{slug}}` alone (`about-site`, `reels`, `resume`, `seo-brief`, `seo-cocoon`, `seo-drop-diagnosis`, `seo-monitor`,
  `seo-page-refresh`, `seo-project-intake`, `seo-research`, `seo-structure-audit`, `seo-tech-audit`, `web-research`,
  `x-to-telegram-digest`, `year-review`); their path now carries `{{run_id}}`, so two runs of one day or one topic never share a
  folder, and the consumer is handed its own run's folder by the node's output. A test (`R8`) fails any shipped graph whose `fs.write`
  path has `{{date}}` or `{{slug}}` and no `{{run_id}}`.
- **What a rerun does.** `fs.write` reads the file first and writes with its hash: a rerun on the same path **replaces** it (it never
  keeps yesterday's file, and it never fails on `conflict`). When the path was last written by another run, the new row says so
  (`replaces: <run>:<path>`) and the log says it. Re-running the same run (`wfrun_…` unchanged) replaces its own file.
- **The step-input spill** stays where the PM chat reads it, `.bb/chats/<pm-chat>/artifacts/wf-<run>/<name>.<sha8>.*`, and the run's
  manifest names it (`step-input`, with the step that was given it as reader). A run with no PM chat (a scheduled graph) now spills into
  its own folder, `.agents/runs/<run-id>/inputs/`, not into a shared `.bb/chats/chat/` pseudo-chat.
- **`consumes`** without `from` is satisfied only by an upstream step of this run that produced the artifact. The old fallback, «any
  artifact of that kind anywhere in the project», is gone: a consumer that wants something from elsewhere says `from: "$inputs"` or an
  earlier node.
- **«Latest» files.** `sp.run_script` writes its report at `.agents/<domain>/reports/<graph>-<node>.json` and, when its `args` carry
  `latest_out`, the pointer file there (the script's output plus `produced_by: {run_id, workflow_id, node_id}`). Both are `latest-pointer`
  rows: a daily job's file that the next run replaces by design. `resolveLatestPointer(db, project, path)` names the run that wrote the
  current one; the specialist memory loader reads the PPC bridge through it, records the read and returns `ppc_bridge_run_id` (empty when
  the file no longer matches the record).
- **Write contracts that are create-only on purpose** are unchanged (the agent-instruction pointers, forge drafts). `lp.retro_living`
  and `lp.milestone_archive` wrote with `expectedSha256: null`, which BB answers with `conflict` over an existing file without throwing:
  the second milestone's retro or index line was silently dropped. They now replace through the same read-then-hash write.

### Old files and what is not done

Nothing is deleted or moved. Files of earlier runs stay where they are; a graph's old `{{date}}` folders are still readable, and no reader
searches them. Not done: handing a consumer graph the producing run's id as an input (`seo-brief` and `seo-cocoon` still read the
bridge by the prompt's path and mask, which the `latest-pointer` now makes traceable but does not replace); recording `read_by` for what
an agent reads (it needs hooks in every provider; only plugin code reads go through the resolver); the plan critic's batch (dispatch has
no batch id; the draft id of a proposed batch is the real one and would have to travel through `dispatchWriter` and the task home).

The drill scene `run_home` (`python3 scripts/lp-drill.py --scenario run_home`, also in the `--series` suite `task`) starts `note-add`
twice through the `workflow_run` RPC with `source: "manual"` (the CLI `workflow-trigger` is for scheduled graphs), and passes only if each run's manifest lists its file in a folder keyed by that run, the
files are on disk, the two runs share no path, and a `find` of `.agents/plans`, `.agents/planning`, `.agents/todos`, `.agents/runs`
and `.bb/chats` before and after shows nothing new but the two manifests, the files they list and the documented spill.
