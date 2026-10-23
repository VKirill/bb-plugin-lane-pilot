---
title: The work graph
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, ui, stages, models, cost]
sources:
  - src/rooms/work-graph/logic.ts
  - src/rooms/work-graph/server/report.ts
  - src/rooms/work-graph/ui
---

# The work graph (Matvey Maslov's «Работы / Этапы и модели» screens)

How each task went through the pipeline, read from what Lane Pilot already records: stage events (`lane_pilot_stage_event`), stage
receipts, attempts and each thread's token cursor. Nothing new is stored.

- **Task list** (Tasks → List): one square per stage that ran, in the pipeline's order. Green passed, red failed, amber pulsing
  running, grey skipped; a number on the square when the stage took more than one round. A stage that polls its helper writes
  «running» again on every poll: a round starts only when it was not running already.
- **A task's page** («How the work went»): returns, cost, agent time and models, then per stage its rounds and failed rounds and who
  ran it: role (writer, agent, reviewer, code), round, model, turns (BB counts the thread's requested turns), time, fresh tokens,
  cache read, cache write, output, cost and the thread to open.
- **Stages and models** (Tasks → Stages and models, 7/30/90 days, one project or all; drills and service projects are left out
  unless «Show drills» is on): per stage green, red, unknown, skipped, green share (without unknown and skipped), median rounds,
  cost and time; per model on each stage how often it ran and its green share, for a reviewer the share where it blocked. At most
  the newest 400 tasks are read (the read runs on the plugin server's event loop).

Cost is the list price of the model (`@lane-pilot/models` price table), also on a subscription. A provider that reports no usage
(Cursor, OpenCode often) is «not measured», never zero; a writer thread several attempts share carries its tokens on the last
attempt, the earlier ones are «partial». Code stages (checks, plan against fact, acceptance, run gate) run no model: their row has
time only, and the writer thread a check ran in is not counted twice.

RPC: `work_graph_task {runId, taskId}`, `work_graph_strips {keys}`, `work_graph_stats {projectId?, days?, excludeProjectIds?}`.
