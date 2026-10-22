---
title: Backlog to tasks by readiness
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, backlog, todos, pm]
sources:
  - src/rooms/backlog/logic.ts
  - src/rooms/backlog/server/scanner.ts
---

# Backlog to tasks by readiness (SMA D2-9)

The backlog is the project's `.agents/todos/items/<slug>/meta.yaml` (skill project-life). Two optional fields make an item issuable:

```yaml
estimate: 5          # points, 1..13; above 13 the item is split first
depends_on: [2026-10-20-other-item]
```

Every hour (`41 * * * *`) the scanner reads the todos of each project whose owner's PM chat was active in the last two weeks and sorts
the `ready` items: **issuable** (estimate at most 13, every dependency `done`), **to estimate** (no estimate), **to split** (above 13),
**blocked** (a dependency not done). The first issuable one, by priority then age, goes to that PM as one message with the item's paths;
one a project a day, three a day in all, each item once (`lane_pilot_backlog_issue`). The PM writes the contract; the item's status stays
the PM's. `bb lane-pilot backlog <project-id> | --scan`.
