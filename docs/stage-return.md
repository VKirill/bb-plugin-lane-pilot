---
title: Return a task to an earlier stage with added context
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [stage-return, discussion, planning, writer, sma, receipts]
sources:
  - packages/contracts/src/stage-inputs.ts
  - src/rooms/stage-return/migrations.ts
  - src/rooms/stage-return/store.ts
  - src/rooms/stage-return/logic.ts
  - src/rooms/stage-return/server/stage-return.ts
  - src/rooms/stage-return/server/cli.ts
  - src/rooms/stage-return/server/rpc.ts
  - src/rooms/stage-return/ui/return-stage.tsx
  - src/rooms/writer/server/spawn.ts
  - src/rooms/writer/server/start.ts
  - tests/stage-return/return.test.ts
  - tests/stage-return/loop.test.ts
  - tests/stage-return/spawn-brief.test.ts
  - tests/stage-return/logic.test.ts
  - tests/stage-return-ui.test.tsx
---

# Return a task to an earlier stage with added context

TL;DR: a person (the owner, from the task card or the CLI) sends a task back to `discussion`, `planning` or the `writer` with a note. The intervention is recorded, the receipts that stage and every later one wrote are reset, a running attempt is stopped with the exit confirmed, and the work restarts from the stage with the note in its input. SMA atlas delta D0-2 («из 4 вернуться в 1, из 5 во 2», Maslov 2026-10-22).

## Use

- CLI: `bb lane-pilot return <task-id> --to discussion|planning|writer --note "…"` (the note runs to the next flag, so it needs no quoting; an attempt id works as the task too). `bb lane-pilot returns <task-id>` lists what is on record.
- RPC: `task_return_stage` `{ ref, to, note, by? }` and `task_returns` `{ ref }`. The answer names `from` (the earliest stale stage), `reused`, `stale` (with why), `paused` (what was done to the running attempt) and `restarted` (who works on the task now).
- UI: «Вернуть на стадию…» / «Return to a stage…» at the bottom of the acceptance card on the task page (`src/rooms/stage-return/ui/return-stage.tsx`): three stage buttons, a text field for the note, one send button. It is an action, not a confirmation form.

## What it does, in order

1. **Refuses** an empty or over-long note (4000 characters), an unknown task, a closed run, a task that was canceled (its stages are final) and a task that was accepted and merged (its work is in main: `bb lane-pilot revert`). A refusal changes nothing and names what to do.
2. **Records** the intervention first: `lane_pilot_stage_return` (who, to which stage, the note word for word, the receipts kept and reset, how far the return got). The note is never edited or deleted.
3. **Works out the receipts.** `returnAffected(receipts, to)` (`packages/contracts/src/stage-inputs.ts`) reuses `affectedFrom`: the stage returned to (`discussion` → `pm-read`, `planning` → `plan-critique`, `writer` → `writer-agent`) and every later stage are stale, because a later stage reads the output of an earlier one; a receipt before it is reused, unless it did not pass.
4. **Resets what is stale.** Each stale receipt that had ended goes back to `pending` with a new input hash (the plan plus the return id and the note) and the reason `stale: …`, so whatever runs next records over it and the card shows it. A stage at work is not touched.
5. **Pauses and restarts**, by stage:
   - `writer`: a running writer is replaced by a fresh one in the same worktree (the PM's reassign, `src/rooms/writer/server/reassign.ts`: the old writer is stopped, the loop starts the next one with a handoff that names the note; no attempt is spent). A writer blocked on a question takes the note as a turn in its own thread (`reopenAttempt`; no attempt spent). A task with no writer at work gets a new attempt from the writer stage. An attempt that has not started yet only has the note on record for its first brief.
   - `planning`, `discussion`: these stages are the PM's. A running or queued attempt is stopped the way every stop is confirmed (`cancelAttemptById`: the thread asked until it is idle, the worktree state written down before any cleanup); a stop that is not observed fails the return and says so. The stale receipts are reset and the PM gets one message with the note word for word, the stale and kept stages and what to do (`lane_pilot_update_task` for a task still open, `lane_pilot_dispatch_writer` for a task that was stopped). The old plan is not run again behind the PM's back.
6. **Carries the note on.** Every later brief of the task has it: the writer's first brief (after the role line and the handoff, `spawn.ts`), and the next-task turn of an area writer (`start.ts`). It is in a `<return_note stage=… by=… at=…>` block, with a line saying it comes from the person who owns the task.

## Limits

- The planning stages are not re-run by Lane Pilot itself: the pipeline of `pm-read`, `plan-critique` and `specialist-review` lives in the PM's dispatch call. For `planning` and `discussion` the PM acts on the note; the receipts it makes stale tell it what has to be done again.
- A restarted writer continues the stopped writer's worktree (the reassign path); it does not start from main.
- A task of a run in a folder without git has no worktree to carry over; the new writer works from the handoff and the note.

## Tables

`lane_pilot_stage_return`, appended last to `migrations` (`src/rooms/stage-return/migrations.ts`).

## Live evidence

2026-10-22, in one process with the plugin's own code: the real writer loop (`startWriterTask`) with a task returned to its writer while the writer works restarts it in the same worktree with no attempt spent, a handoff that names the note, the judging stages reset and the PM told (`tests/stage-return/loop.test.ts`); the real spawn puts the note into the brief after the handoff (`tests/stage-return/spawn-brief.test.ts`). The card at 375 and 1280 px with real CSS, no horizontal overflow, the request body checked in the page. The deployed plugin was not touched.
