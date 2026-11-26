---
title: Backlog to tasks by readiness
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, backlog, todos, pm]
sources:
  - src/rooms/backlog/models/backlog.ts
  - src/rooms/backlog/server/services/scanner.ts
  - src/rooms/backlog/server/handlers/backlog-cli.ts
  - src/rooms/backlog/server/handlers/backlog-scan.ts
  - src/rooms/schedule/server/services/system-schedules.ts
---

# Backlog to tasks by readiness (SMA D2-9)

The backlog is the project's `.agents/todos/items/<slug>/meta.yaml`. Two optional fields make an item issuable:

```yaml
estimate: 5          # points, 1..13; above 13 the item is split first
depends_on: [2026-10-20-other-item]
```

Every hour (`3 * * * *` via `lp.backlog-scan` on the project schedule board, `src/rooms/schedule/server/services/system-schedules.ts:56-67`, `src/rooms/backlog/server/handlers/backlog-scan.ts`) the scanner reads the todos of each project whose owner's PM chat was active in the last two weeks and sorts the `ready` items: **issuable** (estimate at most 13, every dependency `done`), **to estimate** (no estimate), **to split** (above 13), **blocked** (a dependency not done). The first issuable one, by priority then age, is offered via the owner's list / PM flow; up to one per project a day, three a day in all, each item once (`lane_pilot_backlog_issue`). CLI: `bb lane-pilot backlog <project-id> | --scan` (`src/rooms/backlog/server/handlers/backlog-cli.ts`).
