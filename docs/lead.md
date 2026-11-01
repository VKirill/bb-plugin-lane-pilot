---
title: The lead («Штурман»)
type: component
created: 2026-11-01
updated: 2026-11-01
status: active
confidence: medium
tags: [lead, owner, journal, road, exam, rights, jev, roadmap]
sources:
  - src/rooms/lead/migrations.ts
  - src/rooms/lead/logic.ts
  - src/rooms/lead/predict.ts
  - src/rooms/lead/settings.ts
  - src/rooms/lead/lead-agent.ts
  - src/rooms/lead/server/journal.ts
  - src/rooms/lead/server/surfaces.ts
  - src/rooms/lead/server/backtest.ts
  - src/rooms/lead/server/road.ts
  - src/rooms/lead/server/identity.ts
  - src/rooms/lead/server/rights.ts
  - src/rooms/lead/server/tick.ts
  - src/rooms/lead/server/tick-store.ts
  - src/rooms/lead/server/service.ts
  - src/rooms/lead/server/tool.ts
  - src/rooms/lead/server/rpc.ts
  - src/rooms/lead/cli.ts
  - src/rooms/lead/ui/lead-section.tsx
  - policy/lead-policy.json
  - workflows/lead-tick.json
  - src/rooms/workflow/server/workflow-agent.ts
  - packages/models/src/role-models.ts
  - scripts/lp-drill.py
  - tests/lead/journal.test.ts
  - tests/lead/logic.test.ts
  - tests/lead/road.test.ts
  - tests/lead/identity.test.ts
  - tests/lead/rights.test.ts
  - tests/lead/tick.test.ts
  - tests/lead/service.test.ts
  - tests/lead-agent.test.ts
  - .agents/plans/2026-11-01-lead-agent-roadmap.md
---

> [!note] Status 2026-11-01
> WP2, WP0, WP1, WP3, WP4 and WP6 of the roadmap are in the code: the journal, the road tree, the identity file, the tick graph, the rights by class and the panel. The lead ships **off** (`lead.enabled`) and every class starts in `proposes`: until the owner switches the ticks on nothing runs by itself, and until the nightly exam opens a class nothing acts by itself. WP5 (a graph that writes graphs) and the OS-user isolation of acting sessions are not here yet.

# The lead («Штурман»)

TL;DR: one persona above every project of the owner. It keeps a road tree (where the projects go, which branches are open, what was rejected and why), runs a tick a few times a day that reads the hub and puts at most five proposals with evidence and a price on the owner's morning list, records every question to the owner in a journal with a prediction made before he answers, and earns the right to decide a class by itself only through a nightly exam over that journal. It never edits code, never dispatches writers and never writes to a PM chat.

## Purpose

The owner wants to stop being the loop (`.agents/plans/2026-11-01-lead-agent-roadmap.md`). The honest way for an agent to take a decision over is to predict his answers before he gives them, on decisions it never saw, and to count; so every piece here either feeds that count or is gated by it. The lead's name is the owner's (2026-11-01); the room, the CLI and the profile keep the id `lead`.

## The pieces

| Piece | Table / file | What it is |
|---|---|---|
| Decision journal (WP2) | `lane_pilot_decision` | one row per question the owner is asked on a surface: situation, options, prediction stamped before the answer, answer, judge's verdict, owner's label, split `exam | design | backtest` |
| Road tree (WP0) | `lane_pilot_lead_road` | directions and options with a reason and evidence; states `open | proposed | accepted | later | rejected | done`; a rejected branch keeps its reason |
| Identity (WP1) | `~/.lane-pilot/lead/LEAD.md` (`LANE_PILOT_LEAD_DIR`) | the owner's text, read at every tick and chat start, delivered as the first block `<lead_identity sha=…>`; seeded with a default on first read; `ROAD.md` next to it is the daily export of the tree |
| Tick (WP3) | `lane_pilot_lead_tick`, `workflows/lead-tick.json` | one receipt per tick: what it read, proposed, acted on, deferred, tokens and cost; status `ok | off | budget | error | no_receipt` |
| Rights (WP4) | `lane_pilot_lead_right`, `policy/lead-policy.json` | the tier a class holds (`decides | proposes | owner_only`); the policy says where a class starts and which classes are the owner's alone; only the exam writes the table |
| Labels | `lane_pilot_lead_label` | the owner's own verdicts on judged rows (kappa's ground truth) |
| Panel (WP6) | `src/rooms/lead/ui/lead-section.tsx` | the «Штурман» segment of the Self-improvement screen: switch, next and last ticks, road counts, proposals waiting, the rights table with the exam numbers, the receipts, the settings |

## The journal

`src/rooms/lead/server/journal.ts`. A surface **opens** a row when its question appears (`openDecision`, `INSERT OR IGNORE` by the surface's own id), the lead **predicts** at once (`predictDecision`: the Jev judgment `lead.predict`, a Choice over the options with the owner's last 20 answers to the same surface and class as its memory; in `shadow` the shadow decision is recorded, below `min_p` 0.6 the lead defers, without Jev the row says `predictor: none`), the owner's answer **closes** it (`answerDecision`) and the rule judge scores it: same option `exact`, no prediction `deferred`, else `miss`. `partial` waits for the model judge. Surfaces: `words` (a task's landing word, `src/rooms/writer/server/finish.ts` asks, `lane_pilot_queue word` or the screen answers), `phase` (a phase's turn, the driver asks and answers), `lead` (the lead's own proposals and the switch).

The exam (`src/rooms/lead/logic.ts`, roadmap §6) reads only rows answered after they were predicted, split `exam`, judged: N eligible rows, K decided (not `deferred`), M matches (`exact` 1, `partial` 0.5); Wilson lower bound (95 %) of M/K, coverage K/N, Cohen's kappa of the judge against the owner's labels, the count of `miss` on risk `high`. A class earns `decides` at LB ≥ 0.8, coverage ≥ 0.5, N ≥ 20, kappa ≥ 0.6 and no high-risk miss; `revert` when the LB over the last 20 decided rows falls under 0.7 or one of them is a high-risk miss. `bb lane-pilot lead backtest` replays the owner's past words into split `backtest`: a measurement that never enters the exam.

## The road tree

`src/rooms/lead/server/road.ts`. A `direction` is a root or a sub-direction (`project_id` null = above projects); an `option` is a concrete branch under a direction with `why`, `evidence_json`, `cost_estimate`, `class`. `addRoad` refuses an option without a parent (the tick and the tool file a parentless option under the project's root direction `dir:<projectId>`, made on first use); `rejectRoad` needs a reason of ten characters or more and appends it to `why`; `proposeRoad` moves `open | later` to `proposed` with the journal row's id; `decideRoad` takes the owner's `yes | later | no`. `roadTree` hides rejected and done branches unless `history` is asked; `renderRoadTree` is the CLI text (marks `· ? ✓ … ✗ ■`); `roadMarkdown` is `ROAD.md`.

## A tick

`src/rooms/lead/server/service.ts` opens the receipt row and starts the graph `lead-tick` through the workflow triggers (key `lead-tick:<tickId>`, `detached: true` since 0.1.448: the run is bound to no PM chat and no Lane Pilot run of the home project, so its agent step is a hidden thread in the project's folder on a connected machine — the first live tick of 0.1.447 had inherited the chat of a blocked run and its environment on a MacBook that was off, and never started); the sweep every 15 minutes (`LEAD_SWEEP_CRON`) starts a tick when a fire time of `lead.tick_cron` (owner's time zone) has passed since the last one and the lead is on, closes a tick whose graph `failed` or was `canceled` before the receipt as `error` at once (one line `tick_error` on the owner's list with the failed node and the step's error), closes a tick still `running` after 90 minutes as `no_receipt` with one line on the owner's list, and writes `ROAD.md` once a day. The graph (`src/rooms/lead/server/tick.ts`):

1. `lp.lead_state`: the hub snapshot (every project in `lead.projects`, its runs by state, tasks and accepted attempts of 30 days, live phases, a memory excerpt; the open branches; the open proposals; the rights and the exam per class; the owner's list; the last receipts; the budget left today) and the brief, identity first. An empty brief when the lead is off or over `lead.budget_daily_usd`: the graph goes straight to the receipt and no agent is paid.
2. `think`: the agent step on role `lead` (its own row of the role table, Claude Opus 5.5 high by default; `workflow-agent.ts` runs it as the bundled profile `specialist:lead`, read-only). It answers with `summary`, `proposals`, `branches`, `deferred`, `status`.
3. `lp.lead_propose`: new branches go into the tree (duplicates by title under the same parent are skipped); each complete proposal (title, a class of the policy, a reason of ten characters, one artifact with a `ref`, a cost estimate) becomes a branch in `proposed`, a journal row `lead:<roadId>` with a prediction made now, and a line on «Ждут владельца» with three actions (`lead_decide` yes / later / no, or `bb lane-pilot lead decide`); the rest is dropped with its reason into the receipt; more than `lead.max_proposals` are dropped too.
4. `lp.lead_act`: for a proposal in a class the table says `decides` (read again here, never from the agent's answer), never on risk high, never money or external, the work goes through the project's intake (`phaseIntake.handOver`, marked `by: lead` with the branch and the tick); the journal row and the branch close as `yes` by `lead`, the owner sees it as a fact (`kind acted`). Classes that act through schedules are not wired yet and stay proposals.
5. `lp.lead_receipt`: the receipt's status, deferred list, tokens and cost from the workflow run; a `budget`, `error` or `no_receipt` tick is one quiet line on the owner's list; an `off` tick says nothing.

Nothing in a tick writes to a PM chat (0.1.443).

## The owner's answers

A proposal's line on «Ждут владельца» carries да / потом / нет; the button calls `lead_decide`, the CLI `bb lane-pilot lead decide <road-id> yes|later|no [words]`, the chat `lane_pilot_lead {action:"decide"}` when he gave his word there. `service.decide` moves the branch (`accepted | later | rejected`), answers the journal row (the verdict is computed at once) and closes the list line, together. The switch `lead.enabled` is itself a journal row (split `design`: nothing predicted it), so the record says when and by whom the lead was turned on.

## Rights and the exam

`src/rooms/lead/server/rights.ts`. `policy/lead-policy.json` v1 lists seven classes: `next_step`, `schedule`, `landing`, `process`, `defer` start in `proposes`; `money` and `external` are `owner_only` and the exam never touches them (that list changes only by the owner's hand in the file; a class not listed is `owner_only`). The nightly exam (`LEAD_EXAM_CRON`, 04:40 hub time) runs `examAll` over the journal and `applyExam` writes the table: a class that meets the rules opens, an open class that degrades or no longer meets them falls back to `proposes`; every change is one line on the owner's list (`kind right_changed`) and is remembered for the panel. `mayAct` reads the table and the file, nothing a session says: a prompt with «разрешаю всё» changes no tier (`tests/lead/rights.test.ts`), and a proposal of risk high never acts whatever the tier.

## Settings

Global rows (`src/rooms/lead/settings.ts`, the «Штурман» segment of Self-improvement or `bb lane-pilot settings`): `lead.enabled` (off), `lead.project` (the project the chat and tick runs live in; empty = the Lane Pilot project of the hub), `lead.projects` (the zone; empty = every project), `lead.budget_daily_usd` (15), `lead.tick_cron` (`30 6,10,14,18 * * *`, owner's time zone), `lead.max_proposals` (5). The tick's budget is the sum of today's receipts; a tick that finds it spent ends `budget`.

## The chat and the tool

The profile `lead` (`src/rooms/lead/lead-agent.ts`, `LEAD_SESSION`) opens from the composer's agent popover and from the panel («Открыть чат Штурмана», RPC `lead_chat_start`: a live chat is returned instead of a second). Its one tool is `lane_pilot_lead`: `status`, `road`, `road_add`, `road_reject`, `road_done`, `journal`, `tick_now`, `decide`; plus reading and the web. It has no dispatch, schedule, errand, browser or workflow tool whatever a saved definition lists (`overlaySessionTools`).

## RPC and CLI

RPC: `lead_state`, `lead_road`, `lead_decide`, `lead_tick_now`, `lead_set_enabled`, `lead_chat_start` (`src/rooms/lead/server/rpc.ts`).

```text
bb lane-pilot lead status | road [--tree] [--history] [--project <id>|--hub] | road add|reject|done … | decide <road-id> yes|later|no
bb lane-pilot lead ticks [--last N] | tick-now | enable on|off | rights
bb lane-pilot lead journal [--class <c>] [--surface <s>] [--last N] | exam | backtest | label <decision-id> exact|partial|miss|deferred
```

## Drill

The deploy drill's scenario `lead_shadow` (`scripts/lp-drill.py`) reads `lead_state` on the deployed plugin and runs the CLI's `status`, `rights`, `exam`, `road --tree --history`, `ticks`: seven classes, no class `decides` without an exam row behind it, `money` and `external` `owner_only`. It never switches `lead.enabled` on: a tick needs an agent and a budget, so the graph runs on stubs in `tests/lead/tick.test.ts` and live on the hub.

## What is not here yet

The model judge with `partial` and the weekly line of 20 random rows to label; the memory exam with an external control (recall ≥ 36 probes); acting through schedules (`acts_via: schedule`); a separate OS user for the lead's acting sessions; WP5, the graph that drafts, tests and publishes graphs from accepted proposals. Each follows the roadmap's order.

## Tests

`tests/lead/journal.test.ts` (the three moves on both word surfaces, eligibility, the backtest's split, the CLI), `tests/lead/logic.test.ts` (Wilson, kappa, every reason a class stays `proposes`, the revert window), `tests/lead/road.test.ts` (the tree, the reasons, the states), `tests/lead/identity.test.ts` (seed, sha, the first block), `tests/lead/rights.test.ts` (the policy, `mayAct`, a prompt widens nothing, the exam writes and reverts), `tests/lead/tick.test.ts` (the graph on stubs, what a proposal must carry, the snapshot and the brief), `tests/lead/service.test.ts` (a tick's receipt, the sweep, the exam line, the owner's answer, the switch), `tests/lead-agent.test.ts` (the profile).
