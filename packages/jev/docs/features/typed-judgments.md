---
title: Typed judgments
type: component
created: 2026-11-05
updated: 2026-11-08
status: active
confidence: medium
tags: [jev, judgments, registry]
sources:
  - packages/jev/src/registry.ts
  - packages/jev/src/types.ts
  - packages/jev/src/judgments/accept-composite.ts
  - packages/jev/src/judgments/citation-check.ts
  - packages/jev/src/judgments/employee-remark.ts
  - packages/jev/src/judgments/host-command.ts
  - packages/jev/src/judgments/invoice-check.ts
  - packages/jev/src/judgments/invoice-scan.ts
  - packages/jev/src/judgments/log-find.ts
  - packages/jev/src/judgments/memory-rerank.ts
  - packages/jev/src/judgments/output-guard.ts
  - packages/jev/src/judgments/render-match.ts
  - packages/jev/src/judgments/repair-group.ts
  - packages/jev/src/judgments/skill-pick.ts
  - packages/jev/src/judgments/skill-tree-pick.ts
  - packages/jev/src/judgments/step-trivial.ts
  - packages/jev/src/judgments/trace-checks.ts
  - packages/jev/src/judgments/ui-shots.ts
  - packages/jev/src/run.ts
  - packages/jev/package.json
  - packages/jev/src/client.ts
  - packages/jev/src/index.ts
  - src/rooms/tasks/plan-fact-judgment.ts
---

# Typed judgments

TL;DR: A judgment owns its input shaping, typed questions, thresholds, decision function, fallback and receipt description; importing its module registers it by ID.

## Purpose

`defineJudgment` validates a dotted lowercase ID, rejects a second distinct registration under the same ID, and stores the judgment in an in-memory registry (`packages/jev/src/registry.ts:47-52`). Question constructors support `choice`, `noul`, `score` and image `box` (`packages/jev/src/registry.ts:57-60`). The answer types define their response shapes (`packages/jev/src/types.ts:4-31`). Response parsing checks each answer against its question type (`packages/jev/src/client.ts:144-157`).

## How it works

1. The author defines an ID, optional owner screen title, version, default mode, timeout, state builder, questions, threshold specifications, `decide`, fallback and short description (`packages/jev/src/registry.ts:22-43`).
2. Importing the module registers the judgment; `getJudgment` and `listJudgments` expose registered entries (`packages/jev/src/registry.ts:47-55`).
3. The runner builds redacted state and questions and enforces the per-judgment question cap (`packages/jev/src/run.ts:102-107`).
4. It calls the judgment's `decide` function with resolved thresholds (`packages/jev/src/run.ts:139-142`).
5. A decision can return a domain result or `escalate` with a target string; failed or unclear cases use the deterministic fallback (`packages/jev/src/registry.ts:19-40`).

### Execution details of judgment implementations

#### Skill selection with `pickWriterSkills` and `keptByKind`

`pickWriterSkills` selects appropriate agent skills for a given task (`packages/jev/src/judgments/skill-pick.ts:239-259`):
1. Filters hints to catalog names via `hintedSkills`, capped at `SKILL_HINT_LIMIT` (8) (`packages/jev/src/judgments/skill-pick.ts:230-233`, `packages/jev/src/judgments/skill-pick.ts:240`).
2. If disabled (`!input.enabled`), immediately returns hints with 0 kept counts (`packages/jev/src/judgments/skill-pick.ts:242`).
3. Pre-filters skills by kind using `keptByKind` for domain relevance (`DOMAIN_KIND`) and craft relevance (`CRAFT_KIND`) (`packages/jev/src/judgments/skill-pick.ts:246-247`).
4. Builds state via `skillPickState` and requests domain and craft skills in parallel chunks of 8 (`packages/jev/src/judgments/skill-pick.ts:248-252`).
5. Selects top domain picks (`SKILL_PICK_TOP` = 5, threshold 0.7) and top craft picks (`SKILL_CRAFT_TOP` = 3, threshold 0.7), deduplicating craft picks against domain picks (`packages/jev/src/judgments/skill-pick.ts:253-254`).
6. Combines project folder skills, picks, and hints; failed chunks add nothing and increment `unanswered` (`packages/jev/src/judgments/skill-pick.ts:255-258`).

`keptByKind` pre-filters catalog entries by classification category (`packages/jev/src/judgments/skill-pick.ts:192-213`):
1. Checks cache for existing kind verdicts; unreadable cache reads catch errors and re-query the skill (`packages/jev/src/judgments/skill-pick.ts:195-201`).
2. Dispatches unknown entries in chunks of 8 to `answerChunks` (`packages/jev/src/judgments/skill-pick.ts:202`).
3. Stores returned probabilities in cache, ignoring cache set failures (`packages/jev/src/judgments/skill-pick.ts:204-209`).
4. Threshold constants are `SKILL_KIND_THRESHOLD` (0.4) for domain and `SKILL_CRAFT_KIND_THRESHOLD` (0.35) for craft (`packages/jev/src/judgments/skill-pick.ts:188-189`).
The filter keeps skills meeting the verdict threshold (`packages/jev/src/judgments/skill-pick.ts:210`).

#### Hierarchical skill navigation with `skillTreePickJudgment`

`skillTreePickJudgment` performs beam search down the skill taxonomy (`packages/jev/src/judgments/skill-tree-pick.ts:16-44`):
1. `stateBuilder` clips task (1,200 chars), path (200 chars), and up to 24 options (`packages/jev/src/judgments/skill-tree-pick.ts:21-26`).
2. `questions` formats a Choice question over candidate options plus `none` (`packages/jev/src/judgments/skill-tree-pick.ts:27-32`).
3. `decide`: ranks options by probability, filters out `none` and options below `pick_p` (default 0.3), taking at most `take_max` (default 3) options (`packages/jev/src/judgments/skill-tree-pick.ts:34-41`).
4. Modes and failure: default mode is `shadow`, with 8,000 ms timeout (`packages/jev/src/judgments/skill-tree-pick.ts:19-20`).
Fallback returns no picks (`packages/jev/src/judgments/skill-tree-pick.ts:42`).

#### Citation support check with `citationCheckJudgment`

`citationCheckJudgment` validates source citations against document excerpts (`packages/jev/src/judgments/citation-check.ts:15-57`):
1. `stateBuilder` clips claim (800 chars), quote (600 chars), source metadata (500 chars), excerpt (12,000 chars), and question (300 chars) (`packages/jev/src/judgments/citation-check.ts:20-26`).
2. `questions` asks Choice `supports` (`supports`, `partial`, `unsupported`, `absent`) and Noul `hallucinated` (`packages/jev/src/judgments/citation-check.ts:28-41`).
3. `decide`: assigns `supports` if `P(supports) >= keep_p` (default 0.6) and `hallucinated < 0.5`; assigns `partial` if top or probability is partial; assigns `absent` if top or probability is absent; otherwise `unsupported`. Sets `keep: true` for `supports` and `partial` (`packages/jev/src/judgments/citation-check.ts:48-53`).
4. Modes and failure: default mode is `shadow`, with 8,000 ms timeout (`packages/jev/src/judgments/citation-check.ts:18-19`).
Fallback returns `{ verdict: "partial", keep: true }` (`packages/jev/src/judgments/citation-check.ts:55`).

#### Composite deliverable grading with `acceptCompositeJudgment`

`acceptCompositeJudgment` scores artifacts across multiple evaluation axes (`packages/jev/src/judgments/accept-composite.ts:29-62`):
1. `stateBuilder` clips kind (40 chars), brief (2,000 chars), artifact (16,000 chars), and up to 8 axes (`packages/jev/src/judgments/accept-composite.ts:34-39`).
2. `questions` generates 5-level Score questions (0-4) for each axis (`packages/jev/src/judgments/accept-composite.ts:40-43`).
3. `decide`: records per-axis scores, tracks the weakest axis, and checks `pass = axes.every(axis => scores[axis] >= t.pass_level)` (default `pass_level = 2`) (`packages/jev/src/judgments/accept-composite.ts:45`, `packages/jev/src/judgments/accept-composite.ts:48-58`).
4. Modes and failure: default mode is `shadow`, with 12,000 ms timeout (`packages/jev/src/judgments/accept-composite.ts:32-33`).
Fallback passes with `{ scores: {}, weakest: null, pass: true }` (`packages/jev/src/judgments/accept-composite.ts:60`).

#### Invoice verification with `hardProblems` and `invoiceCheck`

`hardProblems` deterministically verifies numeric and checksum rules before invoking Jev (`packages/jev/src/judgments/invoice-check.ts:42-64`):
1. Checks invoice number existence (`packages/jev/src/judgments/invoice-check.ts:45`).
2. Compares amounts: validates request and invoice amounts are finite positive numbers and `|invoice.amount - request.amount| <= 0.005` (`packages/jev/src/judgments/invoice-check.ts:47-49`).
3. Checks client name existence (`packages/jev/src/judgments/invoice-check.ts:50`).
4. Validates client INN via `validInn` checksum algorithm (10-digit entity, 12-digit individual) and compares against requested INN (`packages/jev/src/judgments/invoice-check.ts:26-33`, `packages/jev/src/judgments/invoice-check.ts:51-52`).
5. Validates payee INN if present (`packages/jev/src/judgments/invoice-check.ts:53`).
6. Validates bank BIK (9 digits starting with `04`), payment account via `validAccount` and correspondent account via `validCorrAccount` (`packages/jev/src/judgments/invoice-check.ts:38-39`, `packages/jev/src/judgments/invoice-check.ts:54-58`).
7. Returns list of problem strings, empty if all checks pass (`packages/jev/src/judgments/invoice-check.ts:59`).

`invoiceCheck` compares invoice text against work scope (`packages/jev/src/judgments/invoice-check.ts:75-120`):
1. `stateBuilder` clips company (300 chars) and service (600 chars) for request and invoice (`packages/jev/src/judgments/invoice-check.ts:82-85`).
2. `questions` asks Noul `company` (same legal entity or transliteration) and Noul `service` (same work scope/period) (`packages/jev/src/judgments/invoice-check.ts:86-95`).
3. `decide`: returns `mismatch` immediately if `hardProblems` finds errors (`packages/jev/src/judgments/invoice-check.ts:101-102`).
Escalates to `"owner"` if company or service answers are missing (`packages/jev/src/judgments/invoice-check.ts:103-104`).
Returns `mismatch` if `company <= max_different` (0.25) or `service <= max_different` (0.25) (`packages/jev/src/judgments/invoice-check.ts:106-108`).
Returns `match` if both exceed `min_same` (0.8) (`packages/jev/src/judgments/invoice-check.ts:109`).
Otherwise returns `unsure` (`packages/jev/src/judgments/invoice-check.ts:110`).
4. Modes and failure: title is `"Совпадает ли счёт с работой"`, default mode is `active`, timeout is 6,000 ms (`packages/jev/src/judgments/invoice-check.ts:77-81`). Fallback returns `mismatch` on hard errors; otherwise computes lexical `overlap` (company >= 0.6, service >= 0.5) to return `match` or `unsure` without model calls (`packages/jev/src/judgments/invoice-check.ts:112-118`).

#### Scanned invoice inspection with `invoiceScanJudgment`

`invoiceScanJudgment` verifies scanned invoice images against expected fields (`packages/jev/src/judgments/invoice-scan.ts:20-48`):
1. `stateBuilder` and `assets` attach page image and expected fields (`inn`, `bik`, `amount`, `number`, clipped to 60 chars) (`packages/jev/src/judgments/invoice-scan.ts:25-29`).
2. `questions` asks Noul `${f}_ok` and Box `${f}_at` for each expected field (`packages/jev/src/judgments/invoice-scan.ts:30-34`).
3. `decide`: records probabilities and appends fields where `p < ok_p` (default 0.7) to `failed`; returns `{ fields, failed, ok: failed.length === 0 }` (`packages/jev/src/judgments/invoice-scan.ts:35-44`).
4. Modes and failure: default mode is `shadow`, with 20,000 ms timeout (`packages/jev/src/judgments/invoice-scan.ts:23-24`).
Fallback returns `{ fields: {}, failed: [], ok: false }` (`packages/jev/src/judgments/invoice-scan.ts:46`).

#### Incident grouping with `repairGroup`

`repairGroup` classifies failure lines into existing incident clusters (`packages/jev/src/judgments/repair-group.ts:25-56`):
1. `stateBuilder` clips incident reason to 800 chars (`packages/jev/src/judgments/repair-group.ts:30`).
2. `questions` formats Choice options for up to 10 candidates (`MAX_CANDIDATES`) plus `new_problem` (`packages/jev/src/judgments/repair-group.ts:31-40`).
3. `decide`: returns `{ signature: null }` if pick is missing, top is `new_problem`, `p < min_p` (0.75), or `margin < min_margin` (0.3) (`packages/jev/src/judgments/repair-group.ts:43-49`).
Otherwise returns the candidate `signature` (`packages/jev/src/judgments/repair-group.ts:50-52`).
4. Modes and failure: default mode is `shadow`, with 6,000 ms timeout (`packages/jev/src/judgments/repair-group.ts:28-29`).
Fallback returns `{ signature: null }` (`packages/jev/src/judgments/repair-group.ts:54`).

#### 3D render verification with `renderMatchJudgment`

`renderMatchJudgment` validates 3D model renders against concept specifications (`packages/jev/src/judgments/render-match.ts:17-48`):
1. `stateBuilder` and `assets` attach concept art and render images with clipped brief (800 chars) (`packages/jev/src/judgments/render-match.ts:22-26`).
2. `questions` asks Noul `matches` (silhouette and proportions) and Noul `defects` (mesh holes, seams, z-fighting) (`packages/jev/src/judgments/render-match.ts:27-36`).
3. `decide`: returns `{ matches: matchP >= t.match_p && defectsP < t.defect_p, matchP, defectsP }` (`match_p` default 0.65, `defect_p` default 0.7) (`packages/jev/src/judgments/render-match.ts:38-44`).
4. Modes and failure: default mode `shadow`, timeout 20,000 ms; fallback returns `{ matches: true, matchP: 1, defectsP: 0 }` (`packages/jev/src/judgments/render-match.ts:20-21`, `packages/jev/src/judgments/render-match.ts:46`).

#### Attempt trace auditing with `traceChecks`

`traceChecks` scores agent task execution traces against safety and quality criteria (`packages/jev/src/judgments/trace-checks.ts:28-78`):
1. `stateBuilder` clips task metadata (title 300 chars, objective 800 chars, 8 criteria) and trace text up to 60,000 chars (`packages/jev/src/judgments/trace-checks.ts:33-36`).
2. `questions` asks 7 Noul questions: `tool_choice`, `grounded`, `stayed_in_scope`, `plan_followed`, `honest_report`, `no_secret_leak`, and `indirect_injection` (`packages/jev/src/judgments/trace-checks.ts:37-66`).
3. `decide`: flags safety checks (`no_secret_leak`, `indirect_injection`) falling below `flag_safety` (default 0.5), and quality checks falling below `flag_below` (default 0.4); returns `{ checks, flags }` (`packages/jev/src/judgments/trace-checks.ts:68-74`).
4. Modes and failure: default mode is `shadow`, with 10,000 ms timeout (`packages/jev/src/judgments/trace-checks.ts:31-32`).
Fallback flags all 7 checks with 0 scores (`packages/jev/src/judgments/trace-checks.ts:76`).

#### Screenshot overflow inspection with `uiShotsJudgment`

`uiShotsJudgment` checks rendered screenshots for viewport overflow (`packages/jev/src/judgments/ui-shots.ts:22-60`):
1. `stateBuilder` and `assets` attach URL (300 chars) and up to 4 screenshots (`MAX_SHOTS`) (`packages/jev/src/judgments/ui-shots.ts:27-31`).
2. `questions` asks Noul `s${i}` (is content overflowing) and Box `b${i}` (bounding box of cut element) (`packages/jev/src/judgments/ui-shots.ts:32-43`).
3. `decide`: finds worst overflow probability: returns `"cut"` if `worst >= cut_p` (0.7); returns `"uncertain"` if `worst >= unsure_p` (0.3); otherwise returns `"clean"`. Attaches bounding box of worst shot if present (`packages/jev/src/judgments/ui-shots.ts:45-56`).
4. Modes and failure: default mode is `shadow`, with 20,000 ms timeout (`packages/jev/src/judgments/ui-shots.ts:25-26`).
Fallback returns `{ verdict: "clean", worst: 0, worstShot: null }` (`packages/jev/src/judgments/ui-shots.ts:58`).

#### Memory retrieval reranking with `memoryRerankJudgment`

`memoryRerankJudgment` filters candidate passages for query relevance (`packages/jev/src/judgments/memory-rerank.ts:16-40`):
1. `stateBuilder` clips query (800 chars) and up to 8 passages (`MAX_PASSAGES`, 1,500 chars each) (`packages/jev/src/judgments/memory-rerank.ts:21-24`).
2. `questions` asks Noul question for each passage: whether it provides relevant precedent or lessons beyond lexical overlap (`packages/jev/src/judgments/memory-rerank.ts:25-29`).
3. `decide`: filters passage indexes where `p >= keep_p` (default 0.8) into `keep` array (`packages/jev/src/judgments/memory-rerank.ts:31-37`).
4. Modes and failure: default mode is `shadow`, with 10,000 ms timeout (`packages/jev/src/judgments/memory-rerank.ts:19-20`).
Fallback scores all passages as 1 and retains all indexes (`packages/jev/src/judgments/memory-rerank.ts:38`).

## Built-in judgment catalog

Registered judgments default to `shadow` unless the mode column says otherwise. `skills.pick` is a helper API rather than a registry judgment. Exported subpaths are listed in the package manifest (`packages/jev/package.json:8-28`).

| ID and capability | Input and output | Branches, bounds and failure behavior | Evidence |
|---|---|---|---|
| `accept.composite`: score a deliverable across axes | Kind, brief, artifact, optional axes → per-axis scores, weakest axis and pass | Four default axes; at most eight asked axes; fallback passes | `packages/jev/src/judgments/accept-composite.ts:8-61` |
| `research.citation`: check claim support | Claim, quote, source metadata and excerpt → supports/partial/unsupported/absent plus keep | Clips fields; hallucination signal blocks `supports`; fallback keeps as partial | `packages/jev/src/judgments/citation-check.ts:8-56` |
| `employee.remark`: classify owner text for an employee | Text and role → remark boolean | Text capped at 4,000 chars; fallback is `remark: true` | `packages/jev/src/judgments/employee-remark.ts:4-20` |
| `guard.host_command`: classify a proposed shell command | Command, cwd, workspace roots, task → allow/review/stop and reason | Up to four roots; thresholds separate review from stop; fallback allows with “not judged”; title describes machine command safety | `packages/jev/src/judgments/host-command.ts:9-59` |
| `invoice.check`: compare invoice text and hard numeric checks | Requested and found invoice data → match/mismatch/unsure | Hard checks validate amounts, INN, BIK and bank-account checksums; only names/services are sent as state; default active; fallback returns mismatch for hard failures, otherwise a lexical match or unsure; title describes invoice work matching | `packages/jev/src/judgments/invoice-check.ts:12-120` |
| `invoice.scan`: compare supplied invoice fields against page image | Expected INN/BIK/amount/number and image → field probabilities, failed fields, ok | Only supplied fields asked; image-backed; failure fallback is `ok: false` | `packages/jev/src/judgments/invoice-scan.ts:10-47` |
| `logs.error_find`: point to the log line containing the failure | Task, command and lines → selected index and has-answer flag | At most 48 lines, 400 chars per line; fallback has no pointed line | `packages/jev/src/judgments/log-find.ts:8-42` |
| `memory.rerank`: filter a lexical memory shortlist | Query and passages → scores and retained indexes | At most eight passages; threshold keep_p defaults to 0.8 (min 0.2, max 0.9); fallback retains every supplied passage | `packages/jev/src/judgments/memory-rerank.ts:8-40` |
| `output.guard`: classify output for screening | Output kind and text → a guard decision | Capped prompt text and per-kind thresholds; fallback is defined in the judgment | `packages/jev/src/judgments/output-guard.ts:13-56` |
| `d.render_match`: compare 3D render to concept | Brief and two images → match and defect probabilities | Image-backed; separate match and defect thresholds; fallback matches | `packages/jev/src/judgments/render-match.ts:10-47` |
| `selfrepair.group`: group an incident with a known cause | Incident kind/reason and candidate groups → known signature or null | At most ten candidates; low probability or margin returns a new group; fallback is null | `packages/jev/src/judgments/repair-group.ts:13-55` |
| Skill selector helper (not a registry ID): select writer skills | Catalog, task, plan, hints and callbacks → skill set with counts | Chunks of eight, six shared in-flight asks, at most five domain and three craft picks, eight hints; kind-filtered skills are cached by name and description, unreadable cache entries are re-evaluated, unanswered skills are not kept, and failed chunks add no picks | `packages/jev/src/judgments/skill-pick.ts:25-46`, `packages/jev/src/judgments/skill-pick.ts:174-184`, `packages/jev/src/judgments/skill-pick.ts:192-211`, `packages/jev/src/judgments/skill-pick.ts:238-258` |
| `skills.tree_pick`: one level of hierarchical skill selection | Task, level, path and options → selected names | At most 24 options in state and six picks; `none` ends descent; fallback selects none | `packages/jev/src/judgments/skill-tree-pick.ts:8-43` |
| `graph.step_trivial`: determine if workflow step is mechanical | Node type, role, input size and optional risk → trivial boolean | Fallback says not trivial; caller owns whether downgrade is allowed | `packages/jev/src/judgments/step-trivial.ts:8-35` |
| `audit.trace`: score attempt trace checks | Task and trace → seven scores and flags | Safety checks have their own threshold; fallback flags all checks | `packages/jev/src/judgments/trace-checks.ts:12-22`, `packages/jev/src/judgments/trace-checks.ts:28-77` |
| `ui.page_shots`: detect screenshot overflow | Page and up to four screenshots → clean/uncertain/cut, worst shot and optional box | Each shot adds a Noul and box question; fallback is clean; semantic page correctness is outside this judgment | `packages/jev/src/judgments/ui-shots.ts:11-59` |

## Modes and failure handling

| Mode or failure | Behavior | Evidence |
|---|---|---|
| `off` | Skip request and return fallback | `packages/jev/src/run.ts:150-156` |
| `shadow` | Return fallback and expose the computed Jev decision as `shadow` | `packages/jev/src/run.ts:145-146` |
| Clear result | Return the decision as `by: "jev"` | `packages/jev/src/run.ts:145-147` |
| Escalation | Return the target and answers as `by: "escalate"` | `packages/jev/src/run.ts:144-146` |
| Provider or shape failure | Return judgment fallback with a failure status | `packages/jev/src/run.ts:135-137` |
| Decision function throws | Log and return fallback with `invalid` status | `packages/jev/src/run.ts:139-142` |

## Business rules

- The deterministic fallback is part of each judgment contract; the generic runner does not invent domain decisions (`packages/jev/src/registry.ts:22-43`).
- `choiceOf` and `noulOf` extract probabilities used by decision functions (`packages/jev/src/registry.ts:63-75`).
- Answer `confidence` is recorded but does not gate decisions (`packages/jev/src/types.ts:15-20`).
- Changing question or decision meaning requires incrementing `version`, because receipts from different versions are not comparable (`packages/jev/src/registry.ts:26-27`).

## Public API or commands

`defineJudgment`, `getJudgment`, `listJudgments`, `choice`, `noul`, `score`, `box`, `choiceOf` and `noulOf` are registry exports (`packages/jev/src/registry.ts:47-75`).

Built-in judgment subpaths are declared in the package manifest (`packages/jev/package.json:8-28`). There are no commands in this workspace.

## Gotchas

- Registration is import-driven; a judgment not imported into the process is absent from the registry (`packages/jev/src/registry.ts:47-55`).
- The list above is the package's built-in judgment set, not every judgment used by the parent plugin; other room files define additional judgments using this registry (`packages/jev/src/index.ts:1-14`, `src/rooms/tasks/plan-fact-judgment.ts:1-20`).

## Related pages

- [Client and runtime](client-runtime.md)
- [Receipt calibration and monitoring](receipt-calibration.md)
- [Overview](../overview.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Jev client and runtime](client-runtime.md)
- [Jev output guard](output-guard.md)
- [Jev receipts, calibration and monitoring](receipt-calibration.md)
- [Jev workspace overview](../overview.md)
