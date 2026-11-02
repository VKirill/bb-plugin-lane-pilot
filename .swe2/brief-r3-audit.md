# Stream R3: two recovery paths the PM is promised but the code refuses

Read first: `.swe2/brief-common.md` (base is HEAD of main, commit 1a1da14f; ignore its old base line).

Four outside model audits of the PM prompt (2026-11-02) found that the PM is told to take two ways out the code does not allow.
Make both real. Text is already correct; the code must catch up.

## 1. Fix a contract in place after a blocked plan critique
- The PM prompt says: «plan critique blocked or validation_failed: read the reason, fix the plan or contract. A task not started yet
  is edited in place with `lane_pilot_update_task` (taskId, task?, plan?), not canceled and redispatched.» The runbook skill
  `skills/lane-pilot-ops/SKILL.md` says the same.
- Today the plan-critique stage leaves the attempt `blocked` (`src/rooms/writer/server/dispatch-workflow.ts` ~137) and
  `update-task.ts` (~132) refuses every non-queued attempt except `awaitsWriterAnswer` (needs_human) with `task_started`.
- Build: an attempt that is `blocked` with reason `plan_critique_blocked…`, `structural_plan_critique_blocked…` or
  `validation_failed…` and has no writer thread yet (no `thread_id`; the writer never started) is updatable like a queued one:
  the update rewrites the contract/plan, the attempt goes back to queued (check the state machine in `src/rooms/runs` for a legal
  move; add one only if needed, with a test), and pm-read and plan critique run again. No attempt is spent. A blocked attempt that
  had a writer thread keeps today's refusal. Keep the refusal hint accurate for what is still refused.
- Test: a plan-critique-blocked task is updated, requeued, critiqued again (stub the critique); the same with a writer thread is
  refused `task_started`; needs_human keeps working as today.

## 2. A task that fixes a regression is not held by that regression's quarantine
- The runbook says: «A real break → dispatch a fix task that owns the shared files; the wait ends when the check is green.» Today
  `quarantiningRegression` / `waitForRegressionQuarantine` (`src/rooms/writer/server/start.ts` ~73 and ~392) hold every task whose
  owns_paths overlap the row's files, the fix task included: it waits forever for the row it should close.
- Build: a task may name the regression rows it fixes (a contract field, e.g. `fixes_regressions: [<id>]`, in the task-v2
  contract schema in `src/rooms/contracts`; optional; numbers). Such a task is not held by those rows (other rows still hold it).
  The dispatch tool text of `lane_pilot_dispatch_writer` must name the field in one short clause (its `instructions` string has a
  4096-character limit; measure). The quarantine wait line (start.ts, the `reason` string) and the way-out text in
  `src/rooms/runs/way-out.ts` for `^quarantine` say: «a real break: dispatch a fix task that owns <files> with
  fixes_regressions:[<id>]». Also the `lane_pilot_regression` tool's list output (src/rooms/baseline/server/regression-tools.ts)
  may say it in its `next`.
- After the fix task is accepted the nightly regression pass re-runs the check; nothing else to build there.
- Test: the incident shape (row with sharedFiles editor.html; a task owning editor.html with fixes_regressions:[row id] starts;
  without it, it waits; with another row's id, it waits).

## Owns
`src/rooms/writer/server/update-task.ts`, `reopen-attempt.ts`, `start.ts` (quarantine part only), `dispatch-workflow.ts` (only if
needed), `src/rooms/runs/**`, `src/rooms/contracts/**`, `src/rooms/tools/server/tools.ts` (the dispatch instructions string only),
`src/rooms/baseline/server/regression-tools.ts`, tests you add or must update. Do not touch `src/rooms/native-agent/**` and
`skills/**` (the lead edits those now).
