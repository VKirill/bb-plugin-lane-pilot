---
title: Phases
type: component
created: 2026-10-30
updated: 2026-10-30
status: active
confidence: medium
tags: [phase, stages, goals, graphs]
sources:
  - src/rooms/phase/server/driver.ts
  - src/rooms/phase/server/auto-stages.ts
  - src/rooms/phase/server/candidate.ts
  - src/rooms/phase/server/rpc.ts
  - src/rooms/phase/server/cli.ts
---

# Phases

TL;DR: a phase is a heavy goal Lane Pilot runs as its own stage machine — intake, analyze, plan, waves of writer tasks, review, close — on the `lp.*` graphs, in its own candidate worktree, with owner-word turns where the goal needs them.

## How it works

- **Intake.** A phase starts from a goal (`src/rooms/phase/server/intake.ts`) and gets a record in `lane_pilot_phase` / `lane_pilot_phase_part`; the Phases view of the cockpit shows it.
- **Auto stages.** `autoDue` (`src/rooms/phase/server/auto-stages.ts:37`) decides the next machine stage — `analyze`, `plan`, `draw`, `review`, `close`, `lessons` — each mapping to a graph (`AUTO_WORKFLOWS`, `auto-stages.ts:22`: `lp.analyze`, `lp.plan`, `lp.draw`, `lp.review`, `lp.close`, `retrospective`). A stage gets `AUTO_TRIES` tries and `AUTO_LIFETIME_TRIES` over its life (`auto-stages.ts:24-26`); a replan is allowed `AUTO_REPLANS` times (`auto-stages.ts:21`, `:82`).
- **Candidate.** The phase builds in its own worktree `.git/lp-phases/<id>` on branch `phase/<id>` (`src/rooms/phase/server/candidate.ts:9-11`).
- **Owner words.** Where the machine needs a word from the owner it posts an item (`src/rooms/phase/server/driver.ts:378`, `:1032`) — see [Waiting for the owner](owner-waiting.md).
- **Machine failures.** A stage failure matching `MACHINE_STAGE_FAILURE` (`auto-stages.ts:19`) is the machine's fault, not the goal's; `recoverStopped` resumes a phase across a plugin reload (`auto-stages.ts:67`).

## Commands and RPC

`bb lane-pilot phase …` (`src/rooms/phase/server/cli.ts`) and the phase RPC (`src/rooms/phase/server/rpc.ts`) drive intake, turns and status.

## Limits

- Auto stages cover the machine path; a goal that needs judgement between stages relies on owner-word turns or a PM steering it.
