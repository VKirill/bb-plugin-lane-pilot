---
title: Waiting for the owner
type: component
created: 2026-10-22
updated: 2026-10-30
status: active
confidence: medium
tags: [sma, owner, telegram, ui, morning-list]
sources:
  - src/rooms/owner-waiting/items.ts
  - src/rooms/owner-waiting/push.ts
  - src/rooms/owner-waiting/cli.ts
  - src/rooms/owner-waiting/migrations.ts
  - src/rooms/owner-waiting/server/rpc.ts
  - src/rooms/owner-waiting/ui/owner-waiting-board.tsx
  - src/rooms/policy/morning.ts
  - src/rooms/writer/server/question-timeout.ts
  - src/rooms/workflow/server/pm-notice.ts
  - scripts/lp-morning.sql
  - scripts/lp-metrics-daily.sh
  - scripts/lp-owner-push.sh
  - tests/owner-waiting.test.ts
  - tests/owner-waiting-ui.test.tsx
  - tests/owner-push-script.test.ts
  - tests/policy/morning.test.ts
---

> [!important] Since 2026-10-29 the owner does take part in one wait
> With `owner.words` on, every verified task waits up to six hours for his «yes» before its merge; on `risky` (the default since 0.1.442) only a task of risk high or critical waits, the rest land by themselves; his answer comes through this same inbox. Everything below stays as said: only what his own words started and the inbox items are listed; the morning list reports the rest.
> The screen holds only what the owner's own words started (learned items from his messages, e.g. a reminder) and whatever a caller posts to the inbox. Waiting rules, deferrals, held memory conflicts and night repairs are the system's and are not listed; the morning list is a report (`src/rooms/policy/morning.ts`). The history block at the foot describes the earlier design.

# Waiting for the owner

TL;DR: one screen («Ждут владельца», in the System group of the Lane Pilot page), one command (`bb lane-pilot waiting`), one line in the daily report and one short Telegram message hold what the owner's own words started and what callers post to his inbox. Each item says what it is, why it is his, where the evidence is and the exact action. One thing does wait for an answer: a task gated by `owner.words` holds its merge up to six hours for the owner's yes (owner decision 2026-10-29); after that it blocks instead of asking again. Everything else goes on without him.

## Purpose

SMA D0-3 («Waiting for you» card, «one wait, one message»). The night policy (`docs/night-policy.md`) sends proposals and owner-only decisions to the morning list; the screen keeps the two sources that remain — the learned items his own messages produced, and the `lane_pilot_owner_item` inbox.

## What is read

`collectOwnerWaiting` (`src/rooms/owner-waiting/items.ts:135`) reads existing tables; it decides nothing. Rows of sandbox projects are filtered out (`items.ts:90-98`).

| Source | Rows | Wakes the phone | The action |
|---|---|---|---|
| `learning` | `lane_pilot_learning_item` in state `pending_owner` — learned items from his own messages (`items.ts:66-75`) | yes, since 0.1.461 (RPC `learning_decide`) | `bb lane-pilot learning accept\|reject <id>` |
| `writer` | a writer's question to a human that went unanswered for `writer.question_wait_min` (default two hours): with `writer.auto_return` on, the second pilot could not answer or narrow it and the PM chat was cold or refused the note (`src/rooms/writer/server/second-pilot.ts`, no wake); with it off, a product question (`src/rooms/writer/server/question-timeout.ts`, wake); and, since 0.1.458, a verified task of risk high or critical waiting for the owner's word before it lands (`kind task_word`, `src/rooms/writer/server/finish.ts`, buttons да / нет → `task_word`) | by the row's `wake` | the buttons; or answer in the task's objective and send the task again |
| `phase` | owner-word turns of a running phase (`src/rooms/phase/server/driver.ts:378`, `:1032`) | by the row's `wake` | the row's own `actions` |
| `workflow` | the end of a run that has no PM chat to tell, unless it is the machine's own (an `lp.*` graph or `lead-tick` no schedule started: their end is the log's and the wall's, since 0.1.456) or a scheduled run without a report (`src/rooms/workflow/server/pm-notice.ts:111-130`) | on failure | the row's own `actions` |
| `integration-gate` | a red integration gate no merged task is to blame for (pre-existing failures, the machine, a gate that ran no test), or one whose repair task could not be dispatched (since 0.1.459), one row per red episode (`src/rooms/verification/server/integration-gate.ts:710`) | no | read the log the row names; fix the tests or the gate command |
| `run-goal` | a done run whose accepted tasks are red together on main (`src/rooms/run-goal/server/run-goal.ts:34`) | no | a fix task, or `bb lane-pilot return` |
| `wall` | a wall class that ran out of moves (`src/rooms/wall/service.ts:232`) | no | the row's own `actions` |
| `outage` | an outage window (`src/rooms/outage/server/outage.ts:23`) | no | the row's own `actions` |
| `schedule` | a scheduled agent's outcome or block (`src/rooms/schedule/server/schedule-agent-actions.ts:79`); every failed run of a schedule (`schedule_failed`, `src/rooms/schedule/server/schedule-service.ts`; since 0.1.458 always here, never the PM chat) | on `urgent`; a failure only when it paused the schedule | the row's own `actions` |
| `backlog` | the first ready item of a project's `.agents/todos` backlog (`backlog_ready`, `src/rooms/backlog/server/scanner.ts`, hourly); since 0.1.458 the scanner offers and the owner issues: the button «Выдать в работу» (`backlog_issue`) sends the order into the project's PM chat | no | the button |
| `learning` (digest) | the day's report of what the extractor learned from his messages (`digest`, `src/rooms/learning/service.ts`, 18:20 hub time; since 0.1.458 a row here instead of a message to the PM) | no | — |
| `rule_proposal` | the night's rules scan wrote rule proposals the night policy does not let it put on trial (`rule_proposed`, `src/rooms/self-repair/server/rule-scan.ts`; since 0.1.458) | no | the project's Rules tab |
| `integration-gate` (post-merge) | after a merge, a check red because of the machine (`gate_machine`) or main red again after a mainfix task (`gate_red`), `src/rooms/writer/server/finish.ts` (since 0.1.458 rows, not PM messages) | no | fix the machine; dispatch the fix in the project's chat |
| anything posted | `postOwnerItem` or `bb lane-pilot waiting post '<json>'` (`items.ts:104-113`) | by the row's `wake` | the row's own `actions` |

**The janitor (since 0.1.458).** Every read of the list first closes the rows whose question went away (`sweepOwnerItems`, `src/rooms/owner-waiting/items.ts`): a writer's question once its task moved on (a newer attempt, or the blocked one left `blocked`); a red run goal once its run is closed (a later green verdict closes it in `run-goal.ts`); a task-word row when the word is given or the wait ends; a phase's word once its phase is closed or stopped (0.1.461); a backlog offer whose item is no longer issuable (`janitor:not issuable`); the Monday labels row once nothing is left to label; a row with no action after its term — a fact (`handed`, `acted`, `tick_*`, `labels`, `right_changed`, `schedule_failed`, `digest`, `outage`, `gate_machine`, `rule_proposed`, `backlog_ready`) after three days, anything else without buttons after seven. The three grills of 0.1.456 called the old screen «an inbox where rows are born and never die». Since 0.1.461 the badge (`ownerWaitingCounts`) runs the sweep before counting; every row without buttons carries «Прочитано» (RPC `owner_waiting_close`, closes the row as `screen`); and the same key posted again reopens a row the system closed (`janitor:*`, `run-goal:*`) with the new text, while a row the owner answered (`owner`, `screen`, `agent`) stays closed — his word stands, a system close is not an answer. An evidence chip copies its reference on click.

Beside the list the screen shows **what went red overnight** (attempt states of the last 24 hours with the attempt ids as evidence) and **what was accepted** (attempts, rules put on trial, rules confirmed) — `overnight` (`items.ts:117-133`).

## The item shape (the contract with the posters)

`OwnerItem` is the stable shape: `key` (stable, a repeat is the same waiting), `source`, `kind`, `projectId`, `what`, `why` it is the owner's, `since`, `wake`, `evidence[]` (`{kind: attempt|task|run|file|note|message|command|text, ref, label?}`) and `actions[]` (`{id, label, cli, rpc?, needsOwnerMessage?, hint?}`; with `rpc` the screen draws a button, without it the command is shown to copy). The night loop writes rows with `postOwnerItem` (or `bb lane-pilot waiting post '<json>'`) and closes them with `closeOwnerItem` (`waiting close <key> --by …`); the screen, the daily line and the Telegram digest pick them up with no further code (`items.ts:104-113`, `:115`). The text of built-in items is Russian (the owner's language); the screen chrome has EN and RU.

## The words (since 0.1.456)

The screen is read by a person who does not program (the owner, 2026-11-01: «ни слова не понял»). Every row answers four questions in plain
Russian, addressed as «вы» like the rest of the UI: what happened (`what`: one sentence, no ids, no English), why it is his (`why`), what to do
(buttons when the plugin has the RPC, else one plain instruction), and the technical part for a developer folded under «Подробности»: when it
appeared, the key, where to look (`evidence`, kinds said in words) and the commands. The ids of runs, ticks, branches, tasks and threads go into
`evidence`, never into `what`; `tests/owner-waiting/plain-words.test.ts` scans every `postOwnerItem` call for an id in the title. The sections
name every source in words (`SECTIONS` in `src/rooms/owner-waiting/ui/owner-waiting-board.tsx`), an attempt's state code is said in words
(`stateLabel`), and the lead's brief asks for proposals written for a person without a technical background
(`src/rooms/lead/server/tick.ts`). The gate's `why` keeps its technical analysis (the failing tests, the culprit) after a Russian title.

## Telegram

Lane Pilot has no Telegram sender of its own. The hub's script `scripts/lp-owner-push.sh` (a BB automation every 30 minutes, installed next to the daily report's `tg.env`) asks the RPC `owner_waiting_digest`, sends the text with the daily report's bot and then calls `owner_waiting_ack` with the keys. The rules are in code (`src/rooms/owner-waiting/push.ts`) and tested:

- only items with `wake` push; the rest wait on the screen and in the daily report;
- one waiting, one message: an acknowledged key never pushes again; a send that failed is not acknowledged, so the next run tries again;
- quiet hours, default 23:00-08:00 in Europe/Madrid: nothing is sent, nothing is lost, the items go out together in the first digest after;
- at most six items are named, the rest are counted.

Settings (rows `owner_push.enabled|quiet|timezone` of the global level, edited on the Self-improvement page, see `docs/self-improvement-settings.md`; the old table `lane_pilot_owner_config` is the fallback for a field with no row): `bb lane-pilot waiting config [enabled=on|off] [quiet=HH:MM-HH:MM] [timezone=Europe/Madrid]`, or the Telegram block at the foot of the screen. `quiet=00:00-00:00` means no quiet hours.

## Daily report

`scripts/lp-morning.sql:19` adds the line «От твоих сообщений — N» — open inbox rows plus learned items `pending_owner`. `composeMorningList` (`bb lane-pilot policy morning`) computes the same lines; `tests/policy/morning.test.ts` keeps the two equal. The script creates `lp_morning(since, now)`; a hub database without the new tables loses only this line.

## Data

Three tables, appended at the end of `migrations` (`src/rooms/owner-waiting/migrations.ts`): `lane_pilot_owner_item` (the inbox), `lane_pilot_owner_push` (keys already sent), `lane_pilot_owner_config`.

## RPC and commands

`owner_waiting` (the list), `owner_waiting_digest`, `owner_waiting_ack`, `owner_waiting_config`; `bb lane-pilot waiting [--json] | digest | ack <key>… | config … | post '<json>' | close <key> --by …`.

## Limits

- Evidence links are references (attempt id, note id, command); the screen does not open an attempt or a note on click.

## History: the pre-2026-10-22 design

Before the owner left the loop the screen also held `deferral_overdue` (an open deferral whose term passed, settled by a new term from the owner's own message), `deferral_term` (deferrals `needs_owner_term`), `memory_conflict` (held conflicts of `lane_pilot_memory_conflict`, settled with `--keep a|b|both|none`) and `rule_proposal` (proposals in state `proposed` with accept/reject buttons). None of these is a source any longer: deferrals without a term count as unproven in their project's phases, a held memory conflict is settled by the newer note, and rule proposals go on trial by themselves.
