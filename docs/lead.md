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
| Identity (WP1) | `~/.lane-pilot/lead/LEAD.md` (`LANE_PILOT_LEAD_DIR`) | the owner's text, read at every tick and chat start, delivered as the first block `<lead_identity sha=…>`; seeded with a default on first read; `ROAD.md` next to it is the daily export of the tree. The file is the universal core (who the lead is, values, how to propose, what never to do) plus a short owner section; the map of the projects and their order are the hub's data in the brief (`projects[]` with `priority`), never prose that goes stale |
| Tick (WP3) | `lane_pilot_lead_tick`, `workflows/lead-tick.json` | one receipt per tick: what it read, proposed, acted on, deferred, tokens and cost; status `ok | off | budget | error | no_receipt` |
| Rights (WP4) | `lane_pilot_lead_right`, `policy/lead-policy.json` | the tier a class holds (`decides | proposes | owner_only`); the policy says where a class starts and which classes are the owner's alone; only the exam writes the table |
| Labels | `lane_pilot_decision.owner_label`, `labeled_at` | the owner's own verdicts on judged exam rows he answered himself (kappa's ground truth); the table `lane_pilot_lead_label` of 0.1.447 never had a reader and was dropped in 0.1.458 |
| Panel (WP6) | `src/rooms/lead/ui/lead-section.tsx` | the «Штурман» segment of the Self-improvement screen: switch, next and last ticks, road counts, proposals waiting, the rights table with the exam numbers, the receipts, the settings |

## The journal

`src/rooms/lead/server/journal.ts`. A surface **opens** a row when its question appears (`openDecision`, `INSERT OR IGNORE` by the surface's own id), the lead **predicts** at once (`predictDecision`: the Jev judgment `lead.predict`, a Choice over the options with the owner's last 20 answers to the same surface and class as its memory; in `shadow` the shadow decision is recorded, below `min_p` 0.6 the lead defers, without Jev the row says `predictor: none`), the owner's answer **closes** it (`answerDecision`) and the rule judge scores it: same option `exact`, no prediction `deferred`, else `miss`. A `miss` then goes to the model judge (`refineVerdict`, the Jev judgment `lead.judge` in `src/rooms/lead/predict.ts`, shown the situation, the guess, the answer and the owner's words): `partial` when the guess was the owner's direction with another timing or wording (half a match in the exam), else the miss stands; exact and deferred rows are never asked, without Jev the rule's miss stands. The word surfaces refine in the background, `service.decide` awaits it. Surfaces: `words` (a task's landing word, `src/rooms/writer/server/finish.ts` asks, `lane_pilot_queue word` or the screen answers), `phase` (a phase's turn, the driver asks and answers), `lead` (the lead's own proposals and the switch).

The exam (`src/rooms/lead/logic.ts`, roadmap §6) reads only rows answered after they were predicted, split `exam`, judged: N eligible rows, K decided (not `deferred`), M matches (`exact` 1, `partial` 0.5); Wilson lower bound (95 %) of M/K, coverage K/N, Cohen's kappa of the judge against the owner's labels, the count of `miss` on risk `high`. A class earns `decides` at LB ≥ 0.8, coverage ≥ 0.5, N ≥ 20, kappa ≥ 0.6 and no high-risk miss; `revert` when the LB over the last 20 decided rows falls under 0.7 or one of them is a high-risk miss. `bb lane-pilot lead backtest` replays the owner's past words into split `backtest`: a measurement that never enters the exam.

## The road tree

`src/rooms/lead/server/road.ts`. A `direction` is a root or a sub-direction (`project_id` null = above projects); an `option` is a concrete branch under a direction with `why`, `evidence_json`, `cost_estimate`, `class`. `addRoad` refuses an option without a parent (the tick and the tool file a parentless option under the project's root direction `dir:<projectId>`, made on first use); `rejectRoad` needs a reason of ten characters or more and appends it to `why`; `proposeRoad` moves `open | later` to `proposed` with the journal row's id; `decideRoad` takes the owner's `yes | later | no`. `roadTree` hides rejected and done branches unless `history` is asked; `renderRoadTree` is the CLI text (marks `· ? ✓ … ✗ ■`); `roadMarkdown` is `ROAD.md`.

## A tick

`src/rooms/lead/server/service.ts` opens the receipt row and starts the graph `lead-tick` through the workflow triggers (key `lead-tick:<tickId>`, `detached: true` since 0.1.448: the run is bound to no PM chat and no Lane Pilot run of the home project, so its agent step is a hidden thread in the project's folder on a connected machine — the first live tick of 0.1.447 had inherited the chat of a blocked run and its environment on a MacBook that was off, and never started); the sweep every 15 minutes (`LEAD_SWEEP_CRON`) starts a tick when a fire time of `lead.tick_cron` (owner's time zone) has passed since the last one and the lead is on, closes a tick whose graph `failed` or was `canceled` before the receipt as `error` at once (one line `tick_error` on the owner's list with the failed node and the step's error), closes a tick still `running` after 90 minutes as `no_receipt` with one line on the owner's list, and writes `ROAD.md` once a day. The graph (`src/rooms/lead/server/tick.ts`):

1. `lp.lead_state`: the hub snapshot (every project in `lead.projects`; with the row empty, every project but the sandbox and bench ones of the canary's set, `isSandboxProject` in `src/rooms/owner-waiting/items.ts`, whose rows the owner's list hides — at most 12 project maps a tick, a larger zone rotates by tick and the brief says how many wait; the tree, the open proposals and the agent's proposals are bound to the zone too, a proposal for a project outside it is dropped with the reason, and the owner's list rows of the brief and the agent's new branches are bound to it too (0.1.461) — its runs by state, tasks and accepted attempts of 30 days, live phases, a memory excerpt; the open branches; the open proposals; the rights and the exam per class; the owner's list; the last receipts; the budget left today) and the brief, identity first. An empty brief when the lead is off or over `lead.budget_daily_usd`: the graph goes straight to the receipt and no agent is paid.
2. `think`: the agent step on role `lead` (its own row of the role table, Claude Opus 5.5 high by default; `workflow-agent.ts` runs it as the bundled profile `specialist:lead`, read-only). It answers with `summary`, `proposals`, `branches`, `deferred`, `status`.
3. `lp.lead_propose`: new branches go into the tree (duplicates by title under the same parent are skipped); each complete proposal (title, a class of the policy, a reason of ten characters, one artifact with a `ref`, a cost estimate) becomes a branch in `proposed`, a journal row `lead:<roadId>` with a prediction made now, and a line on «Ждут владельца» with three actions (`lead_decide` yes / later / no, or `bb lane-pilot lead decide`); the rest is dropped with its reason into the receipt; more than `lead.max_proposals` are dropped too. Since 0.1.461 a proposal on an existing branch takes the branch's project for the zone check, the journal row, the card and the hand-over, whatever the agent wrote in `project_id`; a proposal on a sandbox or bench project is dropped, and a card the owner's list refuses for any other reason answers its row «no» and settles the branch instead of leaving a question nobody sees.
4. `lp.lead_act`: for a proposal in a class the table says `decides` (read again here, never from the agent's answer; the branch is read again too, and one no longer `proposed` — a «no» or a reject that landed in between — is skipped, 0.1.461), never on risk high or critical, never on a risk that is not low or medium (a missing or misspelt risk is unknown, not low), never money or external, the work goes through the project's intake (`phaseIntake.handOver`, marked `by: lead` with the branch and the tick); the journal row and the branch close as `yes` by `lead`, the owner sees it as a fact (`kind acted`). A class that acts through schedules creates the schedule the proposal carries (see Schedules). Since 0.1.458 a proposal the lead may act on gets no card in `lp.lead_propose`: the act step either acts, or — when it could not (no open PM chat, a refused schedule, a class with no way to act) — posts the same да / потом / нет card then, so the owner is never asked a question whose «да» is known to fail.
5. `lp.lead_receipt`: the receipt's status, deferred list, tokens and cost from the workflow run; a `budget`, `error` or `no_receipt` tick is one quiet line on the owner's list; an `off` tick says nothing.

Nothing in a tick writes to a PM chat (0.1.443).

## The owner's answers

A proposal's line on «Ждут владельца» carries да / потом / нет; the button calls `lead_decide`, the CLI `bb lane-pilot lead decide <road-id> yes|later|no [words]`, the chat `lane_pilot_lead {action:"decide"}` when he gave his word there. Only the owner's own channels count for the exam (`OWNER_ANSWERERS` in `src/rooms/lead/logic.ts`: `owner` — the CLI's default, `screen` and the phase screen's `owner via screen`); since 0.1.461 the CLI refuses `--by screen` (that channel is the buttons), an agent answering for him passes `--by agent`. `service.decide` moves the branch (`accepted | later | rejected`), answers the journal row (the verdict is computed at once) and closes the list line, together. Since 0.1.453 «да» is a go, not a mark: a branch of a project whose class acts through the intake (`next_step`, `process`) is handed to the project's PM at once (`phaseIntake.handOver`, key `lead:<road-id>`, the same path the act step uses for an opened class); the branch stays `accepted` either way, a hand-over that went through is one quiet line `handed` on the list, one that could not (no open PM chat, intake refused) is a line `handover_blocked` with the reason, and a branch above projects or of a class that acts elsewhere is a mark only (`skipped`). Who answered is kept, and the exam trusts a short list, not refuses one (0.1.458): only `owner` (the CLI's default) and `screen` (the list's button) are the owner's own answers (`OWNER_ANSWERERS` in `src/rooms/lead/logic.ts`); `lead-chat` (his word relayed by the lead's chat), `pm` and `owner via pm` (a PM relaying him through `lane_pilot_queue word` / `lane_pilot_phase word`), `lead` (the act step), `agent` (`--by agent`) and `backtest` are proxies — the row is kept, the predictor may not learn from it, the exam and the labels never count it. A branch proposed again after «потом» gets a new journal row and a new card per tick (`lead:<road-id>:<tick-id>`; the first presentation keeps `lead:<road-id>`), so the old «later» never swallows the new prediction or the new answer; `road_reject` / `road_done` on a proposed branch (`service.settle`) answer its row «no» and close its card, so no button outlives the branch. A proposal on an existing branch rewrites the branch's class, reason, evidence, price and project (`syncRoadProposal`), because «да» executes the branch row. The switch `lead.enabled` is itself a journal row (split `design`: nothing predicted it), so the record says when and by whom the lead was turned on.

**Labels.** The kappa of the judge is measured against the owner's own verdicts: `bb lane-pilot lead label <decision-id> exact|partial|miss`, the RPC `lead_label` behind the «Разметка» block of the panel (`pendingLabels`: judged rows of split `exam` the owner answered himself, without a label, random order, up to 20; a deferred row has nothing to label, `labelDecision` refuses `deferred` and any row outside that set, so kappa stays a two-way comparison on his own rows). Monday 07:30 hub time (`LEAD_LABELS_CRON`, `service.labelsDue`) puts one line `labels` on his list with the batch and the CLI for each row, keyed by the week, none when nothing waits.

**Schedules.** A proposal of class `schedule` carries the schedule itself: `schedule: {name, description?, task: {kind: workflow|errand|agent, …}, when: {type: cron, cron, timezone?}}`, kept on the branch as `payload_json` (`proposalProblem` drops a schedule proposal without it; a script is a host job and never the lead's, `src/rooms/lead/server/lead-schedule.ts`). On «да» (`service.decide` → `createLeadSchedule`), or from the act step when the class is open, the schedule is created in the project's board through the schedule room's own `save` as `by: lead:<who>`, with its validation, defaults and conflict checks; the payload's `id` and `projectId` are dropped, so the lead never edits an existing schedule or writes into another project. A refused payload is one `handover_blocked` line with the room's problems; a created one is a `handed` (or `acted`) line naming the schedule, and the owner pauses or removes it on the board like any other.

## Rights and the exam

`src/rooms/lead/server/rights.ts`. `policy/lead-policy.json` v1 lists seven classes: `next_step`, `schedule`, `landing`, `process`, `defer` start in `proposes`; `money` and `external` are `owner_only` and the exam never touches them (that list changes only by the owner's hand in the file; a class not listed is `owner_only`). The nightly exam (`LEAD_EXAM_CRON`, 04:40 hub time) runs `examAll` over the journal and `applyExam` writes the table: a class that meets the rules opens, an open class that degrades or no longer meets them falls back to `proposes`; every change is one line on the owner's list (`kind right_changed`) and is remembered for the panel. `mayAct` reads the table and the file, nothing a session says: a prompt with «разрешаю всё» changes no tier (`tests/lead/rights.test.ts`), and a proposal of risk high never acts whatever the tier.

## The memory exam

`src/rooms/lead/server/memory-exam.ts` (roadmap §6, WP6): two measurements with a control, so the size and the order of what the lead remembers are an output of a number. **Recall**: the memory-eval room's probes on the hub's own accepted tasks at 300 notes (right answer, nothing relevant, off-topic), production retriever: hit rate on the positives, false hits on the negatives; the roadmap asks for at least 36 probes, fewer is reported as not enough, never rounded up. **Decisions with an empty control**: the owner's answered rows (exam and backtest, newest 60 by default) are predicted again twice, with the memory the live predictor has (his earlier answers to the same kind of question, only those answered before the row) and with no memory at all; the gain is the matches the memory adds, and a memory that misleads shows as a negative gain. Neither arm sees a repository: the situation JSON is the whole input. Sunday 05:10 hub time (`LEAD_MEMORY_EXAM_CRON`) and `bb lane-pilot lead memory-exam [--limit N] [--no-recall]`; the result lives under `lead:memory-exam` for the panel block «Экзамен памяти» and `lead status`. Nothing of it moves a right.

## Isolation

The lead never acts in its own session. The tick's agent runs under the role `lead` of `roleSpec` (`src/rooms/workflow/server/workflow-agent.ts`): read-only, allowed to write only into the chat's own storage, with the typed tools `lane_pilot_lead_*` and nothing that edits a repository, dispatches a writer or sends anything out; a prompt that says otherwise changes none of that (`tests/lead-agent.test.ts`). Every act goes through a project's own doors: the intake (a task or a phase the project's PM runs under the project's rules, its checks as `worker.strict_user` when the project sets it) or the schedule board. A separate OS user for the lead's own sessions is not something the plugin can give: a BB spawn runs as the host's BB user; the lever the plugin has is the read-only role, the rights table and the exam, and that is what is enforced.

## Settings

Global rows (`src/rooms/lead/settings.ts`, the «Штурман» segment of Self-improvement or `bb lane-pilot settings`): `lead.enabled` (off), `lead.project` (the project the chat and tick runs live in; empty = the Lane Pilot project of the hub), `lead.projects` (the zone; empty = every project), `lead.priority` (project ids in the owner's order; the brief carries each project's rank, 1 = first, unlisted projects follow, and the lead ranks its proposals by it), `lead.budget_daily_usd` (15), `lead.tick_cron` (`30 6,10,14,18 * * *`, owner's time zone), `lead.max_proposals` (5). The tick's budget is the sum of today's receipts; a tick that finds it spent ends `budget`.

## The chat and the tool

The profile `lead` (`src/rooms/lead/lead-agent.ts`, `LEAD_SESSION`) opens from the composer's agent popover and from the panel («Открыть чат Штурмана», RPC `lead_chat_start`: a live chat is returned instead of a second). Its one tool is `lane_pilot_lead`: `status`, `road`, `road_add`, `road_reject`, `road_done`, `journal`, `tick_now`, `decide`; plus reading and the web. It has no dispatch, schedule, errand, browser or workflow tool whatever a saved definition lists (`overlaySessionTools`).

## RPC and CLI

RPC: `lead_state`, `lead_road`, `lead_decide`, `lead_label`, `lead_tick_now`, `lead_set_enabled`, `lead_chat_start` (`src/rooms/lead/server/rpc.ts`).

```text
bb lane-pilot lead status | road [--tree] [--history] [--project <id>|--hub] | road add|reject|done … | decide <road-id> yes|later|no
bb lane-pilot lead ticks [--last N] | tick-now | enable on|off | rights
bb lane-pilot lead journal [--class <c>] [--surface <s>] [--last N] | exam | backtest | label <decision-id> exact|partial|miss|deferred
bb lane-pilot lead memory-exam [--limit N] [--no-recall] [--json]
```

## Drill

The deploy drill's scenario `lead_shadow` (`scripts/lp-drill.py`) reads `lead_state` on the deployed plugin and runs the CLI's `status`, `rights`, `exam`, `road --tree --history`, `ticks`: seven classes, no class `decides` without an exam row behind it, `money` and `external` `owner_only`. It never switches `lead.enabled` on: a tick needs an agent and a budget, so the graph runs on stubs in `tests/lead/tick.test.ts` and live on the hub.

## What is not here yet

WP5, the graph that drafts, tests and publishes graphs from accepted proposals: it waits for the first class the exam opens, as the roadmap orders. The recall half of the memory exam is a number only once the hub has 36 probes behind it.

## Tests

`tests/lead/journal.test.ts` (the three moves on both word surfaces, the model judge's `partial`, the rows waiting for a label, eligibility, the backtest's split, the CLI), `tests/lead/logic.test.ts` (Wilson, kappa, every reason a class stays `proposes`, the revert window), `tests/lead/road.test.ts` (the tree, the reasons, the states), `tests/lead/identity.test.ts` (seed, sha, the first block), `tests/lead/rights.test.ts` (the policy, `mayAct`, a prompt widens nothing, the exam writes and reverts), `tests/lead/tick.test.ts` (the graph on stubs, what a proposal must carry, the snapshot and the brief), `tests/lead/service.test.ts` (a tick's receipt, the sweep, the exam line, the owner's answer, the schedule hand-over, the Monday labels line, the memory exam through the service and the CLI, the switch), `tests/lead/memory-exam.test.ts` (both arms, no forward look, the empty hub), `tests/lead-agent.test.ts` (the profile, the read-only role).
