---
title: Relay between threads
type: component
created: 2026-10-30
updated: 2026-10-30
status: active
confidence: medium
tags: [relay, threads, notice, reminders]
sources:
  - src/rooms/relay/server/relay.ts
  - src/rooms/workflow/server/pm-notice.ts
  - src/rooms/storage/database.ts
---

# Relay between threads

TL;DR: the relay is Lane Pilot's thread-to-thread layer — asks, reminders, task-outcome notices to a PM — stored in plugin tables, rate-limited per pair, grouped and retried by a sweep.

## How it works

Three item kinds live in one relay list (`src/rooms/relay/server/relay.ts:19-48`):

- **Ask** — thread A asks thread B a blocking question (`ask`, `relay.ts:206`). B replies (`reply`, `relay.ts:233`); the asker's wait closes (`closeAnsweredWaits`, `relay.ts:188`).
- **Reminder** — a note fired by time, by a watched thread settling, or by a set of task ids reaching a state (the reminder row kind `remind`, `relay.ts:24`; `fire`, `relay.ts:319`; `threadSettled`, `relay.ts:350`).
- **Task notice** — outcomes grouped per PM (`taskNotices`, `relay.ts:396`): within the settle window and while the PM is idle a `lane_pilot_pm_notice` row goes out as a message; when the PM is busy or a send fails, the sweep retries every 30 s; outcomes older than `dropAfterMs` (24 h) or canceled-only are marked reported with no message (`TASK_NOTICE`, `relay.ts:102`).

Limits: at most 6 asks per thread pair per hour, 20 open reminders per thread, 150 per thread per day; items are kept 7 days and the store is capped at ~200 KB (`RELAY_LIMITS`, `relay.ts:48`).

A run with no PM chat to tell reports its end to the owner's list instead, one line with a push when it failed (`src/rooms/workflow/server/pm-notice.ts:106-124`), which is why a relay failure looks like an owner-waiting item.

## Tools and RPC

`lane_pilot_relay` (`ask` / `reply` / `list` — there is no agent action that creates a reminder; reminders are set by the plugin server). `lane_pilot_pm_notice` is not a tool but the notices table the sweep reads. `threadSettled` is called by the run lifecycle after each thread's turn ends.

## Limits

- An ask that is never answered stays open until the 7-day keep window evicts it (`relay.ts:48`).
- A notice send is retried only while `maxWaitMs` (30 min) holds; after that the row is reported without a message (`relay.ts:102`, `:396-449`).
