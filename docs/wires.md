---
title: Declared wires
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, wires, plan-fact]
sources:
  - src/rooms/wires/logic.ts
  - src/rooms/writer/server/plan-fact.ts
---

# Declared wires (SMA D2-4)

A task contract may declare that a value has to travel a chain of identifiers:

```json
"wires": [{ "chain": ["ui.theme", "loadSettings", "ThemeProvider"], "why": "the saved theme reaches the page" }]
```

In the plan→fact stage one shell command (`wiresCommand`) runs in the writer's worktree: for every pair of neighbours it looks for a
source file that names both (`git grep --untracked`, tests, specs and fixtures excluded). The first pair that meets nowhere is where the
wire is broken; the stage fails with `plan_fact_wire_broken: …` whatever the writer's table says, and the acceptance card shows each wire
with ✓ or the break. The check needs no code index, so it works on every project; a search that cannot run is listed as not checked.
