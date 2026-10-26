---
title: Plan against fact and the acceptance card
type: component
created: 2026-10-22
updated: 2026-10-26
status: active
confidence: low
tags: [sma, acceptance, critic, ui]
sources:
  - src/rooms/tasks/plan-fact.ts
  - src/rooms/writer/server/plan-fact.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/writer/server/writer-task.ts
  - src/rooms/writer/server/critic-override.ts
  - src/rooms/critique/quality-mode.ts
  - src/rooms/acceptance/card.ts
  - src/rooms/acceptance/ui/acceptance-card.tsx
  - packages/contracts/src/stage-proof.ts
  - tests/plan-fact.test.ts
  - tests/acceptance-card-ui.test.tsx
  - packages/contracts/src/stage-contract.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/tools/server/cli.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/usage/server/attempt-metrics.ts
  - src/rooms/runs/ui/task-board.tsx
---

# Plan against fact and the acceptance card

TL;DR: the writer closes its answer with a table of its acceptance items and the evidence for each; code checks every piece of evidence against the diff and the check results without reading the writer's prose; the result is a `plan-fact` stage receipt and one block, the acceptance card, in the task page.

## How it works

1. The writer receives the `plan-fact` response format in its task brief (`src/rooms/tasks/plan-fact.ts:23`, `src/rooms/writer/server/writer-task.ts:273-337`).
2. The parser reads the last fenced table, validates its JSON shape and returns missing or invalid status when no usable table exists (`src/rooms/tasks/plan-fact.ts:36-50`).
3. The blind checker compares each evidence pointer with changed files, changed lines, contract checks, and verification results (`src/rooms/tasks/plan-fact.ts:53-134`).
4. The stage records skipped, failed, or passed; in gate mode an unproven acceptance item returns the task for correction (`src/rooms/writer/server/plan-fact.ts:33-75`, `src/rooms/tasks/plan-fact.ts:161-190`).
5. The acceptance card combines the contract, stage proofs, gate events, plan-fact findings, not-run stages, and attempt cost (`src/rooms/acceptance/card.ts:26-85`).

| Mode or failure | Result |
|---|---|
| `record` mode | Records and displays findings; a missing or invalid table is skipped and does not refuse the task (`src/rooms/writer/server/plan-fact.ts:33-75`). |
| `gate` mode | A blocking unproven item fails the stage and returns the task to the writer; missing table remains skipped (`src/rooms/writer/server/plan-fact.ts:33-75`). |
| Missing or invalid table | Stores a skipped receipt with its reason (`src/rooms/tasks/plan-fact.ts:36-50`, `src/rooms/writer/server/plan-fact.ts:33-75`). |
| Evidence does not match diff or checks | Marks the item unproven, which blocks only in gate mode (`src/rooms/tasks/plan-fact.ts:99-160`). |

## Purpose

SMA plan P1-3 and P1-4 (Maslov #30971, «never read the executor's story»): an acceptance claim that no code looked at is the executor's story. The table makes each claim a pointer (a file and lines, or a check), and a pointer can be looked at by code. The card puts what was decided and on what proof on one screen, with what did not run listed apart: not run is not «no findings».

## The table

The writer is told the format by `PLAN_FACT_BRIEF_LINE` (`src/rooms/tasks/plan-fact.ts:26-32`), added to its first brief and to every continuing turn of a task with acceptance items (`src/rooms/writer/server/writer-task.ts:268-276`, `:343-345`). It asks for a fenced block opened with ```plan-fact that holds a JSON array, one row per acceptance item in the contract's order:

- `{"item":1,"status":"done","evidence":["<path>:10-24","cmd:npm test"]}`: evidence is a path, `path:first-last` or `cmd:<command>` (`src/rooms/tasks/plan-fact.ts:27-32`);
- `{"item":2,"status":"not_done","why":"..."}`.

`parsePlanFact` (`src/rooms/tasks/plan-fact.ts:39-53`) reads the last such block of the answer and nothing around it. No block is `missing`; broken JSON, an invalid row, an empty array or a repeated item is `invalid` with the reason. A repair round's reply that has no readable table falls back to the first readable table from the candidate answers (`src/rooms/writer/server/plan-fact.ts:18-26`).

## The blind check

`blindPlanFact` (`src/rooms/tasks/plan-fact.ts:134`) takes the contract's acceptance lines, the table and `PlanFactFacts` (`src/rooms/tasks/plan-fact.ts:53`): the changed paths, their changed line ranges, the contract's commands and the checks that ran. Nothing in the facts comes from the writer. Each piece of evidence (`src/rooms/tasks/plan-fact.ts:99`) is one of:

| Code | Holds | Meaning |
|---|---|---|
| `file_changed`, `lines_changed` | yes | the path is among the changed files; the lines overlap a changed hunk (or the file is new and has them) |
| `lines_unchecked` | yes, with a warning | the file changed, but the diff against the base could not be read |
| `command_passed` | yes | the command is in `verification[]` and its result came back with exit code 0 |
| `lines_kept` | yes, for an item that says something stays as it was | the file changed, and the cited lines are left out of its changed hunks |
| `file_untouched` | yes, with a warning, for such an item | the path is not among the changed files (the diff cannot show it exists) |
| `file_not_in_diff`, `lines_not_changed`, `lines_missing`, `lines_invalid` | no | the path was not changed, or the lines were not |
| `command_not_in_contract`, `command_not_run`, `command_failed` | no | the command is not a contract check, has no result, or failed |
| `unparsed` | no | neither `path[:lines]` nor `cmd:` |

An item «stays as it was» when the contract's line matches `INVARIANT_ITEM` (unchanged, untouched, still works, no changes, не меняется, без изменений, по-прежнему, …); its proof is the code the candidate did not change, and the writer is told to cite those lines (FeedGen run 2026-10-23: «Legacy and error responses unchanged» was called unproven though the writer cited exactly the untouched handler lines). An item is `proven` when one piece of evidence holds. It is blocking when it is `unproven` (claimed done, nothing holds, or no evidence at all), `declared_not_done` (the writer says so) or `no_row` (the table skipped it). Rows for items the contract does not have are listed, not blocking.

The changed hunks come from one shell command run in the task's workspace (`diffHunksCommand`, `src/rooms/tasks/plan-fact.ts:195`): `git diff -U0` against the task's recorded base commit (`lane_pilot_task_git_base`) plus the untracked files; `hunksFromCommandOutput` (`src/rooms/tasks/plan-fact.ts:203`) reads it. A task without a recorded base (a folder without git) or an unreadable diff checks the files only, and the stage says so in `notChecked`.

## The stage

`plan-fact` is a stage (`packages/contracts/src/stage-contract.ts:5`) with a code proof of kind `file` (`packages/contracts/src/stage-proof.ts:36`); it is listed in the writer node of `workflows/lp-task-pipeline.json`. `runPlanFactStage` (`src/rooms/writer/server/plan-fact.ts:44-49`) runs after code critique and before the proof-gap check (`src/rooms/writer/server/finish.ts:635-646`). `planFactOutcome` decides the receipt, with the result (items, evidence checks, `notChecked`, mode) stored in it (`src/rooms/writer/server/plan-fact.ts:44-49`, `src/rooms/tasks/plan-fact.ts:161`):

- no table, or an unreadable one: `skipped`, reason `plan_fact_table_missing` or `plan_fact_table_invalid`. It is recorded and shown as not run; it never refuses the task;
- a blocking item: `failed`, reason `plan_fact_unproven: acceptance item N ...`;
- otherwise `passed`.

A retry of the task replaces the receipt (its earlier events stay in `lane_pilot_stage_event`). The stage never counts as the code proof that accepts a task: the writer's gates and the checks already are.

`plan_fact.mode` (`src/rooms/writer/server/plan-fact.ts:12`): `record` (default) only records and shows; `gate` also sends the task back to the writer (attempt `validation_failed`, reason `plan_fact_unproven`) when the stage failed. A missing table never refuses, in either mode. The retry brief tells the writer what to cite (`src/rooms/writer/server/writer-task.ts:247`).

## The code critic by risk

`critic.code.default_for_risk` is `off` (default), `medium` or `high`: with `code_critique.enabled` not set, the critic runs for tasks of that risk or higher. `applyCodeCriticDefault` (`src/rooms/critique/quality-mode.ts:53`) turns the switch on only in `standard` quality mode and only when the project did not set the switch itself. The default stays `off` until the bench has measured the critic on and off.

The bench's arm hook is `dispatchWriter({ ..., criticCodeDefault })` (`src/rooms/writer/server/dispatch.ts:149`), also `bb lane-pilot dispatch-bb <project> <pm-thread> <task-json> <base-ref> <off|medium|high>` (`src/rooms/tools/server/cli.ts:388`). It is stored per task (`src/rooms/writer/server/critic-override.ts:12-18`) and read when the attempt finishes (`src/rooms/writer/server/finish.ts:313`), where it wins over the project setting for that task only. Both the finish step and the critic run read the same value (`src/rooms/critique/server/critique-runs.ts`).

## The acceptance card

RPC `task_acceptance_card` (`src/rooms/contracts/rpc-runs.ts:60`) returns `buildAcceptanceCard` (`src/rooms/acceptance/card.ts:26-85`), read from the records that already exist:

- the contract: objective, acceptance lines, owned paths; the risk; the base commit and branch (`lane_pilot_task_git_base`);
- the stage receipts in pipeline order, each with its proof: `code` (and which kind: gate, command, file, receipt, schema) or `advisory`, a model's opinion (`STAGE_PROOF`);
- the gate events of the task;
- the plan→fact table with the blind check's verdict per acceptance item and per piece of evidence;
- `notRun`: stages with no receipt or a skipped one, and what the plan→fact check could not look at;
- the cost of the task's attempts from `attemptMetrics` (`src/rooms/usage/server/attempt-metrics.ts:66-126`, filtered by `taskId`): measured, partial («1 of 2 attempts measured») or `not measured`, never 0.

The component is `AcceptanceCard` (`src/rooms/acceptance/ui/acceptance-card.tsx`), shown in the task page of the board (`src/rooms/runs/ui/task-board.tsx:379`) in place of the plain objective and acceptance list; when the RPC fails it falls back to that list. Verified at 375 and 1280 px on the real component and the built CSS (`.bb/tmp/p13-live`), without horizontal overflow.

## Tests

- `tests/plan-fact.test.ts`: the table format, every evidence outcome, the diff reader, the stage on a database, the card, the risk default, the dispatch override.
- `tests/acceptance-card-ui.test.tsx`: what the card shows, NOT RUN, partial cost, the fallback.
- `tests/stages/server-stage/suite.ts`: the stage in a real native run (passed, failed in record mode, refused in gate mode) and the critic switched on by risk.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Tasks board and work graph](task-board.md)
