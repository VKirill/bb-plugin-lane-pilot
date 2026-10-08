# Schedule board: Lane Pilot's own scheduler

Lane Pilot runs scheduled work itself: a workflow, an agent errand, or a script on a chosen machine, once or on a cron. It does not need
the official Automations plugin (that one stays on until every automation has moved and run seven days clean; `workflow-triggers.ts` still
creates its automations for the schedule triggers of workflows, see [workflow-triggers.md](workflow-triggers.md)).

Code: `src/schedule/` (pure: time, model, store, scheduler, board views, RPC contract), `src/server/schedule-*.ts` (executors, service,
PM tool, approvals, CLI), `src/script-run.ts` and `src/jobs.ts` (the script on a host). Tests: `tests/schedule/`.

## How a tick works

Every minute the core runs the isolated schedule `schedule-board-tick` (`scheduleIsolated`, overlap `skip`, 2 minute limit):

1. **Materialise.** For each active schedule the fire times in `(cursor, now]` become rows of `lane_pilot_schedule_run`, and the cursor moves,
   in one transaction. The row's `run_key` is `<schedule id>:<scheduled time in ms>` and is UNIQUE (`INSERT OR IGNORE`): a tick that runs twice,
   two instances ticking during a reload, or a crash between the insert and the cursor move add nothing the second time. A run started by hand
   has the key `<schedule id>:manual:<key>`.
2. **Supervise** (up to 50 s). Queued rows are claimed (`UPDATE ... WHERE status='queued'`, one winner) and started under the overlap policy;
   running rows are polled until they end. Nothing lives in memory between ticks: what is not finished is read from the table by the next tick,
   or by the next hub after a restart.

Starting is idempotent on the run key, so a start repeated after a crash finds the work it began (a run claimed but with no reference
recorded is started again): a workflow run is keyed by it (`wf-manual:<project>:<workflow>:<run key>`), an errand's thread by its `spawnId`
(`schedule:<run key>`, VK keyed spawn), a script's host job by the job key (`jobStart.key`, kept by the host in `jobs/keys/`). Work that
finished while the hub was off is taken as it ended, not timed out. A host that stays silent for ten minutes past the deadline fails the run (`unreachable`).

| Table | Holds |
| --- | --- |
| `lane_pilot_schedule` | the definition (task JSON, trigger, policies), `state` (active, paused, done), `consecutive_failures`, `cursor_at` |
| `lane_pilot_schedule_run` | one row per tick: `status` (queued, running, waiting, succeeded, failed, timed_out, skipped, canceled), `reason`, `ref_kind/ref_id` (workflow run, thread, host job), `exit_code`, `output` (cut to 64 KB), `error`; the newest 200 per schedule are kept |

## Time

`cron` has five fields (minute hour day-of-month month day-of-week; no names, no `?`, `L`, `W`); `timezone` is an IANA name (the hub's own
when absent). Day-of-month and day-of-week combine with OR when both are restricted, with AND otherwise (Vixie cron); Sunday is 0 or 7.
Clock changes follow the classic cron and what a person means:

| Schedule | Clock goes back (a time happens twice) | Clock goes forward (a time is skipped) |
| --- | --- | --- |
| fixed hour (`30 2 * * *`, `0 9 * * *`) | once, at the first occurrence | once, shifted by the gap (02:30 becomes 03:30) |
| wildcard hour (`0 * * * *`, `*/15 * * * *`, `0 */2 * * *`) | follows real time: fires in both passes | follows real time: never in the skipped hour |

Europe/Madrid (2026-03-29, 2026-10-25), Australia/Sydney (2026-04-05, 2026-10-04), Australia/Lord_Howe (30-minute shift) and Pacific/Auckland
are in `tests/schedule/time.test.ts`. A one-time task takes `runAt` (ms) or `delay` (`30m`, `2h`, `1d`, `через 2 ч`) counted from the save.

## Policies

- **Missed ticks** (`missed`): a fire time more than 3 minutes behind now is missed (the hub was off or reloading). `run_once` (default): one
  catching-up run for the newest missed tick, unless a fresh tick is due too (that run covers it); `skip`: none; `run_all`: each, the newest
  `missedLimit` (1 to 20, default 5). The missed ticks that do not run are noted as up to three `skipped` rows with their count. A paused
  schedule does not count its pause as missed; a one-time task whose moment passed runs late as the policy says.
- **Overlap** (`overlap`): a tick that finds the last run (running or waiting for the owner) still going is `skip`ped (default), `queue`d
  (up to 10) or run in `parallel`. A catching-up run waits its turn instead of being skipped.
- **Timeout** (`timeoutSec`; default workflow 3600, errand 3600, script 600; a script at most 10 700). A workflow run that waits for the
  owner's answer is not counted: it is given up after 72 hours.
- **Pause** (`maxFailures`, default 3, 0 never): that many failed or timed-out runs in a row pause the schedule and a message goes to the
  project's PM chat. Resume forgives them and counts time from now.

## The three kinds

| `task.kind` | Fields | Runs as |
| --- | --- | --- |
| `workflow` | `workflowId`, `inputs` | a workflow run of the engine, started like the Run button (published, inputs whole, requirements met, a PM chat of the project). A `tested` workflow is refused until its first live run (Workflows tab, Run for real). Output: the run's output JSON |
| `errand` | `task` (text), `title`, `authorized`, `accounts` (Env Catalog names), `providerId`, `model`, `reasoning`, `serviceTier`, `preset` (who runs it, see below) | a helper thread under the project's PM chat, as `lane_pilot_errand` starts it (same brief, same account gate, same repository-edit check), plus a note that nobody is watching and the metadata `origin: "schedule"`. Output: the helper's report; `ERRAND: blocked` fails the run |
| `script` | `hostId`, `command`, `cwd`, `env` (Env Catalog names), `maxOutputBytes` | the host job `runScript` (`bash -lc`, own process group, killed at the timeout) on that machine. The secrets are resolved by the hub (allowed for the project, or the owner is asked), reach the script as environment variables only, are masked on the host and again on the hub; the host deletes `input.json` once the job has read it. stdout and stderr are kept head and tail up to the cap; exit code 0 is success |

The hosts need the Lane Pilot host build with `runScript` and `jobStart.key`; an older host answers that it does not know the method, and the run fails with that.

## RPCs for the board and the calendar

All times are ms since epoch. `ScheduleView` (`src/schedule/views.ts`): `id, projectId, name, description, task, when, missed, missedLimit,
overlap, timeoutSec, maxFailures, state, pauseReason, consecutiveFailures, createdBy, createdAt, updatedAt, nextFires[], machine, lastRun,
active[], column, model, cost, where`. `column` is where the card stands: `paused`; else `waiting` (a run waits for the owner), `running`; else `failed` (the last
run failed or timed out, until one succeeds); else `done` (a one-time task that succeeded); else `scheduled`. The columns of the plan
(Запланировано, Выполняется, Ждёт тебя, Готово, Ошибка, На паузе) are `scheduled, running, waiting, done, failed, paused`.

| RPC | Input | Output / notes |
| --- | --- | --- |
| `schedule_list` | `{projectId?, next?}` (next 0 to 50, default 5) | `{schedules: ScheduleView[], hosts: [{id,name,connected}], now, errandDefault}`; `hosts` fills the machine picker; `errandDefault` is the Automation default model (below) |
| `schedule_get` | `{id, runs?, next?}` | `{schedule \| null, runs: RunView[], runTotal}` |
| `schedule_runs` | `{id, limit?, offset?}` | `{runs, total}`, newest first. `RunView`: `id, scheduleId, scheduledAt, trigger (tick, catchup, manual), status, reason, queuedAt, startedAt, finishedAt, durationMs, refKind, refId, hostId, exitCode, output, error, truncated, providerId, model, tokens, costUsd, usageKnown, hostName`. `refKind: "thread"` + `refId` is the errand's thread (`@thread:<refId>`), `workflow_run` + `refId` opens the run in the Workflows tab |
| `schedule_preview` | `{definition, next?}` | `{ok, problems[], warnings[], conflicts[], nextFires[], timeoutSec}`: validation without saving; call it on every change of the create form |
| `schedule_upsert` | `{definition}` (with `id` it replaces) | `{ok, schedule, problems[], warnings[], conflicts[]}`. `problems` stop the save; `warnings` and `conflicts` do not |
| `schedule_pause` / `schedule_resume` | `{id, reason?}` / `{id}` | `{schedule \| null}` |
| `schedule_run_now` | `{id, key?}` | `{ok, run, created, reason?}`; the run starts within seconds; a repeated `key` is the same run |
| `schedule_cancel_run` | `{runId}` | `{ok}`: a queued run is dropped, a running one is told to stop |
| `schedule_delete` | `{id}` | `{ok}` (the history goes with it) |
| `schedule_calendar` | `{projectId?, from, to}` | `{planned: [{scheduleId, at}], past: RunView[], truncated: scheduleId[]}`: the planned times of active schedules (at most 300 each) and the runs that happened in the range; a month view reads this once |

## Detail view: what is sent, who runs it, what it costs, where

The card gives the short form; the title (or «Details») opens the whole task in place (`schedule-detail.tsx`). **What the agent will receive** is the
full errand text in an editable textarea (a script: command, machine, folder); **Save** sends the same definition with the `id` through
`schedule_upsert`, so history and place are kept; **Revert** drops the edit. A chain shows its id and inputs read-only. The same model picker, the
resolved-model line and the text are in the edit form.

### Who runs an errand

One pure function, `resolveErrandModel({task, settings, pm})` (`src/schedule/errand-model.ts`), answers for the executor (what is spawned) and for
`ScheduleView.model` (what the card says). First level that has a model wins; the task's own `reasoning` and `serviceTier` then override the effort
and tier of that level:

1. the task's pair: `providerId` + `model` (`model` alone is the legacy form and means `claude-code`); `source: "task"`;
2. the task's `preset` (a model preset slug or alias: `cheap-fast`, `strong`, `ins-*`; `workflow.preset.<slug>.*` settings, else the built-in); `source: "preset"`;
3. the Automation default `schedule.errand_default` (the project's own row, else the global one): `{provider, model, reasoning_effort?, service_tier?}` or `{preset}`; `source: "schedule-default"`;
4. the errand role default: settings `errand.provider` / `errand.model` / `errand.reasoning_effort` when set, else the built-in `claude-code` / `claude-opus-5-5` / `high` (what every errand ran on before); `source: "errand-role"`;
5. the PM chat's model, `source: "pm"`, **only when level 4 has no model**. The built-in default always has one, so no caller reaches this level today (the pure function takes `builtin: null` to model a build without it; the executor passes the PM chat's model; the card, which reads it synchronously, does not, and cannot differ while level 4 always has a model).

No effort anywhere: `high` for claude-code, `none` for another provider. Problems found while resolving come back in `issues` (`unknown_preset`, `invalid_schedule_default`,
`provider_without_model`); `schedule_upsert` refuses `preset` that does not exist and a `providerId` without a `model`. `ScheduleView.model` is `{providerId, model,
reasoningEffort, serviceTier, source, sourceKey, issues}` for an errand and `null` for a script and a chain; the board shows «Will run: provider · model · effort — from: ...».
A chain lists the resolved executor of each step from `workflow_step_executors`, read-only (step models are set in the workflow). The PM tool
`lane_pilot_schedule` stores no model when none is named; `create` and `list` echo the model it resolves to.

### The Automation default (`schedule.errand_default`)

Saved with the generic `save_setting` (project id of the open project, or `"*"` at the global page; `expectedVersion` from `errandDefault`), validated in
`src/setting-validation.ts`. `schedule_list.errandDefault` is `{effective, source ("project" | "global" | null), project, global, projectVersion, globalVersion}`.
The collapsible block «Default executor» at the top of the schedule area edits the project's value inside a project (with «Inherit», which calls
`reset_project_settings` and lets the global value show) and the global value at the global page («Clear» saves `null`). The key is allowed in
`reset_project_settings` beside the catalog keys.

### Cost

`ScheduleView.cost` (errand only) is `{perRunUsd, samples, priceInPer1M, priceOutPer1M}`: the average over the schedule's last 20 finished runs whose run thread has
usage in `lane_pilot_token_cursor` and a priced model (`src/model-prices.ts`), and the resolved model's price per 1M tokens. The board prints «≈ $0.12 per run (average of 5)»,
with no history the price, and «cost unknown» when the model has no price. `RunView` carries `providerId`, `model`, `tokens`, `costUsd` and `usageKnown` (from the run
thread, `src/server/schedule-usage.ts`): a run with no usage row (an ACP provider reports none, or the sync has not seen the thread yet) prints «unknown», never 0.
Only `schedule_runs` and `schedule_get` fill these; `lastRun`, `active` and the calendar carry empty ones.

### Where it runs

`ScheduleView.where` is `{projectName, sectionId, sectionName, sectionPath, hostId, hostName, cwd}` (`src/server/schedule-place.ts`). The project's name comes from BB;
the Project Folders section is the one the project's PM chat is filed in (the thread's `sectionId`, else the deepest folder section whose path holds the chat's environment);
the machine and folder of an errand and a chain are the PM chat's environment (the helper thread reuses it; the project's first source when no chat is open); a script names its own
machine and folder. Whatever BB does not tell stays `null`. The card line reads «SelfyStudio › Marketing · Mac mini». The project, the section and an errand's machine are shown, not
edited: a schedule cannot move to another project, and where a chat is filed is set in Project Folders. `RunView.hostName` is the machine the work ran on: the errand thread's own
machine (its environment's host, read once per thread), a script's host; `RunView.hostId` stays the Browser QA machine used for conflict detection.

A definition (`schedule_upsert.definition`, `src/schedule/model.ts`): `{id?, projectId, name, description?, task, when, missed?, missedLimit?,
overlap?, timeoutSec?, maxFailures?}` with `when` = `{type:"cron", cron, timezone?}` or `{type:"once", runAt? | delay?}`.

**Conflicts.** A schedule that has a machine (a script's `hostId`, an errand's Browser QA machine) is compared with the other active schedules
of the project on that machine over the next 7 days: two starts within 10 minutes are a conflict (`{scheduleId, name, machine, pairs, windowMinutes, samples[]}`),
reported in `conflicts` and as a warning, never blocking. The calendar can mark the same pairs from `schedule_calendar`.

**Live updates.** `lpChannel(projectId)` carries `{kind: "schedule"}` whenever a schedule or a run changes (a run starting, ending, waiting; a save; a pause);
re-read `schedule_list`. The usual slow poll covers a missed signal.

## Who may change a schedule

- Anyone may change a schedule: the board, `bb lane-pilot schedule ...`, `bb plugin rpc call lane-pilot schedule_*` and the PM's tool `lane_pilot_schedule`
  (`action`: list, show, create, update, delete, pause, resume, run_now) all go straight through, with no caller check and no owner form (owner decision
  2026-10-08: every machine is the owner's, BB is reachable only over his WireGuard). The PM creates schedules directly.
- **A thread that a schedule started cannot touch schedules** (`create`, `update`, `delete`, `pause`, `resume`, `run_now` are refused with `schedule_origin`; `list` and `show` work):
  a scheduled errand's thread carries `pluginMetadata.origin = "schedule"` and so does anything below it (the check walks the parent chain, four hops).
  The tool is one tool, not nine, because a compiled agent profile holds at most 64 tools and the PM's list had room for two.

## Skill section (for the canon `lane-pilot-workflows`, `references/schedule.md`)

> **Scheduling a chain.** A chain with a `schedule` trigger gets its BB automation as before (`docs/workflow-triggers.md`). For a one-off or
> anything that is not a chain, use the schedule board: `lane_pilot_schedule` (PM) with `action: list` to see what exists, `create` with
> `{name, task, when}`. `task` is `{kind:"workflow", workflowId, inputs}`, `{kind:"errand", task, authorized, accounts, model}` or
> `{kind:"script", hostId, command, cwd, env}`; `env` and `accounts` are Env Catalog names, never values. `when` is
> `{type:"cron", cron:"0 9 * * 1-5", timezone:"Europe/Madrid"}` or `{type:"once", delay:"2h"}`. Defaults: ticks missed while Lane Pilot was off
> run once (`missed`), a tick that finds the last run going is skipped (`overlap`), three failures in a row pause it (`maxFailures`). The owner is
> asked before anything is created, changed or deleted; tell them and call again with the same arguments after their yes. A workflow must be
> published before a schedule can start it. A thread that a schedule started cannot schedule anything: write the need in its report.

## Live check in the sandbox project (`proj_3tb652jpsi`)

Needs the build on the hub and the new host build on the machine used for the script. For each kind: create, run now, read the history, delete.
The sandbox PM chat must be open (`lane_pilot_workflow_status`-style requirement of workflow and errand runs).

```bash
bb plugin rpc call lane-pilot schedule_upsert --input '{"definition":{"projectId":"proj_3tb652jpsi","name":"live: script","task":{"kind":"script","hostId":"<host id>","command":"echo hello; date","cwd":"/tmp"},"when":{"type":"once","delay":"1h"}}}'
bb plugin rpc call lane-pilot schedule_run_now --input '{"id":"<schedule id>"}'
bb plugin rpc call lane-pilot schedule_runs --input '{"id":"<schedule id>"}'     # status succeeded, output "hello", refKind host_job
bb plugin rpc call lane-pilot schedule_delete --input '{"id":"<schedule id>"}'
```

The same with `"task":{"kind":"errand","task":"Open https://example.com and report its title.","authorized":false}` (the history shows `refKind: "thread"`; open `@thread:<refId>`) and with `"task":{"kind":"workflow","workflowId":"<a published workflow with no required inputs>","inputs":{}}` (`refKind: "workflow_run"`). Run these from the owner's terminal, not from an agent's shell: the guard refuses the changing RPCs there.
