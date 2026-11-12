---
title: Rule proposals and trials
type: component
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: medium
tags: [run-insights, rules, proposals, trials]
sources:
  - packages/run-insights/src/rules.ts
  - packages/run-insights/src/rule-proposals.ts
  - packages/run-insights/src/rule-trial.ts
  - packages/run-insights/src/rule-scope.ts
  - packages/run-insights/src/rule-queries.ts
  - packages/run-insights/src/rule-relevance.ts
  - packages/run-insights/src/rule-ladder.ts
  - packages/run-insights/src/rule-schema.ts
  - packages/run-insights/src/index.ts
  - src/rooms/writer/server/writer-knowledge.ts
  - src/rooms/learning/pm-rules.ts
---

# Rule proposals and trials

TL;DR: Rule helpers store proposals, scope accepted rules, record use, and calculate system-adopted rule trial outcomes and maturity labels.

## Purpose

`rules.ts` composes schema, migrations, queries, scope, relevance, trial, and tier helpers ([exports](packages/run-insights/src/rules.ts:1-23), [package API](packages/run-insights/src/index.ts:15-73)). Host writer and PM services consume the functions ([writer](src/rooms/writer/server/writer-knowledge.ts:1), [PM](src/rooms/learning/pm-rules.ts:1)).

## How it works

1. Proposal upserts assign IDs. Lesson upserts reuse a rule at similarity 0.6 and refresh counts without changing wording or decision; the 30 newest pending lesson proposals are retained ([ID](packages/run-insights/src/rule-proposals.ts:7-20), [lesson upsert](packages/run-insights/src/rule-proposals.ts:93-128)).
2. Listing and revision operate on proposals; revision only changes proposed rows. Decisions compare the current state with caller-supplied `from` and report whether one row changed ([source](packages/run-insights/src/rule-proposals.ts:133-165)).
3. Accepted rules are joined to extant memory records, and may be filtered by section and owned paths ([source](packages/run-insights/src/rule-proposals.ts:167-175), [scope matcher](packages/run-insights/src/rule-scope.ts:29-41)).
4. Relevance questions describe task/rule applicability. Selection uses yes probability where present, otherwise answer confidence; unanswered rules remain included ([question builder](packages/run-insights/src/rule-relevance.ts:10-26), [selector](packages/run-insights/src/rule-relevance.ts:28-44)).
5. Events record actions and shown rules. Trial stats derive applied rules from attempt traces and recurrences from successful triage matches; PM shown events also count as applied and accepted ([event helpers](packages/run-insights/src/rule-trial.ts:6-28), [stats](packages/run-insights/src/rule-trial.ts:47-90)).
6. `decideRuleTrial` returns keep/confirm/revise/retire; the host applies its returned action ([source](packages/run-insights/src/rule-trial.ts:128-156)).

## Modes

| Dimension | Values and behavior |
|---|---|
| Proposal state | `proposed`, `accepted`, `rejected`, `revoked`; state update is compare-and-swap ([schema](packages/run-insights/src/rule-schema.ts:103-105), [decision](packages/run-insights/src/rule-proposals.ts:159-165)) |
| Author | `sweep`, `pm`, `owner`, `model` ([schema](packages/run-insights/src/rule-schema.ts:24-42), [type](packages/run-insights/src/rule-schema.ts:103-105)) |
| Audience | `writer`, `pm`, `both`; default is writer ([schema](packages/run-insights/src/rule-schema.ts:81-103)) |
| Scope | Section IDs, paths, empty means project-wide; legacy labels match nothing ([validation](packages/run-insights/src/rule-scope.ts:14-26), [matching](packages/run-insights/src/rule-scope.ts:29-56)) |
| Trial | Confirm after 5 applications, zero recurrence, and 0.8 acceptance; revise after 2 recurrence; retire after 2 revisions with recurrence or 60 days unused ([thresholds](packages/run-insights/src/rule-trial.ts:128-141), [decision](packages/run-insights/src/rule-trial.ts:145-156)) |
| Tier label | `note`, `warning`, `soft-deny`, `auto-fix`; labels a move but does not enforce it ([ladder](packages/run-insights/src/rule-ladder.ts:5-13), [move conditions](packages/run-insights/src/rule-ladder.ts:16-29)) |

## Business rules

- Trial actions apply to system-adopted rules; owner decisions do not enter the trial path ([source](packages/run-insights/src/rule-trial.ts:145-156)). The active cap is 12 including owner rules; unused timeout is 60 days ([constants](packages/run-insights/src/rule-trial.ts:128-141)).
- Tier rise requires 10 applied uses by default and no recurrences; `soft-deny` requires check/hook form; `auto-fix` requires a mechanism ([source](packages/run-insights/src/rule-ladder.ts:16-29)).
- New scopes must be section IDs or paths; empty scope applies project-wide ([source](packages/run-insights/src/rule-scope.ts:29-56)).

## Public API or commands

The package exports proposal operations, accepted-rule queries, scope/relevance functions, trial/event helpers, recurrence queries, and tier functions ([module exports](packages/run-insights/src/rules.ts:5-23), [root API](packages/run-insights/src/index.ts:15-73)). The root [package map](../../../docs/packages.md) describes system-wide package ownership.

## Gotchas

`decideRuleTrial` and `ruleLadderStep` calculate outcomes but do not persist them. Tier reads from the latest tier event and defaults to note. Accepted rules require a matching memory row ([trial](packages/run-insights/src/rule-trial.ts:145-156), [tier](packages/run-insights/src/rule-ladder.ts:9-14), [accepted query](packages/run-insights/src/rule-proposals.ts:167-175)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Run insights gotchas](../gotchas.md)
- [Run insights](../overview.md)
