---
title: Typed judgments
type: component
created: 2026-11-05
updated: 2026-11-07
status: active
confidence: high
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

`defineJudgment` validates a dotted lowercase ID, rejects a second distinct registration under the same ID, and stores the judgment in an in-memory registry (`packages/jev/src/registry.ts:43-55`). Question constructors support `choice`, `noul`, `score` and image `box` (`packages/jev/src/registry.ts:57-59`). The answer types define their response shapes (`packages/jev/src/types.ts:4-31`). Response parsing checks each answer against its question type (`packages/jev/src/client.ts:141-154`).

## How it works

1. The author defines an ID, version, default mode, timeout, state builder, questions, threshold specifications, `decide`, fallback and short description (`packages/jev/src/registry.ts:20-42`).
2. Importing the module registers the judgment; `getJudgment` and `listJudgments` expose registered entries (`packages/jev/src/registry.ts:43-55`).
3. The runner builds redacted state and questions and enforces the per-judgment question cap (`packages/jev/src/run.ts:102-107`).
4. It calls the judgment's `decide` function with resolved thresholds (`packages/jev/src/run.ts:139-142`).
5. A decision can return a domain result or `escalate` with a target string; failed or unclear cases use the deterministic fallback (`packages/jev/src/registry.ts:19-40`).

## Built-in judgment catalog

Registered judgments default to `shadow` unless the mode column says otherwise. `skills.pick` is a helper API rather than a registry judgment. Exported subpaths are listed in the package manifest (`packages/jev/package.json:8-28`).

| ID and capability | Input and output | Branches, bounds and failure behavior | Evidence |
|---|---|---|---|
| `accept.composite`: score a deliverable across axes | Kind, brief, artifact, optional axes → per-axis scores, weakest axis and pass | Four default axes; at most eight asked axes; fallback passes | `packages/jev/src/judgments/accept-composite.ts:8-61` |
| `research.citation`: check claim support | Claim, quote, source metadata and excerpt → supports/partial/unsupported/absent plus keep | Clips fields; hallucination signal blocks `supports`; fallback keeps as partial | `packages/jev/src/judgments/citation-check.ts:8-56` |
| `employee.remark`: classify owner text for an employee | Text and role → remark boolean | Text capped at 4,000 chars; fallback is `remark: true` | `packages/jev/src/judgments/employee-remark.ts:4-20` |
| `guard.host_command`: classify a proposed shell command | Command, cwd, workspace roots, task → allow/review/stop and reason | Up to four roots; thresholds separate review from stop; fallback allows with “not judged” | `packages/jev/src/judgments/host-command.ts:9-57` |
| `invoice.check`: compare invoice text and hard numeric checks | Requested and found invoice data → match/mismatch/unsure | Hard checks validate amounts, INN, BIK and bank-account checksums; only names/services are sent as state; default active; fallback returns mismatch for hard failures, otherwise a lexical match or unsure | `packages/jev/src/judgments/invoice-check.ts:12-119` |
| `invoice.scan`: compare supplied invoice fields against page image | Expected INN/BIK/amount/number and image → field probabilities, failed fields, ok | Only supplied fields asked; image-backed; failure fallback is `ok: false` | `packages/jev/src/judgments/invoice-scan.ts:10-47` |
| `logs.error_find`: point to the log line containing the failure | Task, command and lines → selected index and has-answer flag | At most 48 lines, 400 chars per line; fallback has no pointed line | `packages/jev/src/judgments/log-find.ts:8-42` |
| `memory.rerank`: filter a lexical memory shortlist | Query and passages → scores and retained indexes | At most eight passages; threshold keep_p defaults to 0.8 (min 0.2, max 0.9); fallback retains every supplied passage | `packages/jev/src/judgments/memory-rerank.ts:8-40` |
| `output.guard`: classify output for screening | Output kind and text → a guard decision | Capped prompt text and per-kind thresholds; fallback is defined in the judgment | `packages/jev/src/judgments/output-guard.ts:13-56` |
| `d.render_match`: compare 3D render to concept | Brief and two images → match and defect probabilities | Image-backed; separate match and defect thresholds; fallback matches | `packages/jev/src/judgments/render-match.ts:10-47` |
| `selfrepair.group`: group an incident with a known cause | Incident kind/reason and candidate groups → known signature or null | At most ten candidates; low probability or margin returns a new group; fallback is null | `packages/jev/src/judgments/repair-group.ts:13-55` |
| Skill selector helper (not a registry ID): select writer skills | Catalog, task, plan, hints and callbacks → skill set with counts | Chunks of eight, six shared in-flight asks, at most five domain and three craft picks, eight hints; kind-filtered skills are cached by name and description, unanswered skills are not kept, and failed chunks add no picks | `packages/jev/src/judgments/skill-pick.ts:25-46`, `packages/jev/src/judgments/skill-pick.ts:174-184`, `packages/jev/src/judgments/skill-pick.ts:192-210`, `packages/jev/src/judgments/skill-pick.ts:238-258` |
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

- The deterministic fallback is part of each judgment contract; the generic runner does not invent domain decisions (`packages/jev/src/registry.ts:20-42`).
- `choiceOf` and `noulOf` extract probabilities used by decision functions (`packages/jev/src/registry.ts:60-74`).
- Answer `confidence` is recorded but does not gate decisions (`packages/jev/src/types.ts:15-20`).
- Changing question or decision meaning requires incrementing `version`, because receipts from different versions are not comparable (`packages/jev/src/registry.ts:20-27`).

## Public API or commands

`defineJudgment`, `getJudgment`, `listJudgments`, `choice`, `noul`, `score`, `box`, `choiceOf` and `noulOf` are registry exports (`packages/jev/src/registry.ts:43-74`).

Built-in judgment subpaths are declared in the package manifest (`packages/jev/package.json:8-28`). There are no commands in this workspace.

## Gotchas

- Registration is import-driven; a judgment not imported into the process is absent from the registry (`packages/jev/src/registry.ts:43-55`).
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
