---
title: Plan split
type: component
created: 2026-11-14
updated: 2026-11-14
status: active
confidence: medium
tags: [plan, depends_on, waves, phase, writer, worktree]
sources:
  - src/rooms/tasks/dep-graph.ts
  - src/rooms/tasks/server/contract-lint.ts
  - src/rooms/tasks/server/lint-task.ts
  - src/rooms/workflow/server/workflow-task-book.ts
  - src/rooms/workflow/server/workflow-lp-task.ts
  - src/rooms/workflow/server/workflow-task-contract.ts
  - src/rooms/phase/logic/gates.ts
  - src/rooms/phase/logic/waves.ts
  - src/rooms/phase/server/auto-stages.ts
  - src/rooms/writer/server/start-wait-dependencies.ts
  - src/rooms/writer/server/start-dependency-base.ts
  - src/rooms/writer/server/spawn.ts
  - src/rooms/storage/attempts-store/lifecycle.ts
  - scripts/lp_drill/scenes/plan_split.py
---

# Plan split

TL;DR: a big plan becomes tasks whose order is decided only by their `depends_on`. Code lays the waves out from those links, refuses a
cycle before anything is dispatched, starts a task once its dependencies are accepted and merged into `main`, cuts its worktree from
that `main` and proves the merges are in it. A failed task holds only the tasks that depend on it.

## The rule

The owner's rule (ТЗ sma-parity, section 4д; owner decision №1 outranks the SMA map):

1. A dependency is the explicit contract field `depends_on`, never the order of the plan text. A name resolves inside the task's own
   run. A redispatch counts as its name: `T1` is satisfied by `T1.2`.
2. Only tasks with no dependency on each other and no `owns_paths` overlap run in parallel.
3. A task starts when its dependencies are accepted (accepted means merged: `finish-merge.ts` writes `accepted` only after the
   merge). Its worktree is cut from that `main`, and each dependency's merge commit must be an ancestor of the worktree's HEAD. The
   wait reads the stored contract on every poll, so a dependency added while the task is queued counts.
4. Code computes the waves from the dependency graph. The planner does not write them. A cycle is a plan error before dispatch.
5. When a task fails, its dependents wait for it (and for its redo). Independent tasks go on. Inside a phase this applies piece by
   piece, not wave by wave.

## Where each part lives

| Part | Code | What it does |
|---|---|---|
| Graph | `src/rooms/tasks/dep-graph.ts` | Pure, no database. `planGraph` returns layered waves (a task's wave is 1 + the highest wave of its dependencies), `waveOf`, the first `cycle`, `unknown` links and `sameWaveOverlap`. `findCycle`, `cycleText`, `readyNow` (what may start given accepted and failed sets). |
| Direct dispatch | `contract-lint.ts` (`depends_self`, `depends_cycle`), `lint-task.ts` (`runTasks`) | A `depends_on` that names the task itself, or closes a loop through the open tasks of its run, is a lint error: `validation_failed`, `replan: true`, no attempt. The same lint runs on `lane_pilot_update_task`. |
| `lp.plan` | `workflow-task-book.ts` (`lp.lint_contract`), `workflows/lp.plan.json` | The lint computes `lint.waves` from `depends_on`. The plan emits those instead of the planner's own waves (a disagreement is logged). A cycle, or a link to no task of the plan or run, sends the plan back to the planner. Two tasks of one computed wave that own the same paths must be linked. |
| Phase plan | `phase/logic/gates.ts` (`waveProblems`, `withComputedWaves`, `pieceDeps`), `phase/server/auto-stages.ts` (`planItems`) | `planItems` lays the waves out from `depends_on` and throws on a cycle. A piece the PM submits without a wave gets its computed one. A piece with no computable wave is refused, never put into wave 1 silently. A given wave must be later than its dependencies' waves. |
| Phase issue | `phase/logic/waves.ts` (`issuable`) | A piece is offered once every piece it depends on is accepted. The wave stays an address (budget, stop, board, review) and the wave's lines and review still hold the phase's exit, but a wave is not a barrier. Inside a phase, `main` is the phase's candidate branch `phase/<id>`: pieces are cut from it and merged into it. |
| Graphs (`lp.build` and others) | `workflow-lp-task.ts`, `workflow-task-contract.ts` (`graphTaskStem`, `graphTaskId`, `graphDependsOn`) | A graph's code task is named `w<stem>-<id>`, with one stem per graph run, and its `depends_on` is rewritten with the same prefix. A name that is a task the PM already dispatched in the run keeps its name. The engine's `order: "depends_on"` holds graph dependents until their dependencies end. `lp.build` sets `on_child_fail: "block_dependents"`: a dependent of a task that did not end accepted (blocked, failed, cancelled, needs_human) is never dispatched, it arrives at the join as `upstream_blocked:<id>` and is counted in `blocked_ids`; tasks that do not depend on it go on (`engine-branches.ts` `gates`). |
| Wait | `writer/server/start-wait-dependencies.ts` (`waitForDependencies`, `storedDependsOn`) | Re-reads `depends_on` from the stored contract on every poll and resolves names with `latestRunTaskAttempt` (run-scoped, follows redispatches). A blocked dependency is waited for up to 6 h (`DEPENDENCY_REDO_WAIT_MS`), a canceled one for `CANCELED_REDO_WAIT_MS`. A name that never appears ends the wait after two minutes from when the wait first saw it. |
| Overlap | `writer/server/start-wait-overlap.ts` | Two tasks whose `owns_paths` overlap (or that share an area) do not run together. A queued task still waiting for its own dependencies holds no one. |
| Base proof | `writer/server/start-dependency-base.ts` (`checkDependencyBase`), called in `spawn.ts` right after `bindAttemptWorkspace` | For a git workspace, each accepted dependency's merge commit (from `lane_pilot_attempt_change`) must be an ancestor of the worktree's HEAD. A missing one ends the start with `attempt_worktree_base_missing_dependency: …` before any writer turn. That reason is the free `harness` class: the attempt is not charged and is retried. If git does not answer, the start goes on and the log says it is unproven. |

## Not implemented on purpose (deviations from the SMA map)

These map cards contradict the rule or owner decision №1:

- `n365 bi_eligible`: «the next wave waits for this one's acceptance». A piece waits only for its own dependencies.
- `n366 bi_broken`: «a broken piece stops issue and asks the owner». A broken piece holds only its dependents. The phase's decide
  turn (skip, retry, cancel) is still offered for it.

## Kept as they are

- The wave pilot (`n333 cg_batch_turn`, `n363 bi_pilot`, `n364 bi_fanout`, `writer/server/pilot/logic.ts`) stays. The rule says which
  tasks may run together (no link, no shared files); it does not say every such pair must. The pilot holds siblings of one area and
  kind, or of one shared resource, until the first of them is accepted, and the wait names it in the stage reason. A task the PM
  ordered with `depends_on` gets no pilot.
- A dependent waits for a blocked dependency for 6 h (`DEPENDENCY_REDO_WAIT_MS`), then ends blocked with the reason and goes back to
  the PM. It never starts without its dependency. The limit stays because a queued task holds the tasks queued behind it on the same
  files (`start-wait-overlap.ts`): a wait without an end would hold independent work for good. A plugin reload restarts the count.

## How to read the result in the database

The order in which a run's tasks started and were accepted, their bases and their merges:

```sql
SELECT a.task_id, a.id AS attempt_id, a.state, a.reason,
  (SELECT min(at) FROM lane_pilot_attempt_transition t WHERE t.attempt_id=a.id AND t.to_state='spawn_requested') AS started,
  (SELECT min(at) FROM lane_pilot_attempt_transition t WHERE t.attempt_id=a.id AND t.to_state='accepted') AS accepted,
  c.base_sha, c.merge_commit, c.changed_json
FROM lane_pilot_attempt a LEFT JOIN lane_pilot_attempt_change c ON c.attempt_id=a.id
WHERE a.run_id=:run ORDER BY started;
```

- A dependent's `started` is later than each dependency's `accepted`.
- A dependent's `base_sha` contains each dependency's `merge_commit`. Check it in the checkout with
  `git merge-base --is-ancestor <merge_commit> <base_sha>`.
- While a task waits, its `writer-agent` stage receipt says why: `waiting for depends_on: <names>`, with
  `(<name> ended blocked or canceled; starts once it is sent again and accepted)` when a dependency failed. A file overlap shows
  `waiting for <task> (thread …): owns_paths overlap`.
- A refused cycle has no row in `lane_pilot_attempt`. The dispatch reply is `validation_failed` with a `depends_cycle` finding that
  names the loop (`a → b → a`).
- A start refused for its base has the reason `attempt_worktree_base_missing_dependency: …`. The log line
  `worktree HEAD … holds the merges of …` records a passed proof.

## Measured by

- `tests/tasks/dep-graph.test.ts`: the pure graph (parallel, sequence, diamond, cycle, failed task in the middle).
- `tests/plan-split-start.test.ts`: the real writer start path over a real git repository. Covers parallel, sequence, the diamond
  with a failed middle task and its redo, the queued-contract edit (`zupo-cards-bot-flow`), the run scope, overlapping files and the
  base proof.
- `tests/phase-plan-split.test.ts` and the `tests/sma/*` cards `bf_waves`, `p2_waves`, `p4_deps`, `cg_file_hold`.
- `tests/contract-lint.test.ts`, `tests/stages/server-stage/suite.ts`: cycle refusal on the direct path.
- `tests/workflow/chain-executors.test.ts`: `lp.lint_contract` waves and the graph prefix.
- Drill `scripts/lp-drill.sh --scenario plan_split` (also under `--series`, task suite, never in `--quick`): six tasks with a
  diamond, `c` red on purpose then `c.2`, and a refused cycle. It is judged by the SQL above (`PLAN_SPLIT_SQL` in
  `scripts/lp_drill/scenes/plan_split.py`).
