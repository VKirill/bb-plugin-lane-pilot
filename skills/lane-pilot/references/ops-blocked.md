# A task is blocked, and a folder without git

| Reason | Way out |
|---|---|
| `plan_critique_blocked`, `structural_plan_critique_blocked`, `validation_failed` | Read the critique; fix the contract in place: `lane_pilot_update_task` (taskId, task, plan); pm-read and the critique run again, no attempt is spent. Do not cancel and redispatch |
| `plan_critique_failed: <error>` | The critique itself errored (a thread timeout, an invalid answer) — not a refusal of the plan: send the task again, pm-read and the critique rerun; a repeat means the critic provider is down — wait it out |
| `needs_human: <question>` | The writer waits for you: `lane_pilot_answer_writer` (taskId, answer). A question about checks or paths: fix the contract with `lane_pilot_update_task`. Neither answers the task: ask the owner once with `lane_pilot_ask_owner` |
| `verdict_block: question_unanswered` | The writer's question timed out and the attempt is closed: answering it fails. Dispatch a new task whose contract carries the answer (owns_paths and the checks settled) |
| `verdict_block: <stage>: <finding>` | A critic refused the result — the reason names the stage, the finding, its file:line. Do not send the same task again; settle what the finding says, by a different approach or by asking the owner, then dispatch a new task |
| `retry limit <N> exhausted: <why>` | The task's attempts are spent — what failed too often is after the colon. Read the last attempt (`bb lane-pilot timeline <task-id>`), change what made it fail (the contract, the check, the size), then dispatch again; the same contract again fails the same way |
| `repeated_failure: <why>`, `narrow_brief: <why>` | Two attempts failed the same way. Stop resending: `bb lane-pilot timeline <task-id>` and name the cause, change the contract or the approach, before a third try |
| `test_fit: <path>: <evidence>` | The writer weakened or removed tests that existed on the base. If removing them is the task, name the files in the contract's `test_removals`, then send the task again; otherwise fix the change and resend it |
| `owner_word: no` | The owner said no to this task. It does not land — ask him what he wants instead; do not resend it |
| `run_budget_exceeded:<what>`, `budget_exceeded:<what>` | The run hit a `run.max_*` limit — money or time already moved. Check the step receipts with `lane_pilot_workflow_status` (a step that already acted is done — not nothing sent), then raise the `run.max_*` setting or finish the run; a graph step that already sent: the graph section of `ops-graphs.md` before any rerun |
| `dispatch interrupted by a reload …; send the task again` | Send it again with `lane_pilot_dispatch_writer` (same contract): no attempt was spent |
| `owns_paths rejected`, `repo_edited`, a stray file | The contract is too narrow or the writer strayed (the writer already got its feedback turns): commit or discard the stray edits in the checkout, widen owns_paths in a corrected contract and dispatch again |
| `provider_error`, `writer_stream_error`, `timeout` | Nothing: a provider fault starts the next writer of the chain by itself. A **running** task stuck on a dead provider: `lane_pilot_reassign_task` (taskId, model). The same fault on every writer: the provider side is down, wait it out |
| `verification failed (<cmd>): verification timed out after <N>s` | The check timed out — its retry budget is separate from the task's attempts: raise `timeout_sec` or narrow the command, then send the task again |
| `verification failed (<cmd>)` | The task's own checks are red: read the check output in the reason, fix the code or the check, then send the task again |
| `cannot read writer-workspace git diff: <error>` | The machine could not read the worktree, not the task's code. A missing shell (`spawn … ENOENT`) parks the task and it restarts by itself after a short wait; any other error: send the task again, and if it repeats tell the owner which machine fails |
| `writer stop observed` | Its writer thread stopped before the checks ran — the attempt ended without a result: send the task again if the work is still needed |
| Lane Pilot's own fault (`internal_error`, `reconcile_*`, `attempt_worktree_*`, `merge_failed`, `spawn failed`, `thread_provisioning_failed`, `snapshot_failed`, `execution_packet_failed`) or the machine's (no disk space, git lock, host offline) | Parked, not lost: a repair thread fixes Lane Pilot and the task restarts from its writer stage once the fixed version is live (a machine fault: after a short wait, at most three times); Lane Pilot tells you which. Nothing to do; say so in one line. Still parked a day later, or the retries ran out: tell the owner in one line what waits on what. Do not diagnose or patch Lane Pilot, `~/.lane-pilot` or the hub |
| dispatch refused `task_in_progress` | A task of that family runs or is parked: `lane_pilot_update_task` or `lane_pilot_answer_writer` instead |
| dispatch refused `topic_loop` | Send nothing more on that topic; tell the owner what keeps failing |
| the same failure twice | Stop resending. `bb lane-pilot timeline <task-id>` and name the cause before a third try |


## 2b. A folder without git (`mode live-folder`)

No worktree, commit, merge or shipping; one writer per folder, so tasks queue. A task that is not accepted is rolled back from a
backup of its `owns_paths`; files outside `owns_paths` are not. Keep `owns_paths` narrow; a folder over 50 000 files needs git.

