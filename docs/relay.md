---
title: Relay between threads
type: component
created: 2026-10-30
updated: 2026-10-30
status: active
confidence: medium
tags: [relay, threads, notice, reminders]
sources:
  - src/rooms/relay/server/services/relay.ts
  - src/rooms/relay/server/handlers/relay-deadlines.ts
  - src/rooms/workflow/server/services/pm-notice.ts
  - src/rooms/storage/database.ts
  - src/rooms/verification/server/services/integration-gate.ts
  - src/rooms/schedule/server/services/schedule-service.ts
  - src/rooms/backlog/server/services/scanner.ts
  - src/rooms/writer/server/services/finish.ts
  - src/rooms/platform/server/services/pm-notice.ts
---

# Relay between threads

TL;DR: the relay is Lane Pilot's thread-to-thread layer — asks, reminders, task-outcome notices to a PM — stored in plugin tables, rate-limited per pair, grouped and woken by event/deadline checks (`src/rooms/relay/server/services/relay.ts`, `src/rooms/relay/server/handlers/relay-deadlines.ts`).

## How it works

Three item kinds live in one relay list (`src/rooms/relay/server/services/relay.ts`):

- **Ask** — thread A asks thread B a blocking question (`ask`). B replies (`reply`); the asker's wait closes (`closeAnsweredWaits`).
- **Reminder** — a note fired by time, by a watched thread settling, or by a set of task ids reaching a state (kind `remind`).
- **Task notice** — outcomes grouped per PM (`taskNotices`): within the settle window and while the PM is idle a `lane_pilot_pm_notice` row goes out as a message; when the PM is busy or a send fails, deadline checks (`relay-deadlines.ts`) retry; outcomes older than `dropAfterMs` (24 h) or canceled-only are marked reported with no message.

Limits (`RELAY_LIMITS`): at most 6 asks per thread pair per hour, 20 open reminders per thread, 150 per thread per day; items are kept 7 days and the store is capped at ~200 KB.

A run with no PM chat to tell reports its end to the owner's list instead, one line with a push when it failed (`src/rooms/workflow/server/services/pm-notice.ts`), which is why a relay failure looks like an owner-waiting item.

**What a PM chat is never sent.** The plugin writes into a PM chat only what that PM's own run needs to go on: the results of its tasks, its writers' questions, permits, the owner's orders, and the report a schedule was for; a graph run's own end stays on its status card and in `lane_pilot_workflow_status`. Facts that need nothing from the PM go to the log, the run records and the owner's list instead: a red integration gate with no culprit (`src/rooms/verification/server/services/integration-gate.ts`), a merge recovered after a reload, a schedule's failed run (`src/rooms/schedule/server/services/schedule-service.ts`), the backlog scanner's hourly work order (`src/rooms/backlog/server/services/scanner.ts`), and post-merge machine/mainfix notes (`src/rooms/writer/server/services/finish.ts`). `sendPmNotice` (`src/rooms/platform/server/services/pm-notice.ts`) returns false when the send is refused, so a caller falls back to the list instead of counting a warm chat as delivery. A red integration gate traced to one merged task dispatches a repair task (`<task>-mainfix`) to the run's PM queue; the culprit's old writer thread gets no message.

## Tools and RPC

`lane_pilot_relay` (`ask` / `reply` / `list` — agents do not create reminders directly; reminders are set by the plugin server). `lane_pilot_pm_notice` is the notices table read before dispatch. `threadSettled` runs after each thread's turn ends via `LP_EVENTS`.

## Limits

- An ask that is never answered stays open until the 7-day keep window evicts it.
- A notice send is retried only while `maxWaitMs` (30 min) holds; after that the row is reported without a message.

<!-- lane-pilot:backlinks -->
## Referenced by

- [The task pipeline](flows/task-pipeline.md)
