---
title: Self-evolution graph design record (lp.evolve)
type: decisions
created: 2026-11-25
updated: 2026-11-25
status: accepted
confidence: high
tags: [decisions, evolve, workflow-engine, statistics, distillation, otel]
sources:
  - .ai-factory/plans/pilot-prune-event-graphs.md
  - .bb/chats/thr_ds3i5seh7r/artifacts/2026-11-24-evolution-research.md
  - .bb/chats/thr_ds3i5seh7r/notes/research-durable-eval-distill.md
  - packages/contracts/src/run-facts.ts
  - packages/contracts/src/graph-categories.ts
  - packages/workflow-engine/src/run-stats.ts
  - packages/workflow-engine/src/node-form.ts
  - packages/workflow-engine/src/validate-form.ts
  - packages/workflow-engine/src/schema.ts
  - packages/models/src/model-prices.ts
  - packages/models/src/role-models.ts
  - src/rooms/evolve/index.ts
  - src/rooms/evolve/models/compare.ts
  - src/rooms/evolve/models/trial.ts
  - src/rooms/checkers/score.ts
  - src/rooms/checkers/mutators.ts
  - src/rooms/checkers/drill.ts
  - src/rooms/lead/server/nearest.ts
  - src/rooms/workflow/server/workflow-tools.ts
  - src/rooms/workflow/server/workflow-node-model.ts
  - workflows/invoice-send.json
  - workflows/telegram-send.json
---

# Self-evolution graph design record (`lp.evolve`)

Accepted by the owner on 2026-11-26 as written, including automatic promotion above the 20 + 10 case threshold (implementation plan: .ai-factory/plans/goal-driven-agent-graphs/index.md).

TL;DR: Self-evolution becomes one event-driven workflow graph `lp.evolve` with no nightly cron. It reads only structured per-step run facts from `lane_pilot_wf_step`, proposes at most one node-level change (model, execution form, or check) or one deduplicated draft graph at a time, evaluates candidates outside the loop on frozen held-out real cases using deterministic checks + dual-order pairwise judging + paired bootstrap statistics, and promotes only when non-inferior in quality and better in cost per accepted task or latency. Building `lp.evolve` is a separate plan after the owner approves this record.

## Context

Prior self-improvement loops in Lane Pilot failed along twelve structural lines (documented in `.bb/chats/thr_ds3i5seh7r/artifacts/2026-11-24-evolution-research.md` §2): re-reading the same chat threads three or more times, scanning 14-day windows without a consumption cursor, inflating single-chat clusters, creating duplicate graphs from free-text `workflowId` guesses without checking pending drafts or built-ins, ignoring node-level `model`/`provider` fields, leaving `service_model.classify` disconnected, bypassing critic/audit gates, testing drafts against author-written stubs, starving on episode enrichment errors, and running two uncoordinated evolvers (`lead` and nightly graph evolution).

Tasks 12, 23, 24, 26, 29, 30, and 44 of `.ai-factory/plans/pilot-prune-event-graphs.md` removed the broken experiments and put the required building blocks in place:

- **Per-node models and automatic role fallback** (Task 24): node `provider`, `model`, `reasoning`, and `service_tier` override the role table (`src/rooms/workflow/server/workflow-node-model.ts`); judges may not share provider and model with the judged writer (`validateNodeModels`).
- **Per-step run facts and node census** (Task 26): `lane_pilot_wf_step` records `STEP_FACT_FIELDS` (`packages/contracts/src/run-facts.ts`) and `nodeCensus()` (`packages/workflow-engine/src/run-stats.ts`) classifies nodes as `code | stable_agent | open_agent` with `costShare`.
- **Node execution forms with fallback** (Task 29): `form: "agent" | "plan" | "script"` with `fallback: "plan" | "agent"`, mechanical `verify`, and environment `fingerprint` (`packages/workflow-engine/src/node-form.ts`, `validate-form.ts`).
- **Hard engine budgets and stuck detection** (Task 30): `maxTokens`, `maxCostUsd`, `maxWallSeconds`, `maxRepeats` enforced outside the agent (`packages/workflow-engine/src/budgets.ts`).
- **Comparison and trial math** (Task 23): `src/rooms/evolve/models/compare.ts` (`compareArms`, `pairedBootstrapInterval`, `computeNoise`) and `src/rooms/evolve/models/trial.ts` (`decideTrial`, `armMetrics`).
- **Planted-defect checker gate** (`src/rooms/checkers/`): `buildScorecard`, `mutators.ts`, `runDrill`.
- **Categorized graph library and PM catalog** (Task 44): `workflows/*.json` loaded from disk, categorized via `GRAPH_CATEGORIES` (`packages/contracts/src/graph-categories.ts`), exposed to the PM with `description`, `not_for`, and `runFacts` via `buildPmCatalog()` (`src/rooms/workflow/server/workflow-tools.ts`).

This record specifies the target design of `lp.evolve` before any implementation plan is written.

## Decision

### 1. Architecture of `lp.evolve`

```
run finished (event) ────────▶ append run facts to graph ledger (once, from wf journal — no transcripts)
                                 └─ per step: model, tokens/cache, cost (or not_measured), time,
                                    verdict, failure_class, form_used, fallback_taken, graph_version

PM catalog miss ×N similar ──▶ match against all graphs + pending drafts (router + nearest units)
                                 └─ no match → propose ONE draft graph in category (or new category if N fit none)

owner-accepted real run ─────▶ accumulate into graph case set:
                                 ├─ frozen held-out set (≥ 30 %, never shown to proposer, owner-rotated)
                                 └─ working set (for hypothesis discovery & calibration)

graph with reference cases ──▶ tune ONE node at a time (1–3 hypotheses/cycle, capped):
  ├─ model arm (Task 24): Opus → Sonnet → Haiku → other provider
  ├─ form arm  (Task 29): agent → plan (small model) → script (verify + fingerprint + LLM fallback)
  └─ check arm: promote accepted lesson to verify / gate / contract check
         │
         ▼
  offline paired replay (k ≥ 3 repeats + empty control, outside-loop evaluator)
         │  pass non-inferiority + cost/time gain + ≥90 % checker catch (for critic/verifier)
         ▼
  below 20 held-out + 10 working?
    ├─ YES → report to owner inbox (≤ 1 item per graph); owner approves promotion
    └─ NO  → canary share on real runs (trial.ts) → auto-promote on pass, auto-rollback on 1st reject/red check
```

#### Core boundaries

1. **Input is run facts only — never chat transcripts.** `lp.evolve` consumes only the structured rows written on `lane_pilot_wf_step` and `lane_pilot_wf_run` (`STEP_FACT_FIELDS`, `workflowRunFactSummaries()`, `nodeCensus()`), appended once per finished run. No thread transcripts are re-read.
2. **Editable surface is structure, never prose (R15).** `lp.evolve` may change only:
   - node model fields (`provider`, `model`, `reasoning`, `service_tier`),
   - node execution form (`form`, `fallback`, `plan`, `script` with `fingerprint` and `verify`),
   - deterministic checks / graph nodes / draft graphs in the workflow JSON.
   It **never** edits prompt prose, `CLAUDE.md`, skills, or rules text — self-written prose rots.
3. **Evaluator, verifier, budgets, case set, and owner gate sit outside the loop and are read-only to `lp.evolve`.** `lp.evolve` edits graphs exclusively through drafts and atomic writes with a rollback ledger; it cannot modify its own test set, judges, budgets (`maxTokens`, `maxCostUsd`, `maxWallSeconds`, `maxRepeats`), or promotion thresholds.
4. **Start small (Matvey, R12).** Initial rollout targets **one graph, one node, one metric** first (primary candidate: `workflows/invoice-send.json`, tuning one node's cost/time on real runs) before enabling `lp.evolve` across other graphs.
5. **Single hypothesis funnel (capped 1–3 changes per cycle).** Hypotheses from every source — including the surviving nearest-unit ladder (`attachNearest`, `formHypothesis` in `src/rooms/lead/server/nearest.ts` during `lead-tick`) — enter only as queued inputs to `lp.evolve`, never as direct owner cards or parallel self-modifiers. Active proposals per cycle are capped at 1–3 changes.
6. **One owner item per graph, not per night.** When owner input is needed (promotion below the R11 threshold, new-graph approval, or rollback notice), `lp.evolve` posts at most one deduplicated item per graph in `owner-waiting` (using the mandatory `reason` vocabulary).

---

### 2. Triggers (Event-Driven, No Nightly Cron)

`lp.evolve` has **no nightly or periodic cron trigger**. It wakes only on engine events stored in `lane_pilot_wf_inbox`:

| Trigger event | Action |
|---|---|
| **`run finished`** (for a published/tested graph) | Append step facts once (idempotent by `run_id`), update owner-accepted reference pool / working set counters, and track live canary outcomes (`decideTrial`) and script fallback rate (`fallback_taken`). |
| **Threshold crossed** | Triggered when: (a) N similar PM catalog misses accumulate in a category, (b) a graph's new working/held-out cases reach an evaluation batch threshold, or (c) a scripted node's rolling `fallback_taken` rate exceeds **20 %** (immediate demotion check). |
| **`model catalog changed`** | Emitted when available models/providers or `MODEL_PRICES` change (Task 24). Re-validates every evolved node (downgraded model or `plan` small-model adapter) against the graph's frozen reference set so stale harness assumptions (`.bb/chats/thr_ds3i5seh7r/notes/research-durable-eval-distill.md` §D.2.4) do not persist silently. |

---

### 3. Case Sets and Promotion Threshold (R11)

For each graph, real runs accepted by the owner accumulate into two disjoint sets:

- **Working set** (≤ 70 % of accepted cases): visible to hypothesis generation, form-arm script extraction, and judge calibration.
- **Frozen held-out set** (≥ 30 % of accepted cases): **never shown to the proposer**, used solely by the read-only evaluator, and rotated only by explicit owner action.

| Available cases on graph | Mode | Promotion behavior |
|---|---|---|
| `< 20` held-out **or** `< 10` working | **Report-only** | `lp.evolve` evaluates candidates offline and posts **one** owner inbox item with the paired scorecard (`compareArms`). Nothing promotes without the owner's explicit yes. |
| `≥ 20` held-out **and** `≥ 10` working | **Autonomous promotion + canary** | When all statistical, judge, and hard-check gates pass on held-out replay, the variant enters a canary share of real runs (`src/rooms/evolve/models/trial.ts`), then promotes automatically. **Automatic rollback** fires immediately on the first owner reject or any red hard check. |

---

### 4. Judging Hierarchy, Independence, and Calibration

Every candidate variant is evaluated through a strict three-tier hierarchy (`not_run` is never treated as `pass`):

1. **Tier 1 — Deterministic commands & exit codes (hard gate).** Tests, schema validation (`validateWorkflow`, `validateNodeForms`), contract/diff rules, `verify` expressions/commands, and mechanical receipt checks. Any failure fails the variant immediately; an LLM judge cannot override a red deterministic check.
2. **Tier 2 — Dual-order pairwise LLM judge against reference.** For outputs that cannot be settled by code alone, a pairwise judge compares candidate vs. the owner-accepted reference output on the same input in **both orders** (`(reference, candidate)` and `(candidate, reference)`). If the two orders disagree, the pair is recorded as a **tie** (position-bias mitigation).
3. **Tier 3 — Absolute rubric score (secondary signal only).** Used for diagnostics and continuous-metric sensitivity, never as a standalone pass/fail gate.

**Self-enhancement exclusion (R12 / Task 24).** The judge model must not belong to the same `ModelFamily` (`"claude" | "gpt" | "google" | "glm" | "other"` in `packages/models/src/role-models.ts`) as the model under test on that node.

**Judge calibration.** Before an LLM judge may gate any graph, it is calibrated once per graph against the owner's historical accept/reject labels (agreement rate + confidence interval). If the lower CI bound of judge–owner agreement is below **~70 %**, the LLM judge is advisory only and **may not gate promotion alone** (owner approval or Tier 1 deterministic checks remain required).

**Cheaper critic / verifier replacement gate.** A variant proposing a cheaper critic or verifier model/node must catch **≥ 90 % of planted false «done» defects** measured with `src/rooms/checkers/` (`buildScorecard`, deterministic `mutators.ts`, `runDrill`), with false-alarm rate within ceiling, before it can replace the current critic/verifier.

---

### 5. Experimental Design and Statistics

#### 5.1 One node at a time, repeats, and empty control

- **Single-node isolation:** A candidate variant mutates **exactly one node** (`provider`/`model`/`reasoning`/`service_tier`, or `form`/`plan`/`script`, or one check). Multi-node bundled changes are split into sequential hypotheses.
- **Stochastic repeats (`k ≥ 3`):** Each reference/held-out case is run at least `k = 3` times per arm for stochastic agent nodes, scoring both mean outcome and `pass^k` (probability all `k` repeats succeed) to expose flakiness that single-shot `pass@1` hides.
- **Empty (no-change) control:** Two identical runs of the baseline arm establish run-to-run variance via `computeNoise()` (`src/rooms/evolve/models/compare.ts`: `unstableTasks`, `flipShare`, `costRel`, `secondsRel`, `stagesSlack`) so natural variance is not misread as improvement or regression.
- **Paired replay + canary:** Offline comparison reuses `compareArms()` and `pairedBootstrapInterval()` on identical held-out inputs; live traffic alternation reuses `decideTrial()` (`src/rooms/evolve/models/trial.ts`).
- **Attributable step records:** Each evaluated step stores its judge verdict (including both-order swap outcome), repeat index, and `graph_version` so every comparison remains strictly paired and traceable.

#### 5.2 Acceptance rule and cost definition

A variant passes promotion evaluation only when **all three** hold:

1. **Non-inferiority on success:** Paired difference `(candidate − baseline)` has lower confidence bound within the non-inferiority margin (default **−10 percentage points**, i.e., `−0.10`, on the primary success metric) using a **paired exact test or paired percentile bootstrap interval** (`pairedBootstrapInterval`, never a small-sample normal/CLT approximation).
2. **No per-class regression:** No task class or previously passing stable case regresses (`no_regression` check in `compareArms()`, excluding baseline-calibrated unstable tasks, and checking per-class breakdown rather than masking drops inside an aggregate average).
3. **Measured gain in cost per accepted task or wall-clock time:** Either cost per accepted task decreases or median wall-clock duration decreases beyond noise.

**Cost per accepted task** is defined strictly as:

```
cost_per_accepted_task =
  (sum of measured spend across all attempts, retries, rework visits, validator rounds, and judge calls)
  / (number of owner- or verifier-accepted outcomes)
```

- Token pricing comes strictly from `MODEL_PRICES` (`packages/models/src/model-prices.ts`: `input`, `cacheRead`, `cacheWrite`, `output` priced separately — cache reads are never folded into uncached input tokens or ignored).
- Any run/step whose provider did not report usage stays `cost_state = "not_measured"` (never coerced to `0`, matching `workflowRunFactSummaries()` and `compareArms()`).

#### 5.3 Sample-size reference table and power limits

From `.bb/chats/thr_ds3i5seh7r/notes/research-durable-eval-distill.md` §B.2:

**Unpaired two-proportion benchmark** (normal approximation reference only; one-sided $\alpha = 0.05$, power $80\%$, $n$ per arm):

| Baseline $\rightarrow$ Candidate | $n$ per arm |
|---|---:|
| $0.90 \rightarrow 0.70$ (20-point drop) | 49 |
| $0.90 \rightarrow 0.80$ (10-point drop) | 157 |
| $0.80 \rightarrow 0.70$ (10-point drop) | 231 |
| $0.70 \rightarrow 0.60$ (10-point drop) | 281 |
| $0.95 \rightarrow 0.90$ (5-point drop) | 343 |
| $0.90 \rightarrow 0.85$ (5-point drop) | 540 |

**Paired design on identical inputs** (McNemar one-sided, $80\%$ power; depends only on discordant pairs where $p$ is the candidate-loss share of discordant pairs):

- $p = 0.80 \Rightarrow 18$ discordant pairs
- $p = 0.75 \Rightarrow 25$ discordant pairs
- $p = 0.70 \Rightarrow 39$ discordant pairs
- $p = 0.65 \Rightarrow 69$ discordant pairs

**Zero-failure exact binomial bound** ($0$ failures in $n$ runs $\Rightarrow 95\%$ upper bound on true failure rate):

- $n = 10 \Rightarrow 25.9\%$ · $n = 20 \Rightarrow 13.9\%$ · $n = 30 \Rightarrow 9.5\%$ · $n = 50 \Rightarrow 5.8\%$

**Practical power reading for Lane Pilot:** With 20–30 real held-out cases, paired evaluation can reject **large drops (~20 points)** or catastrophic regressions; it **cannot** certify "no regression" within a tight 5-point band. That is why paired replay on identical inputs plus continuous metrics (tokens, duration, rubric points) and a post-promotion canary with automatic rollback are mandatory.

#### 5.4 Anytime-valid sequential testing

When variants are monitored sequentially as live canary runs arrive rather than in a fixed-batch offline run, promotion/stop decisions must use an **anytime-valid sequential test** (e-processes / mSPRT / always-valid $p$-values) or fixed alpha-spending looks — never repeated peeking with a fixed-$n$ test.

---

### 6. Form Arm Rules (Agent $\rightarrow$ Plan $\rightarrow$ Script Distillation)

Task 29 defines the runtime form chain via `formChainOf()` (`packages/workflow-engine/src/node-form.ts`):

- `agent`: full agent execution (default).
- `plan`: saved plan template/steps (`planConfigSchema`) adapted by a smaller/cheaper model, falling back to `agent` on failure.
- `script`: parameterized deterministic command (`scriptConfigSchema` with `fingerprint`) verified by a mechanical `verify` check, falling back one level per failure (`script -> plan -> agent` or `script -> agent`), recording `form_used`, `fallback_taken`, and `environment_fingerprint` in `lane_pilot_wf_step`.

#### Promotion gate to `script`

`lp.evolve` may promote an `agent` (or `plan`) node to `script` **only when all five conditions hold**:

1. **Stable input shape:** Reference runs have consistent input structure (`nodeCensus()` reports `classification === "stable_agent"` with `inputShapes.size <= 1`, no model-invented branching).
2. **Mechanical output verifier:** The node declares a non-LLM `verify` check (`verifyObjectSchema` / expression / exit code), enforced by `validateNodeForms()`. No mechanical verifier $\Rightarrow$ no script promotion (silent failures are forbidden).
3. **Material share of run cost or time:** `nodeCensus()` shows a material `costShare` (or dominant latency share) — trivial zero-savings steps stay untouched.
4. **Idempotent or guarded side effects:** Because a mid-step script failure triggers fallback to `plan`/`agent`, side effects must be idempotent or guarded (e.g., check-before-write or `runEffect` intent-before-call).
5. **Environment fingerprint:** The saved script carries a non-empty `script.fingerprint` covering tool versions, host capabilities, and layout hashes (`validateNodeForms` rejects missing fingerprints); a fingerprint mismatch skips the script directly to its fallback and logs a warning.

#### Fallback health, demotion, and regeneration

- **LLM fallback is never removed.** Every `script` node keeps its fallback chain (`plan -> agent` or `agent`).
- **20 % fallback demotion threshold:** `lp.evolve` monitors the rolling `fallback_taken` rate per scripted node. If fallback rate exceeds **20 %**, the node is **demoted** back to `plan` or `agent` and the brittle script is archived as a negative result.
- **No silent self-healing:** If an agent fallback succeeds after a script breaks, it may suggest a script regeneration candidate, but regeneration **must pass through the full `lp.evolve` held-out evaluation gate** — never silently overwriting the live script.

---

### 7. Negative Results Archive and Learned Lessons

- **Negative results archive:** Every variant rejected offline, retired in canary (`decideTrial` $\rightarrow$ `"retire"`), or demoted for $> 20\%$ fallback is stored in an append-only negative archive keyed by `(graph_id, node_id, variant_signature, graph_version, reason)` so `lp.evolve` does not re-propose already disproven models or brittle scripts.
- **Lessons become checks or nodes, never text (R12, R15):** When a failure pattern is diagnosed and accepted, the artifact added to the graph is a concrete `verify` predicate, `gates` expression, schema constraint, or deterministic pre-check `action` node — never a prose paragraph injected into prompts or memory rules.

---

### 8. Observability and OTel GenAI Alignment

Step facts on `lane_pilot_wf_step` already align field names with OpenTelemetry GenAI semantic conventions via `OTEL_GENAI_ATTRIBUTES` in `packages/contracts/src/run-facts.ts`:

| `lane_pilot_wf_step` column | `OTEL_GENAI_ATTRIBUTES` key |
|---|---|
| `nodeKind` / operation | `gen_ai.operation.name` |
| `answered_provider` / `requested_provider` | `gen_ai.provider.name` |
| `requested_model` | `gen_ai.request.model` |
| `answered_model` | `gen_ai.response.model` |
| `step_id` / response id | `gen_ai.response.id` |
| `session_id` | `gen_ai.conversation.id` |
| `input_tokens` | `gen_ai.usage.input_tokens` |
| `output_tokens` | `gen_ai.usage.output_tokens` |
| `cache_read_tokens` | `gen_ai.usage.cache_read.input_tokens` |
| `cache_write_tokens` | `gen_ai.usage.cache_creation.input_tokens` |

SQLite (`lane_pilot_wf_step`) remains the single owner of step facts; any future OTel trace exporter will project these columns without introducing a second store.

---

### 9. Vendor Numbers Disclaimer

Published vendor and paper speed/cost numbers reviewed during research — such as Stagehand action caching, Skyvern code caching (vendor claim: 3–5× faster, up to 70 % cheaper), `browser-use/workflow-use` (vendor claim: 10× faster, ~90 % cheaper), Agentic Plan Caching (−50 % cost, −27 % latency on benchmarks), and generic model-split routing claims — were measured largely on browser-automation or synthetic datasets. They are **claims to test and measure on our own reference runs**, never baseline assumptions for Lane Pilot budgets or promotion math.

---

### 10. How the Graph Library Grows by Direction (R18)

Lane Pilot organizes its library (`workflows/*.json`) by business and engineering category in `packages/contracts/src/graph-categories.ts` (`GRAPH_CATEGORIES`, currently `seo`, `marketing`, `code`, `planning`, `qa`, `ops`, `docs`, `content`, `research`, `games`, `business`, `routines`, `service`, with dynamic categories supported via `workflowCategoryMetaSchema` when a bilingual `{ en, ru }` label is supplied).

1. **PM catalog miss is the primary signal:** When the PM inspects the categorized catalog returned by `routeTool()` / `buildPmCatalog()` (which exposes every offered graph's `description`, `not_for`, and `runFacts`), `routeIntent()` scores are only a **hint**. A **catalog miss** occurs only when the PM selects **no existing graph** and runs an ad-hoc errand or manual chain instead.
2. **Deduped draft creation inside a category:** After **N similar PM catalog misses** (e.g., clustered by intent/nearest-unit similarity in `src/rooms/lead/server/nearest.ts`), `lp.evolve` matches the cluster against **every** shipped graph, project graph, and pending draft (via `routeIntent` + semantic/stem nearest units — never by an LLM's free-text `workflowId` guess). Only if no graph or pending draft covers the request does it propose **one** draft graph in that category.
3. **New category threshold:** A new category (beyond the current `GRAPH_CATEGORIES`, e.g., splitting out a dedicated `billing` or `telegram` direction as volume grows) is proposed **only when N unmapped requests fit no existing category**.
4. **Bootstrap from owner-accepted runs:** The first live runs of a new draft graph run with owner confirmation (`liveTrial` / `human` approval gates). Owner-accepted runs become the graph's initial reference cases (working set + frozen held-out split).
5. **Standard one-node tuning:** Once reference cases accumulate, the new graph enters the exact same `lp.evolve` one-node-at-a-time loop (model arm $\rightarrow$ plan/script form arm $\rightarrow$ check arm).

#### Worked Example 1: «Issue an invoice» (direction: `billing` / `business`, `workflows/invoice-send.json`)

1. **No graph yet:** The owner asks the PM to make an invoice in Kontur.Elba for an existing client and send the PDF to Telegram. The PM checks `buildPmCatalog()`, finds no matching graph (N similar ad-hoc `errand` runs accumulate across billing requests with Kontur.Elba + PDF + Telegram signals).
2. **Draft proposed & deduped:** `lp.evolve` checks all graphs and pending drafts, finds no duplicate, and proposes one draft graph in the billing/`business` category (`invoice-send`) with: `create` (agent, `kontur-elba` skill) $\rightarrow$ `check` (deterministic INN/amount/bank-digit check + lightweight semantic match) $\rightarrow$ `review` / `approve` (`human` owner gates before sending) $\rightarrow$ `send` (subworkflow `telegram-send`) $\rightarrow$ `topic` (optional report).
3. **First real runs & reference accumulation:** The owner runs the draft via `liveTrial` / human approval on real clients. Accepted runs (inputs `{ company, inn, amount, service, recipient }`, Elba PDF artifacts, check outcomes, Telegram receipts) populate the working set and frozen ≥ 30 % held-out set.
4. **One-node-at-a-time tuning (start-small candidate):**
   - *Model arm:* `nodeCensus()` shows `create` dominates run cost (`costShare`). `lp.evolve` tests downgrading `create` one step (e.g., Sonnet $\rightarrow$ Haiku or cheaper provider) over `k ≥ 3` repeats on held-out cases with a non-Claude pairwise judge. Below 20+10 cases it reports to the owner; above 20+10 it auto-promotes if success stays within the −10-point non-inferiority margin, zero per-class regressions occur, and cost per accepted invoice drops.
   - *Check / lesson arm:* If a failure class recurs (e.g., wrong payee INN or missing PDF text), it becomes a deterministic check in `check` (`invoice.check`), not prompt prose.
   - *Form arm:* `check` is already code (`type: "action"`). `create` drives a live browser UI in Elba (`kontur-elba`), so if its input shape and Elba DOM flow stabilize, a `plan` form (saved step template adapted by a small model) or guarded `script` with `verify` (valid PDF + matching amount/INN) and environment `fingerprint` can be trialed while keeping the `agent` fallback if Elba UI changes push fallback $> 20\%$.

#### Worked Example 2: «Send data to Telegram» (direction: `telegram` / `content`, `workflows/telegram-send.json`)

1. **No graph yet:** Multiple graphs and PM requests need to send a message or file to a Telegram chat from the owner's account with delivery confirmation. The PM finds no shared delivery fragment in the catalog; N similar requests accumulate (`routeIntent` / `nearestUnits` shows `GATE_WORDS` / `send` signals).
2. **Draft proposed & deduped:** `lp.evolve` proposes one reusable internal/shared graph (`telegram-send`, in `telegram` / `content`) with inputs `{ chat, text, file_path, send_at, report_chat, host }`, idempotency guard ("check last messages before sending"), and read-back confirmation (`sent | send_unconfirmed | send_failed`).
3. **Reference accumulation:** Owner-accepted sends (text-only, file + caption, `me` Saved Messages) accumulate into working + frozen held-out sets.
4. **One-node-at-a-time tuning to partly scripted graph:**
   - *Node census:* `nodeCensus()` flags the file-send agent node as `stable_agent` (`inputShapes.size <= 1`, bounded output `{ status, message_id, message_url }`, idempotent lookback check, high `costShare` relative to a CLI call).
   - *Form arm promotion (`agent` $\rightarrow$ `script`):* `lp.evolve` promotes the file-send path to a deterministic `action`/`script` node (`direct`, invoking `~/toolkit/telegram/tg` on `host` with a mechanical `verify` check on exit code + returned `message_id` and a host tool `fingerprint`), keeping the LLM `agent` node (`send`) as its fallback.
   - *Measured outcome on our runs:* `direct` executes in seconds with zero agent tokens when `tg` succeeds, while edge cases (e.g., text-only sends or client errors where `direct.status != 'sent'`) automatically fall back to `send`. If `fallback_taken` ever exceeds 20 %, `lp.evolve` demotes the scripted path and archives the broken script as a negative result.

## Consequences

- **Follow-up implementation plan required:** This record does **not** create the `lp.evolve` workflow file or new SQLite tables. Implementing `lp.evolve` (negative archive storage, held-out/working case index, `run finished` / `model catalog changed` triggers, dual-order pairwise judge step, anytime-valid sequential monitor, and draft-deduplication service) is scoped to the dedicated follow-up plan after owner approval of this record.
- **Zero nightly background churn:** Evolution runs only in response to real run events, thresholds, or catalog changes, preserving the Task 4 / Task 19 single-clock architecture.
- **Bounded risk on small sample sizes:** Requiring 20 held-out + 10 working cases before autonomous promotion, keeping an independent-family calibrated judge, and enforcing immediate rollback on the first owner reject or red hard check prevent silent quality drift on low-volume graphs.
