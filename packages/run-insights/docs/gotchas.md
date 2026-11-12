---
title: Run insights gotchas
type: gotchas
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: medium
tags: [run-insights, gotchas]
sources:
  - packages/run-insights/src/routing-stats.ts
  - packages/run-insights/src/lessons.ts
  - packages/run-insights/src/rule-proposals.ts
  - packages/run-insights/src/rule-trial.ts
  - packages/run-insights/src/rule-forms.ts
  - packages/run-insights/src/triage.ts
  - packages/run-insights/src/golden.ts
  - src/rooms/migrations.ts
  - packages/run-insights/src/rule-ladder.ts
  - packages/run-insights/src/rule-scope.ts
---

# Run insights gotchas

TL;DR: Package helpers read host schemas and often compute a candidate result for the caller to apply.

## Database and counting

- Functions assume migrations and core run tables exist; the host supplies the database ([database contract](packages/run-insights/src/routing-stats.ts:1-4), [migration composition](src/rooms/migrations.ts:3-8)).
- Routing counts selected writer-receipt rows, not distinct tasks; missing acceptance remains in denominator ([query](packages/run-insights/src/routing-stats.ts:39-49), [aggregation](packages/run-insights/src/routing-stats.ts:56-65)).
- Lesson limit applies before findings expand; malformed night-review JSON is skipped ([conversion](packages/run-insights/src/lessons.ts:16-27), [query](packages/run-insights/src/lessons.ts:29-39)).

## Calculated outcomes

- `decideRuleTrial` returns an action but does not persist it ([source](packages/run-insights/src/rule-trial.ts:145-156)).
- `ruleLadderStep` returns a move label but does not change tier or enforce a gate ([source](packages/run-insights/src/rule-ladder.ts:9-29)).
- `classifyUnformed` writes undecided results as `always` unless dry-run ([source](packages/run-insights/src/rule-forms.ts:166-174)).

## Parsing and scope

- New scope entries must be section IDs or paths; invalid legacy labels match nothing rather than becoming project-wide ([source](packages/run-insights/src/rule-scope.ts:29-56)).
- Golden line parsing skips malformed lines; empty evaluation reports rate 1, so inspect case count ([parser](packages/run-insights/src/golden.ts:14-24), [report](packages/run-insights/src/golden.ts:37-48)).
- Triage path ownership comes from a host callback; default `triageState` assigns parsed rejected paths to outside paths ([split](packages/run-insights/src/triage.ts:88-99), [default](packages/run-insights/src/triage.ts:115-117)).

See [rules](features/rules.md), [lessons](features/lessons.md), [triage](features/failure-triage.md), and [golden evaluation](features/golden-evaluation.md) for capability details.
