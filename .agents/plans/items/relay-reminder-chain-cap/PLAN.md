Context: on 2026-10-14 a SelfyStudio PM chat (owner silent since 2026-10-08) was woken by a self-repair notice, then set a 2h time reminder, then on its firing a 6h time-only reminder «check any captured RUB top-up» — a self-feeding chain shown to the owner as a queue card «in 5h». Reminder stats since 10-10: time-only fallbacks of 240-360 min are common.

Steps:
1. [x] In src/rooms/relay/server/relay.ts add to RELAY_LIMITS: timeOnlyMaxMinutes:120, chainWindowMs:15*60_000, chainMax:2 (third link refused).
2. [x] In remind(): after the twin check, if the reminder is time-only (no taskIds, no watchThreadId): refuse inMinutes > timeOnlyMaxMinutes; find this thread's most recent reminder with firedBy === "time" and no taskIds/watch; if now - firedAt <= chainWindowMs then depth = (prev.chainDepth ?? 1) + 1 else 1; refuse when depth > chainMax; store chainDepth on the new item (optional field in RelayReminder).
3. [x] Update the remind instruction lines in relay.ts to state the 2-hour cap for time-only reminders and that a longer wait means telling the owner or a schedule.
4. [x] Write tests/relay-reminder-limits.test.ts using the same in-memory deps style as tests/relay-task-notices.test.ts (fake now(), load/save in memory) covering the acceptance cases.
5. [x] Run the verification commands.
