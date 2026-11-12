---
title: Run insights
type: overview
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: medium
tags: [run-insights, package, learning, rules]
sources:
  - packages/run-insights/src/index.ts
  - packages/run-insights/src/rules.ts
  - packages/run-insights/src/lessons.ts
  - packages/run-insights/src/triage.ts
  - packages/run-insights/src/routing-stats.ts
  - packages/run-insights/package.json
  - src/rooms/migrations.ts
  - src/rooms/self-repair/server/insights.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/writer-knowledge.ts
  - packages/run-insights/src/lesson-signatures.ts
  - src/rooms/rule-forms/cli.ts
  - src/rooms/self-repair/server/rpc/insights.ts
  - packages/run-insights/src/rule-schema.ts
  - packages/run-insights/src/rule-forms.ts
---

# Run insights

TL;DR: `@lane-pilot/run-insights` reads run records and calculates routing and learning signals; it also owns migrations and queries for rules, triage, and mechanism promotions.

## Purpose

This is a library with a single package entry point and no server startup. Consumers import the root exports and pass a database object with `prepare` to database-backed functions ([entry point](packages/run-insights/src/index.ts:1-123), [database contract](packages/run-insights/src/routing-stats.ts:1-4), [package exports](packages/run-insights/package.json:7-19)). It depends on `@lane-pilot/memory-core` and declares `better-sqlite3` as a peer dependency ([package metadata](packages/run-insights/package.json:11-19)).

The host composes the package migration arrays into shared storage. Room services call its functions during writer dispatch, self-repair, learning, and rule management ([migration imports](src/rooms/migrations.ts:3-8), [writer dispatch](src/rooms/writer/server/dispatch.ts:38), [writer rules](src/rooms/writer/server/writer-knowledge.ts:1), [learning sweep](src/rooms/self-repair/server/insights.ts:1-7)).

## Capabilities

- [Routing statistics](features/routing-statistics.md): acceptance rates by provider, model, and risk.
- [Lessons](features/lessons.md): run findings to memory candidates and repeated-failure groups.
- [Rules](features/rules.md): proposals, scopes, audiences, trials, relevance, and maturity labels.
- [Failure triage](features/failure-triage.md): evidence preparation, classification questions, persistence, and grouping.
- [Rule forms and promotion](features/rule-forms.md): classifies rule text and stores mechanism records.
- [Golden evaluation](features/golden-evaluation.md): scores caller-provided retrieval against required IDs.

## Public API and configuration

The public API consists of functions, types, and migration arrays re-exported from `src/index.ts` ([exports](packages/run-insights/src/index.ts:1-123), [package export map](packages/run-insights/package.json:7-10)). Behavior is configured through function arguments. Examples: lesson-source limit defaults to 200, repeated grouping defaults to 3 occurrences across 2 task IDs, and writer recommendation minimum defaults to 5 tasks ([lesson limit](packages/run-insights/src/lessons.ts:29-39), [repeat defaults](packages/run-insights/src/lesson-signatures.ts:44-50), [recommendation default](packages/run-insights/src/routing-stats.ts:72-83)).

## Consumers and data

The plugin root is the consumer: migration composition, writer services, learning, self-repair, memory, and rule-form services import this package ([migration composition](src/rooms/migrations.ts:3-8), [writer knowledge](src/rooms/writer/server/writer-knowledge.ts:1), [rule-form CLI](src/rooms/rule-forms/cli.ts:1), [insights RPC](src/rooms/self-repair/server/rpc/insights.ts:3)). See the root [package map](../../../docs/packages.md) and [learning guide](../../../docs/learning.md) for system-wide ownership and flows.

This package defines tables for rule proposals/events, failure triage, and rule promotion ([rule migrations](packages/run-insights/src/rule-schema.ts:5-96), [triage migration](packages/run-insights/src/triage.ts:6-26), [promotion migration](packages/run-insights/src/rule-forms.ts:8-27)). See the [data model overview](data-model.md).
