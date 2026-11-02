---
name: lane-pilot-ops
description: "Lane Pilot PM runbook by symptom: a task waits, is blocked, held, quarantined, parked; a graph failed or hit a budget; the owner asks why nothing moves. Gives the check and the exact tool or command that gets it moving. Use before telling the owner something cannot be done or that you have no command for it. SKIP: planning a task (lane-contract), building a graph (lane-pilot-workflows), project memory (lane-memory)."
---

# Lane Pilot ops: symptom → check → way out

You are a PM in a Lane Pilot chat. Something does not move. Do not tell the owner «нельзя», «нечем» or «не знаю когда»
before you went through this page. Each row says what you do, or what the machine waits for and what you do when that
does not happen; the owner is asked only where the row says so. A tool that refuses tells you why in its answer: follow it.

## 0. Look first, then act

1. The record, not your memory of it: `lane_pilot_run_health` and `lane_pilot_wait_writer` (runId) for tasks of this run;
   `lane_pilot_facts` for a question about the past, limits or a failure; `lane_pilot_workflow_status` (runId) for a graph.
2. A tool you cannot place: `lane_pilot_tool_search` (words). Families take an `action`; their text lists the arguments.
3. Your shell may run `bb lane-pilot …` (read commands and the settle commands below). Full list: `bb lane-pilot --help`.
   One task's whole history in time order: `bb lane-pilot timeline <task-id>`.

## 1. A task waits (it is «at work» but nothing happens)

| Reason in the receipt / digest | What it means | Way out |
|---|---|---|
| `quarantine: regression #N …` | An older accepted task's check went red on main; tasks sharing its files wait so nobody builds on a break | Read the row: `lane_pilot_regression {action:"list"}` (CLI: `bb lane-pilot regressions <project>`). The later task changed it **on purpose** (the owner asked, the plan said so) → `lane_pilot_regression {action:"settle", id:N, reason:"<who decided what, when>"}` (CLI: `bb lane-pilot regress-close N <reason>`). A real break → dispatch a fix task that owns the shared files with `fixes_regressions:[N]` (without it the fix waits on the same row); the nightly pass closes the row once the check is green |
| `writer_provider_unavailable:owner_present…` / «владелец работает в …» | The owner uses that subscription right now; writers keep off it ≤ 10 min | Nothing: the writer chain already moved to the next provider, or it resumes by itself |
| `breaker_open`, `usage_window`, `writer_provider_limit` | A provider is down or out of its window | Nothing: the chain moves on. `lane_pilot_reassign_task` (taskId, model) works only on a **running** task (a stuck writer); a queued task waits for a free writer |
| `waiting_writer:core_unsupported…` / `writer_provider_unavailable` | No writer in the chain can run on this core: it does not pass by itself | Reassign a running task to a supported model, or tell the owner in one line which provider to enable for the project |
| waits on a `depends_on` task that is blocked | Dependents wait up to 6 hours | Fix and send the blocked one again; they start once it is accepted. If you verified by hand that its result is already there: `lane_pilot_update_task` on **the blocked task** (taskId, satisfied: true) frees its dependents. Overlapping owns_paths: nothing, it starts when the other task ends |
| waits for the owner's word (`owner_word`, a risky task verified but not merged) | owner.words: a high-risk task lands on main only after his yes | Ask him once with `lane_pilot_ask_owner`; write his answer with `lane_pilot_queue {action:"word", taskId, decision, text}` |
| nothing moves anywhere | The conveyor may be off | `bb lane-pilot conveyor status`; it is the owner's switch: tell him it is off and why, do not turn it on yourself |
| merge held by another chat (`blockedBy`) | Uncommitted edits or a holder in the same checkout | `lane_pilot_relay {action:"ask"}` to the holder, end the turn |
| run paused | Someone paused it | `bb lane-pilot resume <run-id>` when the reason is gone |
| merge conflict with main | Main moved under the task; its writer resolves the conflict in its worktree, or the task is redone on the new main; no attempt is spent. Uncommitted edits in the base checkout are not a conflict: Lane Pilot asks the chats in that folder to commit, then merges | Wait. Do not rebase, commit others' edits or redispatch |
| `waiting_secret:NAME` | The check needs a name missing from Env Catalog, or left out of the project's non-empty `secrets.allow` | `env_request` for a missing name. A name left out of `secrets.allow` is a project setting: ask the owner in one line to allow it. No attempt is spent; the task starts once the value is there |
| `blockedBy` that does not move | The holder's state, output and `retryAfterSec` stopped changing | Tell the owner in one message what you tried and what to choose |

## 2. A task is blocked

| Reason | Way out |
|---|---|
| `plan_critique_blocked`, `structural_plan_critique_blocked`, `validation_failed` | Read the critique; fix the contract in place: `lane_pilot_update_task` (taskId, task, plan); pm-read and the critique run again, no attempt is spent. Do not cancel and redispatch |
| `needs_human: <question>` | The writer waits for you: `lane_pilot_answer_writer` (taskId, answer). A question about checks or paths: fix the contract with `lane_pilot_update_task` |
| `verdict_block: question_unanswered` | The writer's question timed out and the attempt is closed: answering it fails. Dispatch a new task whose contract carries the answer |
| `retry limit exhausted`, `test_fit`, `critique_thread_timeout` | The machine stopped retrying | Read the last attempt (`bb lane-pilot timeline <task-id>`), change what made it fail (the contract, the check, the size), then dispatch again; the same contract again fails the same way |
| `owner_word: no` | The owner said no to this task | It does not land. Ask him what he wants instead; do not resend it |
| `dispatch interrupted by a reload …; send the task again` | Send it again with `lane_pilot_dispatch_writer` (same contract) |
| `owns_paths rejected`, `repo_edited`, a stray file | The contract is too narrow or the writer strayed (the writer already got its feedback turns): widen owns_paths in a corrected contract and dispatch again |
| Lane Pilot's own fault (`internal_error`, `reconcile_*`, `attempt_worktree_*`, `merge_failed`, `spawn failed`, `thread_provisioning_failed`, `snapshot_failed`, `execution_packet_failed`) or the machine's (no disk space, git lock, host offline) | Parked, not lost: a repair thread fixes Lane Pilot and the task restarts from its writer stage once the fixed version is live (a machine fault: after a short wait, at most three times); Lane Pilot tells you which. Nothing to do; say so in one line. Still parked a day later, or the retries ran out: tell the owner in one line what waits on what. Do not diagnose or patch Lane Pilot, `~/.lane-pilot` or the hub |
| dispatch refused `task_in_progress` | A task of that family runs or is parked: `lane_pilot_update_task` or `lane_pilot_answer_writer` instead |
| dispatch refused `topic_loop` | Send nothing more on that topic; tell the owner what keeps failing |
| the same failure twice | Stop resending. `bb lane-pilot timeline <task-id>` and name the cause before a third try |

## 2b. A folder without git (`mode live-folder`)

No worktree, commit, merge or shipping; one writer per folder, so tasks queue. A task that is not accepted is rolled back from a
backup of its `owns_paths`; files outside `owns_paths` are not. Keep `owns_paths` narrow; a folder over 50 000 files needs git.

## 3. A graph (workflow) failed or stopped

1. `lane_pilot_workflow_status` (runId): which step, its receipt, its output.
2. **A failed step may already have acted.** `budget_exceeded:*` after a send, a payment or a post means the money or time
   ran out *after* the step; the act may be done. Check the target (read the chat, the invoice, the page) **before** you tell
   the owner nothing happened and before any rerun. Never rerun an outgoing step without that check.
3. `lane_pilot_workflow_amend` (rerun) reruns that node **and every step after it**, sends and payments included. Before it, check
   the target of every step after the node that already acted; one that already sent means you do not rerun, you report. Goals that
   cannot be met: fix the work or, on the owner's word, the goals. A writer task's graph is not rerun this way: dispatch again.
4. A form waits for the owner: it is in this chat; remind him in one line, do not answer for him.

## 4. Accepted work is wrong later

- What the task changed and on which base: `bb lane-pilot changes <task-id>`.
- Its checks again on its base: `bb lane-pilot reverify <task-id>`.
- Undo it safely (checked, through the merge queue): `bb lane-pilot revert <task-id> --dry-run`, then without `--dry-run`.

## 5. Only the owner can decide

`bb lane-pilot waiting` lists what is his, with the exact action. A deferral he must give a term to: `bb lane-pilot deferrals`;
close one with evidence: `bb lane-pilot defer-close <id> --evidence <commit, test, link>`.

## 6. How to tell the owner

One line per stuck thing, in plain Russian: what waits, why, what you did about it, when it moves. No ids, no English codes.
If you used a way out from this page, say which one in words («снял карантин: удаление было задумано»).
