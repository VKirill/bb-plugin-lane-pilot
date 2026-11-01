---
title: The lead's decision journal
type: component
created: 2026-11-01
updated: 2026-11-01
status: active
confidence: medium
tags: [lead, owner, journal, exam, jev, roadmap]
sources:
  - src/rooms/lead/migrations.ts
  - src/rooms/lead/logic.ts
  - src/rooms/lead/predict.ts
  - src/rooms/lead/server/journal.ts
  - src/rooms/lead/server/surfaces.ts
  - src/rooms/lead/server/backtest.ts
  - src/rooms/lead/cli.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/phase/server/driver.ts
  - src/rooms/tasks/server/queue-tool.ts
  - src/rooms/core/server/rpc.ts
  - tests/lead/journal.test.ts
  - tests/lead/logic.test.ts
  - .agents/plans/2026-11-01-lead-agent-roadmap.md
---

> [!note] Status 2026-11-01
> WP2 of the lead roadmap: the journal records and predicts; nothing acts on a prediction and no class holds a right. The road tree (WP0), the identity (WP1), the shadow tick (WP3) and the rights (WP4) come after it.

# The lead's decision journal

TL;DR: every question the owner is asked on a surface is a row of `lane_pilot_decision` with the situation, the options, a prediction stamped before his answer, his answer and a verdict. The exam of roadmap §6 reads only rows predicted before they were answered. `bb lane-pilot lead journal | exam | backtest | label`.

## Purpose

The lead («чувачок», `.agents/plans/2026-11-01-lead-agent-roadmap.md`) may one day decide a class of decisions instead of the owner. The only honest way to earn that is to predict his answers before he gives them, on decisions it never saw, and to count. The journal is that count's source: a prediction after the fact proves nothing, so a row is eligible only when `predicted_at < answered_at`, and a replayed historical decision lives in its own split.

## What a row holds

`lane_pilot_decision` (`src/rooms/lead/migrations.ts`): `id` (the surface's own key, so a question opened twice is one row and the backtest can never overwrite a live decision), `surface` (`words`, `phase`; later `owner_item`, `ask_owner`, `permit`, `rule`, `lead`), `class` (`landing`, `process`; the roadmap's full list is `next_step | landing | process | schedule | defer | money | external`), `risk`, `situation_json`, `options_json`, `prediction_json` + `predicted_at` + `predictor`, `answer_json` + `answered_at` + `answered_by`, `judge_verdict` (`exact | partial | miss | deferred`) + `judge_model` + `judged_at`, `owner_label` + `labeled_at`, `policy_version`, `split` (`exam | design | backtest`), `created_at`.

## The three moves

1. **Open** (`openDecision`, `src/rooms/lead/server/journal.ts`): the surface writes the situation and the options the owner will see. `INSERT OR IGNORE` by id.
2. **Predict** (`predictDecision`): at once, once. The judgment `lead.predict` (`src/rooms/lead/predict.ts`) is a Choice over the options; its state carries the situation and the owner's last 20 answers to the same surface and class (the memory the guess is made from). The judgment starts in `shadow`: the verdict's shadow decision is what the journal records (`predictor` = `jev-shadow:lead.predict@1`); in `active` the decision itself (`jev:…`). Below `min_p` (0.6) the lead defers (`option: null`). Without Jev, with it off or on a failure, the row says `predictor: none` and the verdict will be `deferred`. A row already predicted or already answered is left alone.
3. **Answer** (`answerDecision`): the owner's option and words, who recorded them (`pm`, `screen`, `owner`, `backtest`), and the rule judge's verdict at once: the same option is `exact`, no prediction is `deferred`, anything else is `miss`. `partial` is reserved for the model judge that comes with the morning-list labels (WP6). The first answer stands.

`labelDecision` writes the owner's own verdict on an answered row; the judge's Cohen's kappa is measured against these labels.

## Surfaces in this release

| Surface | Class | Opens when | Answers when |
|---|---|---|---|
| `words` (a task's landing word) | `landing` | the attempt starts waiting for the owner's word in `src/rooms/writer/server/finish.ts` (`askTaskWord`) | `lane_pilot_queue {action:"word"}` (`src/rooms/tasks/server/queue-tool.ts`, by `pm`) or the `task_word` RPC of a screen (`src/rooms/core/server/rpc.ts`, by `screen`) |
| `phase` (a phase's turn) | `process` | the driver posts the turn on «Ждут владельца» in `poke()` and the lesson draft after the lessons (`src/rooms/phase/server/driver.ts`, `askPhaseWord`) | `word()` of the driver (`answerPhaseWord`), before the owner item closes |

The ids: `words:<runId>:<family>` and `phase:<phaseId>:<turn>[:<wave>]` (`src/rooms/lead/server/surfaces.ts`). Both surfaces offer `yes | no`. A surface never fails on its journal: every call swallows its own errors.

## The exam

`src/rooms/lead/logic.ts` (written by SWE-2 on a brief, roadmap §6): among eligible rows of a class (answered, predicted strictly before the answer, split `exam`, judged) N is their count, K the ones the lead decided (verdict not `deferred`), M the matches (`exact` 1, `partial` 0.5). Wilson lower bound (95%) of M/K, coverage K/N, Cohen's kappa of the judge against the owner's labels, the count of `miss` on risk `high`. A class *would* `decide` when LB ≥ 0.8, coverage ≥ 0.5, N ≥ 20, kappa ≥ 0.6 and no high-risk miss (`EXAM_RULES`); `revert` is true when the Wilson LB over the last 20 decided rows is below 0.7 or one of them is a high-risk miss. `bb lane-pilot lead exam` prints this per class and says «would decides / proposes»: the rights table and anything that reads it are WP4.

## The backtest

`bb lane-pilot lead backtest` (`src/rooms/lead/server/backtest.ts`) replays the owner's decisions made before the journal existed: his landing words (`lp.task.words`, the task found on the hub by run and family) and the words of every phase (`record.words`). Each becomes a row of split `backtest` with `created_at` and `answered_at` at the time of his word, predicted now, so `predicted_at ≥ answered_at` and the row is never eligible. The report counts per class how often the predictor agrees with him; it is a measurement, not an exam. Running it again adds only what is new; a live row with the same id is never touched. Words of a run the hub no longer has are listed under `skipped`.

## CLI

```text
bb lane-pilot lead journal [--class <c>] [--surface <s>] [--last N] [--json]
bb lane-pilot lead exam [--json]
bb lane-pilot lead backtest [--json]
bb lane-pilot lead label <decision-id> exact|partial|miss|deferred
```

## What is not here yet

The remaining five surfaces (the owner list's actions, `lane_pilot_ask_owner`, permits and forge drafts, rule proposals and learning items, the lead's own proposals); the model judge with `partial`; the weekly line of 20 random rows to label; a rights table and the policy file `policy/lead-policy.json`; the RPC and the panel. Each follows the roadmap's order.

## Tests

`tests/lead/journal.test.ts` (open → predict → answer → verdict on both surfaces, exam eligibility, the backtest's split and idempotence, the CLI) and `tests/lead/logic.test.ts` (Wilson, kappa, eligibility, every reason a class stays `proposes`, the revert window).
