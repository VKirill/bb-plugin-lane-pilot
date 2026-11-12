---
title: Rule forms and promotion
type: component
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: medium
tags: [run-insights, rules, forms, promotion]
sources:
  - packages/run-insights/src/rule-forms.ts
  - packages/run-insights/src/rule-schema.ts
  - packages/run-insights/src/index.ts
  - src/rooms/rule-forms/promotion-service.ts
  - src/rooms/rule-forms/cli.ts
---

# Rule forms and promotion

TL;DR: Helpers classify rule text into forms, preserve decision provenance, record mechanisms, and persist promotion candidates.

## Purpose

`classifyRuleForm` scores form signals. Database helpers list/classify rows, set form metadata, mark mechanisms, and read/update promotion rows ([classifier](packages/run-insights/src/rule-forms.ts:45-90), [database helpers](packages/run-insights/src/rule-forms.ts:94-214)). Host CLI and promotion services consume them ([CLI](src/rooms/rule-forms/cli.ts:1), [promotion service](src/rooms/rule-forms/promotion-service.ts:1-2)).

## How it works

1. Normalize whitespace and score signals across `check`, `hook`, `skill`, `memory`, and `always` ([source](packages/run-insights/src/rule-forms.ts:94-115)).
2. A non-always form needs score 3; if no form wins, return undecided `always` with low confidence ([threshold](packages/run-insights/src/rule-forms.ts:92-98), [decision](packages/run-insights/src/rule-forms.ts:111-134)).
3. `classifyUnformed` classifies rows with no form unless `all`; `dry` skips writes ([source](packages/run-insights/src/rule-forms.ts:146-175)).
4. `setRuleForm` applies provenance guards; owner/reflection may replace prior choices and lower-priority writers cannot replace them ([source](packages/run-insights/src/rule-forms.ts:153-158)).
5. `markMechanized` records enforcement. Promotion helpers insert once per project/rule, list rows, find a promotion using the task contract `id`, and set state plus an optional failure reason ([mechanism](packages/run-insights/src/rule-forms.ts:160-164), [promotion state](packages/run-insights/src/rule-forms.ts:201-209), [task lookup](packages/run-insights/src/rule-forms.ts:211-214)).

## Modes

| Value | Meaning |
|---|---|
| `always` | Text rule remains in the always-on brief; undecided fallback ([source](packages/run-insights/src/rule-forms.ts:117-124)) |
| `skill`, `memory` | Stored form labels selected by text signals ([signals](packages/run-insights/src/rule-forms.ts:75-87)) |
| `check` | May identify contract lint, static test, or ownership check ([signals](packages/run-insights/src/rule-forms.ts:54-70)) |
| `hook` | May identify tool guard ([signals](packages/run-insights/src/rule-forms.ts:71-74)) |
| Mechanism | `contract_lint`, `ownership_check`, `static_test`, `tool_guard` ([type](packages/run-insights/src/rule-forms.ts:29-30)) |
| Promotion state/tier | Caller-provided text; schema adds no vocabulary constraint ([migration](packages/run-insights/src/rule-forms.ts:16-26)) |

## Business rules

- `FORM_MIN_SCORE` is 3 and ties order check, hook, skill, memory, always ([source](packages/run-insights/src/rule-forms.ts:94-98)).
- Mechanism is selected from the strongest winning-form signal ([source](packages/run-insights/src/rule-forms.ts:103-110), [result](packages/run-insights/src/rule-forms.ts:125-133)).
- Existing promotion rows are ignored on insertion; mechanism/state/tier are not validated by this package ([source](packages/run-insights/src/rule-forms.ts:189-193), [schema](packages/run-insights/src/rule-forms.ts:16-26)).

## Public API or commands

Classifier, form persistence, promotion operations, and migration are exported at root ([exports](packages/run-insights/src/index.ts:10-13), [promotion exports](packages/run-insights/src/index.ts:116-123)). Host commands belong to the root workspace.

## Gotchas

Unless dry-run, an undecided rule is written with form `always`. `markMechanized` records caller text but does not verify an enforcing mechanism exists ([source](packages/run-insights/src/rule-forms.ts:160-174)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Run insights](../overview.md)
