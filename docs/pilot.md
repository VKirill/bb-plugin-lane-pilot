---
title: Pilot, then fan-out
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, pilot, dispatch]
sources:
  - src/rooms/pilot/logic.ts
  - src/rooms/writer/server/start.ts
---

# Pilot, then fan-out (SMA D2-2)

Sibling tasks of one run — the same `area` and the same `kind` — tend to fail the same way. With three of them or more, the first one
dispatched is the pilot: the others wait for its acceptance through the same wait as `depends_on`. A blocked pilot is waited for while the
PM sends it again (up to six hours); a canceled pilot holds no one. The writer stage of a waiting sibling says
`… (T0 is the pilot of its area: the siblings start once it is accepted)`.

The area rule already runs same-area tasks one after another in one writer thread; the pilot rule keeps the rest from starting after the
first one failed. The cross-check of a whole wave is the run-goal check (`docs/run-goal.md`): every accepted task's checks together on main.
