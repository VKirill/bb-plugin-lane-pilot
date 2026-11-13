---
name: lane-pilot-ops
description: "Lane Pilot PM runbook by symptom: a task waits, is blocked, held, quarantined, parked; a graph failed or hit a budget; the owner asks why nothing moves. Gives the check and the exact tool or command that gets it moving. Use when a PM is about to tell the owner something cannot be done or that you have no command for it. SKIP: planning a task (lane-contract), building a graph (lane-pilot-workflows), project memory (lane-memory)."
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
| `writer_provider_unavailable:usage_window…`, `writer_provider_unavailable:breaker_open…`, `writer_provider_limit` | A provider is down or out of its window | Nothing: the chain moves on, or the task resumes by itself when the window resets / the breaker closes |
| `writer_provider_unavailable:thread_not_started…` | The provider could not start its session (the core refused it or its CLI is down); the task never ran | Nothing while the chain has another writer: the provider is set aside for an hour, the next writer takes the task, no attempt is spent. If the task ended on it, the whole chain was down: tell the owner in one line which provider fails to start |
| `waiting_writer:` (any other hold) | Every writer is held | Nothing: the task resumes by itself when one frees up |
| `waiting_writer:…core_unsupported`, `writer_provider_unavailable` | No writer in the chain can run on this core: it does not pass by itself | `lane_pilot_reassign_task` (taskId, model) works only on a **running** task (a stuck writer); a queued task waits for a free writer — then tell the owner in one line which provider to enable for the project |
| waits on a `depends_on` task that is blocked | Dependents wait up to 6 hours | Fix and send the blocked one again; they start once it is accepted. If you verified by hand that its result is already there: `lane_pilot_update_task` on **the blocked task** (taskId, satisfied: true) frees its dependents. Overlapping owns_paths: nothing, it starts when the other task ends |
| waits for the owner's word (`owner_word`, a risky task verified but not merged) | owner.words: a high-risk task lands on main only after his yes | Ask him once with `lane_pilot_ask_owner`; write his answer with `lane_pilot_queue {action:"word", taskId, decision, text}`, then send the task again — the same writer thread merges |
| nothing moves anywhere | The conveyor may be off | `bb lane-pilot conveyor status`; it is the owner's switch: tell him it is off and why, do not turn it on yourself |
| merge held by another chat (`blockedBy`) | Uncommitted edits or a holder in the same checkout | `lane_pilot_relay {action:"ask"}` to the holder, end the turn |
| `waiting: the run is paused` | Someone paused it | `bb lane-pilot resume <run-id>` when the reason is gone |
| `waiting: held until <date>` | `lane_pilot_queue {action:"hold"}` parked it | Release it: `lane_pilot_queue {action:"release", taskIds:[…]}` (or wait for the date) |
| `merge_conflict` with main | Main moved under the task; its writer resolves the conflict in its worktree, or the task is redone on the new main; no attempt is spent. Uncommitted edits in the base checkout are not a conflict: Lane Pilot asks the chats in that folder to commit, then merges | Wait. Do not rebase, commit others' edits or redispatch |
| `waiting_secret:NAME` | The check needs a name missing from Env Catalog, or left out of the project's non-empty `secrets.allow` | `env_request` for a missing name. A name left out of `secrets.allow` is a project setting: ask the owner in one line to allow it. No attempt is spent; the task starts once the value is there |
| `blockedBy` that does not move | The holder's state, output and `retryAfterSec` stopped changing | Tell the owner in one message what you tried and what to choose |

## Where the rest is

| Symptom | File | Read when |
|---|---|---|
| A task is blocked: critique, `needs_human`, `verdict_block`, retries spent, a failed check, a Lane Pilot fault; a folder without git | references/blocked.md | The task state says blocked, failed or needs a human |
| A graph failed or stopped; accepted work is wrong later; only the owner can decide | references/graphs-and-review.md | A graph step failed, a merged change must be checked or undone, or the owner has to choose |

## 6. How to tell the owner

One line per stuck thing, in plain Russian: what waits, why, what you did about it, when it moves. No ids, no English codes.
If you used a way out from this page, say which one in words («снял карантин: удаление было задумано»).
