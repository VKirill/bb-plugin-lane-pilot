---
title: Waiting for the owner
type: component
created: 2026-10-22
updated: 2026-11-23
status: active
confidence: medium
tags: [sma, owner, telegram, ui, morning-list]
sources:
  - src/rooms/owner-waiting/server/services/owner-items-service.ts
  - src/rooms/owner-waiting/server/services/owner-push-service.ts
  - src/rooms/owner-waiting/server/handlers/waiting-cli.ts
  - src/rooms/owner-waiting/migrations.ts
  - src/rooms/owner-waiting/server/handlers/owner-waiting-rpc.ts
  - src/rooms/owner-waiting/ui/owner-waiting-board.tsx
  - src/rooms/writer/server/services/question-timeout.ts
  - src/rooms/workflow/server/services/workflow-human-form.ts
  - src/rooms/workflow/server/services/workflow-answer.ts
  - src/rooms/platform/server/services/pm-notice.ts
  - src/rooms/reports/server/index.ts
  - src/rooms/reports/server/services/daily-report.ts
  - src/rooms/reports/server/services/owner-push.ts
  - src/rooms/reports/server/services/telegram.ts
  - tests/owner-waiting.test.ts
  - tests/owner-waiting-ui.test.tsx
  - tests/owner-push-script.test.ts
  - src/rooms/verification/server/services/gate-red-report.ts
  - src/rooms/outage/server/services/outage-service.ts
  - src/rooms/schedule/server/handlers/schedule-agent-actions.ts
  - src/rooms/schedule/server/services/schedule-service.ts
---

> [!important] Since 2026-10-29 the owner does take part in one wait
> With `owner.words` on, every verified task waits up to six hours for his «yes» before its merge; on `risky` only a task of risk high or critical waits; on `sensitive` (the default) only a task in money, database changes or a production deploy waits; the rest land by themselves; his answer comes through this same inbox. Everything below stays as said: only inbox items appear here.
> Waiting deferrals and held memory conflicts are system records and are not listed in this inbox. The history block at the foot describes the earlier design.

# Waiting for the owner

TL;DR: one screen («Ждут владельца», in the System group of the Lane Pilot page), one command (`bb lane-pilot waiting`), one line in the daily report and one short Telegram message hold what callers post to the owner's inbox. Each item says what it is, why it is his, where the evidence is and the exact action. One thing does wait for an answer: a task gated by `owner.words` holds its merge up to six hours for the owner's yes (owner decision 2026-10-29); after that it blocks instead of asking again. Everything else goes on without him.

## Purpose

SMA D0-3 («Waiting for you» card, «one wait, one message»). The screen keeps the open rows posted to the `lane_pilot_owner_item` inbox.

## How it works

1. **Sweep resolved waits**: On every read, `collectOwnerWaiting` first calls `sweepOwnerItems` to close rows whose domain sweep says the question disappeared and to expire untrimmed notes and fact rows past their TTL (`src/rooms/owner-waiting/server/services/owner-items-service.ts`).
2. **Collect and filter sources**: `inbox` loads open `lane_pilot_owner_item` rows, filtering out drill and bench sandbox projects (`isSandboxProject`) (`src/rooms/owner-waiting/server/services/owner-items-service.ts`).
3. **Rank and cap `now` vs `later`**: Rows are sorted by urgency cost via `callReason` (`red` > `blocked` > `term` > `decision`), then `wake`, source order, and timestamp; the first `NOW_CAP` (5) items receive tier `now` and the rest remain `later` (`src/rooms/owner-waiting/server/services/owner-items-service.ts`).
4. **Post, close, and failures**: Callers write idempotent rows with `postOwnerItem` and resolve them with `closeOwnerItem`; sandbox projects are ignored and system-closed (`janitor:*`, `profile-check:*`) rows reopen on the same key whereas owner-closed rows stay closed (`src/rooms/owner-waiting/server/services/owner-items-service.ts`). Reading `lane_pilot_owner_item` in `inbox` when the table is missing returns no items.

## What is read

`collectOwnerWaiting` (`src/rooms/owner-waiting/server/services/owner-items-service.ts`) reads existing tables; it decides nothing. Rows of sandbox projects are filtered out.

| Source | Rows | Wakes the phone | The action |
|---|---|---|---|
| `writer` | a writer's question to a human that went unanswered for `writer.question_wait_min` (default two hours): with `writer.auto_return` on, the second pilot could not answer or narrow it and the PM chat was cold or refused the note (`src/rooms/writer/server/services/second-pilot.ts`, no wake); with it off, a product question (`src/rooms/writer/server/services/question-timeout.ts`, wake); and, since 0.1.458, a verified task of risk high or critical waiting for the owner's word before it lands (`kind task_word`, `src/rooms/writer/server/services/finish.ts`, buttons да / нет → `task_word`) | by the row's `wake` | the buttons; or answer in the task's objective and send the task again |
| `workflow` | the end of a run that has no PM chat to tell, unless it is the machine's own (an `lp.*` graph or `lead-tick` no schedule started) or a scheduled run without a report (`src/rooms/platform/server/services/pm-notice.ts`); and a `builtin:human` question when the run has no PM chat or the owner dismissed or timed out the chat form (`kind workflow_question`, `src/rooms/workflow/server/services/workflow-human-form.ts`, closed by `answerWorkflowQuestion` in `src/rooms/workflow/server/services/workflow-answer.ts`) | on failure; `yes` for `workflow_question` | the row's own actions (`workflow_answer` / `bb lane-pilot workflow-answer` for `workflow_question`) |
| `integration-gate` | a red integration gate no merged task is to blame for (pre-existing failures, the machine, a gate that ran no test), or one whose repair task could not be dispatched (since 0.1.459), one row per red episode (`src/rooms/verification/server/services/gate-red-report.ts`) | no | read the log the row names; fix the tests or the gate command |
| `outage` | an outage window (`src/rooms/outage/server/services/outage-service.ts`) | no | the row's own actions |
| `schedule` | a scheduled agent's outcome or block (`src/rooms/schedule/server/handlers/schedule-agent-actions.ts`); every failed run of a schedule (`schedule_failed`; `schedule_paused` for the run that paused it; `src/rooms/schedule/server/services/schedule-service.ts`; since 0.1.458 always here, never the PM chat). Since 0.1.467 the row offers something: a live cron «Поставить на паузу» (`schedule_pause`), a one-off «Запустить снова» (`schedule_run_now` with the failed run's id as the key, so a second press is the same run) and says it will not fire again by itself; a run the owner cancelled posts nothing | on `urgent`; a failure only when it paused the schedule | the row's own actions |
| `backlog` | the first ready item of a project's `.agents/todos` backlog (`backlog_ready`, `src/rooms/backlog/server/services/scanner.ts`, hourly); since 0.1.458 the scanner offers and the owner issues: the button «Выдать в работу» (`backlog_issue`) sends the order into the project's PM chat | no | the button |
| `integration-gate` (post-merge) | after a merge, a check red because of the machine (`gate_machine`) or main red again after a mainfix task (`gate_red`), `src/rooms/writer/server/services/finish.ts` (since 0.1.458 rows, not PM messages) | no | fix the machine; dispatch the fix in the project's chat |
| anything posted | `postOwnerItem` or `bb lane-pilot waiting post '<json>'` (`src/rooms/owner-waiting/server/services/owner-items-service.ts`) | by the row's `wake` | the row's own `actions` |

**The janitor (since 0.1.458).** Every read of the list first closes the rows whose question went away (`sweepOwnerItems`, `src/rooms/owner-waiting/server/services/owner-items-service.ts`): a writer's question once its task moved on (a newer attempt, or the blocked one left `blocked`); a task-word row when the word is given or the wait ends; a backlog offer whose item is no longer issuable (`janitor:not issuable`); a failed schedule run once a later run of that schedule ended, the schedule is paused or gone (0.1.467; the same row leaves with the facts after three days even with its buttons); a row with no action after its term — a fact (`handed`, `acted`, `tick_*`, `labels`, `right_changed`, `schedule_failed`, `schedule_paused`, `outage`, `gate_machine`, `backlog_ready`) after three days, anything else without buttons after seven. The three grills of 0.1.456 called the old screen «an inbox where rows are born and never die». Since 0.1.461 the badge (`ownerWaitingCounts`) runs the sweep before counting; every row without buttons carries «Прочитано» (RPC `owner_waiting_close`, closes the row as `screen`); and the same key posted again reopens a row the system closed (`janitor:*`) with the new text, while a row the owner answered (`owner`, `screen`, `agent`) stays closed — his word stands, a system close is not an answer. An evidence chip copies its reference on click.

Beside the list the screen shows **what went red overnight** (attempt states of the last 24 hours with the attempt ids as evidence) and **what was accepted** (`overnight`, `src/rooms/owner-waiting/server/services/owner-items-service.ts`).

## The item shape (the contract with the posters)

`OwnerItem` is the stable shape: `key` (stable, a repeat is the same waiting), `source`, `kind`, `projectId`, `what`, `why` it is the owner's, `since`, `wake`, `evidence[]` (`{kind: attempt|task|run|file|note|message|command|text, ref, label?}`) and `actions[]` (`{id, label, cli, rpc?, needsOwnerMessage?, hint?}`; with `rpc` the screen draws a button, without it the command is shown to copy). Callers write rows with `postOwnerItem` (or `bb lane-pilot waiting post '<json>'`) and close them with `closeOwnerItem` (`waiting close <key> --by …`); the screen, the daily line and the Telegram digest pick them up with no further code (`src/rooms/owner-waiting/server/services/owner-items-service.ts`). The text of built-in items is Russian (the owner's language); the screen chrome has EN and RU.

## The words (since 0.1.456)

The screen is read by a person who does not program (the owner, 2026-11-01: «ни слова не понял»). Every row answers four questions in plain
Russian, addressed as «вы» like the rest of the UI: what happened (`what`: one sentence, no ids, no English), why it is his (`why`), what to do
(buttons when the plugin has the RPC, else one plain instruction), and the technical part for a developer folded under «Подробности»: when it
appeared, the key, where to look (`evidence`, kinds said in words) and the commands. The ids of runs, ticks, branches, tasks and threads go into
`evidence`, never into `what`; `tests/owner-waiting/plain-words.test.ts` scans every `postOwnerItem` call for an id in the title. The sections
name every source in words (`SECTIONS` in `src/rooms/owner-waiting/ui/owner-waiting-board.tsx`), an attempt's state code is said in words
(`stateLabel`), and the lead's brief asks for proposals written for a person without a technical background
(`src/rooms/lead/server/services/tick-service.ts`). The gate's `why` keeps its technical analysis (the failing tests, the culprit) after a Russian title.

## Telegram

`mountReports` registers the `owner-push` schedule every 30 minutes (`src/rooms/reports/server/index.ts`); `runOwnerPush` queries `owner_waiting_digest`, sends the text through `createTelegramSender` using Env Catalog records `TG_AIVECH_BOT`, `TG_OWNER_CHAT_ID`, and `LANE_PILOT_TG_TOPIC`, and then calls `owner_waiting_ack` with the keys (`src/rooms/reports/server/services/owner-push.ts`, `src/rooms/reports/server/services/telegram.ts`). `scripts/lp-owner-push.sh` remains only as a fallback. The rules are in code (`src/rooms/owner-waiting/server/services/owner-push-service.ts`) and tested:

- only items with `wake` push; the rest wait on the screen and in the daily report;
- one waiting, one message: an acknowledged key never pushes again; a send that failed is not acknowledged, so the next run tries again;
- quiet hours, default 23:00-08:00 in Europe/Madrid: nothing is sent, nothing is lost, the items go out together in the first digest after;
- at most six items are named, the rest are counted.

Settings (rows `owner_push.enabled|quiet|timezone` of the global level, edited on the Settings page; the old table `lane_pilot_owner_config` is the fallback for a field with no row): `bb lane-pilot waiting config [enabled=on|off] [quiet=HH:MM-HH:MM] [timezone=Europe/Madrid]`, or the Telegram block at the foot of the screen. `quiet=00:00-00:00` means no quiet hours.

## Daily report

`daily-report` (`src/rooms/reports/server/index.ts`, `src/rooms/reports/server/services/daily-report.ts`) collects daily task, gate, schedule, and inbox totals for the daily digest.

## Data

Three tables, appended at the end of `migrations` (`src/rooms/owner-waiting/migrations.ts`): `lane_pilot_owner_item` (the inbox), `lane_pilot_owner_push` (keys already sent), `lane_pilot_owner_config`.

## RPC and commands

`owner_waiting` (the list), `owner_waiting_digest`, `owner_waiting_ack`, `owner_waiting_config`; `bb lane-pilot waiting [--json] | digest | ack <key>… | config … | post '<json>' | close <key> --by …`.

## Limits

- Evidence links are references (attempt id, note id, command); the screen does not open an attempt or a note on click.

## History: the pre-2026-10-22 design

Before 2026-10-22 the screen also held `deferral_overdue`, `deferral_term`, `memory_conflict`, and `rule_proposal`. None of these is a source any longer: held memory conflicts settle at write time, and `lane_pilot_owner_item` holds only direct inbox waits.

## «Now» and «later» (harness batch 2026-11-02)

The list is ranked by the cost of putting a row off (`callReason`: red, then stopped work, then a term, then a decision; a row that would push before one that would not; then the sources' order and age) and only the first `NOW_CAP` = 5 rows are «now»: the screen shows them first, the rail badge counts them, and only a «now» row with `wake` may go to Telegram. The rest are «later», folded, and move up as rows close. `answered` counts who closed the week's rows (owner, agent, lead, janitor); the research behind it: an inbox of 28 rows a day is answered by reflex.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Orchestration and execution data](data-model/orchestration.md)
- [Observability](guide/observability.md)
