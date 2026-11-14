# The path of a task

How an ordinary task travels in Lane Pilot now, and where each part is written down. The rule here is short; the docs hold the rest (`docs/task-folder.md`, `docs/plan-split.md`, `docs/worktrees.md`, `docs/role-models.md`).

## Where a task's files are

Everything of one task is in its home, `.agents/tasks/<task-id>/`, in the base checkout: the contract (`contract.v<N>.json`), the plan (`PLAN.md`, a later edition is `PLAN.v<N>.md`), the critics' verdicts, every attempt's brief, report, checks and notes, the acceptance receipts, the outcome. `manifest.json` lists every file.

- **Ask the manifest, never list a folder.** Plugin code finds a file with `resolveTaskFile(taskId, kind)`; an agent opens the path its brief names or the manifest lists. A glob such as `.agents/plans/items/*/PLAN.md`, or the «newest folder», is the old layout and a stale answer.
- **The plan goes to the dispatch as text** (`plan` of `lane_pilot_dispatch_writer`, or of `lane_pilot_update_task` for a new edition). A plan that is only a path is replaced by that file's text. `.agents/plans/` is the PM's own planning space for a plan-only turn; no task reads it.
- **A writer's worktree gets only its own task's folder**, and the setup gives it `LANE_TASK_DIR`. It reads no other task's folder, no shared `.agents/plans/*` file and no other chat's `.bb/chats/` folder: a `read_first` that points there is refused (`read_first_foreign_task`, `read_first_shared_plan`, `read_first_foreign_chat`).
- The home is git-excluded and survives the merge: the acceptance receipt is in the base after the worktree is gone. Nothing is written into a worktree after its merge.

## Order: only `depends_on`

- `depends_on` (names of tasks of the same run) is the only ordering. Code computes the waves from it; nobody writes waves. A cycle or a task that depends on itself is refused at dispatch (`depends_cycle`, `depends_self`, `validation_failed`, no attempt).
- A dependent starts only when its dependencies are accepted and merged; its worktree is cut from that `main`. A failed task holds only its own dependents (up to 6 hours, then they return to the PM as blocked); independent tasks go on.
- Two tasks whose `owns_paths` overlap do not run together: link them with `depends_on`.

## Plan critique

The plan critic runs for risk high or critical, for 3 or more write tasks, or for 8 or more `owns_paths` at any risk. With `plan_critique.revise_by` = `planner` (the default) a returned plan goes back to the planner, which revises it in its own session up to 3 rounds (`plan_critique.max_rounds`); a fresh critic judges every round. The planner changes the plan text, `read_first` and `verification`; `objective`, `acceptance`, `owns_paths`, `never_touch`, `expected_outputs`, `depends_on` and `risk` stay the PM's. Only what the planner cannot fix, or three spent rounds, reaches the PM (`planner_rounds_exhausted`, `planner_stopped`); `revise_by` = `pm` keeps the old path where the PM fixes every return.

## Who answers the writer, what waits for the owner

- The writer's `ASK_PM:` is answered by Lane Pilot's rules, then the second pilot, then the PM (`lane_pilot_answer_writer`). The owner is asked only for a secret, money, an irreversible act or a product decision.
- `owner.words` = `sensitive` (the default): a verified task, and a pause of the phase graph, waits for the owner only for money, a database migration or a production deploy. Every other pause is decided on the spot, without him.

## Worktrees and memory

- One root per machine: `~/.lane-pilot/worktrees/<repo>/<id>`. The merge removes the worktree and its branch; a branch with unmerged commits is never deleted. A daily cleanup runs as a Lane Pilot schedule. By hand: `bb lane-pilot worktree-cleanup --dry-run`.
- Project memory lives only on the hub and is maintained without a person; read it with `lane_pilot_memory` / `lane-memory`, write a lesson, never a `.agents/memory/` file.

## Commands for an agent

`bb lane-pilot forge-lint <skill|role|workflow> <name> <file>` lints a draft skill, role or graph the way the Creator's task is verified. `bb lane-pilot sma-map --states|--gaps|--hollow` reads the SMA product map: node states, gaps, claims with no proof behind them. `bb lane-pilot timeline <task-id>` shows one task's history. `bb lane-pilot --help` lists the rest.
