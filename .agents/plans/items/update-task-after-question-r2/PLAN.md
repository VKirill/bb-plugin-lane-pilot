# Fix a task's contract after the writer asked, in the same writer thread (restart: previous dispatch hung in a gemini pm-read stage)

## Evidence (SelfyStudio run lprun_0d7e8c17aae54d2ea084a8a866d56b45, 2026-10-09; and this run's writer-quota-silence)
- fix-gc-hub-unscoped-styles: check `npx vitest run --root apps/marketing tests/fitness` from repo root; a fitness test reads `app/pages/index.vue` relative to process.cwd → fails from root. Writer spent 3 turns then asked NEEDS_HUMAN («run it from apps/marketing»).
- gc-name-day-greeting: `npx vitest related --root apps/api <file> --run` pulled the whole 331-file suite, 120 s timeout twice, then NEEDS_HUMAN.
- writer-quota-silence (this run): writer asked to add two files to owns_paths.
- All needed only a contract change. `lane_pilot_answer_writer` cannot change the contract and `lane_pilot_update_task` refuses a started task (`task_started`), so the PM had to dispatch copies; each got a new writer thread and redid the work.

## Change
1. `lane_pilot_update_task` (src/rooms/writer/server/update-task.ts) also accepts a task whose latest attempt is `blocked` with a `needs_human:` reason. Same id; the new contract passes the same validation/lint as dispatch. If only `verification`, `acceptance`, `expected_outputs`, `owns_paths`, `never_touch` (and optionally `plan`) change (id, project_cwd, area unchanged): store it and reopen the same attempt in the same writer thread and worktree as `answerWriter` does (src/rooms/writer/server/answer.ts): no attempt charged, change recorded in the task Q&A, the writer gets a turn listing each changed field old → new plus an optional PM note, and validation uses the new contract. Other field changes → clear error saying to redispatch. Factor the shared reopen code out of answer.ts.
2. Instructions: tools.ts — update `lane_pilot_update_task` and `lane_pilot_answer_writer` instructions accordingly. src/rooms/native-agent/native-agent-overlay.ts — Receipts needs_human line says a question about checks/paths is fixed with update_task and continues in the same thread; Dispatch paragraph about `verification` adds: in a monorepo set the check's `cwd` to the package folder and name test files/folder (`npx vitest run tests/fitness/`), because `--root` from the repo root changes the cwd tests read from and `vitest related` can select the whole suite.
3. Keep overlay size and pm-tool-mentions tests green.

## Tests
- update-task.test.ts: needs_human-blocked task + new verification → stored contract updated, same attempt reopened (running, same thread), attempt count unchanged, writer turn names the changed field; objective change → refused with redispatch hint; queued task updates as before; running task → task_started.
- writer-answer.test.ts green after refactor.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
