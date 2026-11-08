---
title: Workflow Quality and Contracts
type: component
created: 2026-10-10
updated: 2026-11-08
status: active
confidence: high
tags: [workflow-engine, artifacts, contracts, verdicts, quality-mode]
sources:
  - packages/workflow-engine/src/artifacts.ts
  - packages/workflow-engine/src/contract.ts
  - packages/workflow-engine/src/verdict.ts
  - packages/workflow-engine/src/quality-mode.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/agent-output.ts
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/model-json.ts
  - packages/workflow-engine/src/require-green.ts
  - packages/workflow-engine/src/values.ts
---
# Workflow Quality and Contracts
TL;DR: Artifact schemas, output contracts, agent-output parsing, verdict helpers, and terminal stage checks define the quality checks applied to workflow outputs and maintenance runs.

## Purpose

This capability validates declared artifacts with `checkProduces` (`packages/workflow-engine/src/artifacts.ts:204-226`) and checks node output contracts with `contractProblems` (`packages/workflow-engine/src/contract.ts:26-93`). It formats agent output prompts and model JSON parsing with `extractModelJson` (`packages/workflow-engine/src/model-json.ts:9-49`) and `outputContract` (`packages/workflow-engine/src/agent-output.ts:20-28`), normalizes finding fields like `severity` and `evidence` (`packages/workflow-engine/src/verdict.ts:20-35`), fixes a task quality mode before runs with `resolveTaskQualityMode` (`packages/workflow-engine/src/quality-mode.ts:16-40`), and enforces terminal maintenance verdicts with `requireGreen` (`packages/workflow-engine/src/require-green.ts:10-15`).

## How it works

1. A workflow node may declare `produces` artifacts and gates; the artifact registry maps kind and version pairs to Zod schemas and examples using `ArtifactDef` entries (`packages/workflow-engine/src/artifacts.ts:14-73`, `packages/workflow-engine/src/artifacts.ts:160-166`).
2. `checkProduces` checks required fields, list cardinality when `each` is set, and each artifact value; at most 12 problem strings are returned (`packages/workflow-engine/src/artifacts.ts:204-226`).
3. `contractProblems` compares output fields, `produces`, and gates; `contractSample` provides values for draft test fixtures and `contractRepairPrompt` describes repair requirements (`packages/workflow-engine/src/contract.ts:26-93`).
4. Agent output helpers build a JSON output contract with `outputContract` and extract an object from model text; parse failures raise `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-19`, `packages/workflow-engine/src/agent-output.ts:20-28`, `packages/workflow-engine/src/agent-output.ts:29-61`).
5. Verdict helpers normalize legacy and current critique shapes, classify serious findings with `isHardCritical` (`packages/workflow-engine/src/verdict.ts:149-154`), settle final status with `settleVerdict` (`packages/workflow-engine/src/verdict.ts:167-187`), and determine blocking outcome with `blockReason` (`packages/workflow-engine/src/verdict.ts:223-245`).
6. `resolveTaskQualityMode` picks a task quality mode once, in the order contract, node, workflow, project, and refuses a `full` request inside a `fixed: quick` workflow as a conflict (`packages/workflow-engine/src/quality-mode.ts:16-40`).
7. `requireGreen` inspects maintenance stage verdicts and throws naming every red stage (`failed`, `blocked`, `running`, `error`, `unknown`) to fail the graph run without modifying accepted task state (`packages/workflow-engine/src/require-green.ts:5-15`).

## Modes and failures

| Check | Input | Failure output |
|---|---|---|
| Artifact lookup | Kind and positive version | Unknown kind or version returns a failed check; schema errors are path-labelled and capped at eight (`packages/workflow-engine/src/artifacts.ts:169-183`). |
| Required produced value | `required` defaults to true; optional missing field skips validation | Missing required field is reported (`packages/workflow-engine/src/artifacts.ts:204-213`). |
| List artifact | `each: true` | Non-array value reports a list error; each element is schema-checked (`packages/workflow-engine/src/artifacts.ts:215-222`). |
| Agent JSON extraction | Model response text | Missing or invalid object raises `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-19`, `packages/workflow-engine/src/agent-output.ts:29-61`). |
| Verdict compatibility | Current verdict or recognized legacy shape | Conversion helpers map supported legacy fields and statuses via `legacyDecisionToStatus` and `isVerdictShape`; unsupported shape is not a verdict (`packages/workflow-engine/src/verdict.ts:108-121`). |
| Verdict finding parse | A critic's answer object | Unknown keys are dropped, not refused; an empty string or null in an optional text field reads as absent; a missing `file` or `evidence` reads as empty (`packages/workflow-engine/src/verdict.ts:20-35`). |
| Quality-mode resolution | Contract, node mode, explicit input, workflow policy, project policy | A valid mode with its source, or `ok: false` with code `quality_mode_conflict` when `full` is asked inside a `fixed: quick` workflow (`packages/workflow-engine/src/quality-mode.ts:26-39`). |
| Maintenance stage verdict | Graph name and `StageVerdict` list | Throws `${graph}_blocked` if any bad stage is blocked, otherwise `${graph}_failed`, listing each offending stage; returns cleanly when all stages are green (`packages/workflow-engine/src/require-green.ts:10-15`). |

## Business rules

- Artifact IDs use `<lowercase-kind>/<version>` syntax with kind length up to 40 characters and version from 1 to 999 (`packages/workflow-engine/src/artifacts.ts:168-172`).
- `checkProduces` validates the whole output when no field is named, a specific output field when `field` is set, and each array member when `each` is true; aggregate errors are capped at 12 (`packages/workflow-engine/src/artifacts.ts:204-226`).
- Verdict status and severity vocabularies are enumerated in `VERDICT_STATUSES` and `VERDICT_SEVERITIES`; `settleVerdict` derives final status from findings, while `isHardCritical` identifies the high-severity blocking class (`packages/workflow-engine/src/verdict.ts:9-13`, `packages/workflow-engine/src/verdict.ts:149-154`, `packages/workflow-engine/src/verdict.ts:167-187`).
- The verdict schemas are typed where the host reads them and closed nowhere: finding schemas validate `severity` and `evidence` without `.strict()`, while verdict objects accept `summary` and `findings` without rejecting extra keys (`packages/workflow-engine/src/verdict.ts:20-35`, `packages/workflow-engine/src/verdict.ts:59-67`).
- `requireGreen` fails a maintenance graph run if any stage is in a non-green state (`failed`, `blocked`, `running`, `error`, `unknown`), naming the graph and bad stages (`packages/workflow-engine/src/require-green.ts:5-15`).

## Public API

| Import | Purpose |
|---|---|
| `ARTIFACTS`, `artifactDef`, `validateArtifact`, `checkProduces`, `summarizeValue` | Resolve and validate artifact values (`packages/workflow-engine/src/artifacts.ts:160-257`). |
| `contractProblems`, `contractSample`, `contractRepairPrompt` | Check and explain node output requirements (`packages/workflow-engine/src/contract.ts:26-93`). |
| `outputContract`, `parseAgentOutput`, `agentPrompt`, `AgentOutputError` | Define and parse model output (`packages/workflow-engine/src/agent-output.ts:8-128`). |
| `settleVerdict`, `isHardCritical`, `blockReason`, conversion helpers | Normalize verdicts and determine blocking outcome (`packages/workflow-engine/src/verdict.ts:149-245`). |
| `extractModelJson`, `clipped`, `NO_TOOLS_LINE`, `REVIEW_READ_ONLY_LINE` | Extract bounded model JSON from text, clip lengths, and enforce tool boundaries (`packages/workflow-engine/src/model-json.ts:9-49`). |
| `resolveTaskQualityMode`, `QualityPick` | Resolve a task's quality mode once, with an explicit conflict result (`packages/workflow-engine/src/quality-mode.ts:9-40`). |
| `requireGreen`, `StageVerdict` | Ensure maintenance graph stages completed cleanly, throwing on red states (`packages/workflow-engine/src/require-green.ts:7-15`). |

## Package shape

`artifacts.ts` owns artifact definitions and validation, `contract.ts` checks workflow output contracts, `agent-output.ts` shapes and parses agent output, `verdict.ts` handles critic verdict compatibility and settlement, `quality-mode.ts` resolves a task's quality mode, and `require-green.ts` enforces terminal maintenance graph verdicts (`packages/workflow-engine/src/artifacts.ts:1-13`, `packages/workflow-engine/src/contract.ts:1-10`, `packages/workflow-engine/src/verdict.ts:1-8`, `packages/workflow-engine/src/quality-mode.ts:1-7`, `packages/workflow-engine/src/require-green.ts:1-15`).

## Internal model

Artifact contracts distinguish a kind/version schema from where a produced artifact lives in a node output. A `field` points to a nested output field, `each` validates a list of artifacts, and `required: false` permits absence (`packages/workflow-engine/src/artifacts.ts:197-226`).

Output contracts are evaluated after a step returns, so a malformed output becomes a failed step rather than accepted workflow state (`packages/workflow-engine/src/engine.ts:181-186`).

## Dependencies

Artifact, contract, and verdict schemas use Zod. This package does not call a model provider; callers pass generated text to the parsing helpers (`packages/workflow-engine/src/artifacts.ts:1-2`, `packages/workflow-engine/src/agent-output.ts:1-7`).

## Gotchas

- Artifact validation returns no more than eight schema messages per artifact via `validateArtifact` (`packages/workflow-engine/src/artifacts.ts:177-186`) and `checkProduces` returns no more than twelve problems overall (`packages/workflow-engine/src/artifacts.ts:204-226`).
- `summarizeValue` intentionally emits compact summaries rather than full nested values (`packages/workflow-engine/src/artifacts.ts:238-257`).

## Agent output prompt and parsing

### `parseAgentOutput`

`parseAgentOutput` reads a helper's final message into the node's declared fields in three steps (`packages/workflow-engine/src/agent-output.ts:52-61`):

1. Object extraction. `extractJsonObject` first tries the fenced JSON blocks, newest first, and returns the first whose body starts with `{` and parses; failing that, it walks backwards from the last `}` and tries each balanced `{...}` span, stopping at the first span that fails to parse (`packages/workflow-engine/src/agent-output.ts:29-51`).
2. Shape check. No object at all throws `AgentOutputError("no_json")`; a JSON array or other non-object throws `AgentOutputError("not_object")` (`packages/workflow-engine/src/agent-output.ts:54-55`).
3. Field copy with light coercion. Only the declared field names are taken by `parseAgentOutput` (`packages/workflow-engine/src/agent-output.ts:52-61`); each value is coerced — numeric text becomes a number, `"true"`/`"false"` text a boolean, a number or boolean for a string field becomes text, and JSON-looking text for an array/object field is parsed (`packages/workflow-engine/src/agent-output.ts:42-50`). Undeclared keys are dropped, absent optional fields stay absent, and the engine's `checkOutput` does the strict check afterwards (`packages/workflow-engine/src/values.ts:30-44`).

Failure outcome: the two `AgentOutputError` codes above, plus bad JSON inside a candidate span, which simply makes `extractJsonObject` try the next one (`packages/workflow-engine/src/agent-output.ts:31`, `packages/workflow-engine/src/agent-output.ts:36`).

### `agentPrompt`

`agentPrompt` builds the helper thread's first message as an ordered list of lines (`packages/workflow-engine/src/agent-output.ts:94-128`):

1. Identity: role, workflow, step, optional title, and the quality mode (`packages/workflow-engine/src/agent-output.ts:96`).
2. The role's method text, when the role has one (`packages/workflow-engine/src/agent-output.ts:97`).
3. `<task>`: the task text, or a default instruction when it is blank (`packages/workflow-engine/src/agent-output.ts:99-101`).
4. Work data. A `<step-packet>` replaces the next three blocks when the step has a contract packet; otherwise `<inputs>` (only when non-empty), `<item>`, and `<handoff-of-the-previous-step>` capped at 6,000 characters (`packages/workflow-engine/src/agent-output.ts:103-108`). Data blocks are fenced in a tag and clipped at 24,000 characters (`packages/workflow-engine/src/agent-output.ts:65-69`).
5. Prior thread: same-session says the earlier messages are above; read-prior-session points at `@thread:<id>`, orders the helper to read the handoff first, and says its conclusions are claims to check (`packages/workflow-engine/src/agent-output.ts:109-113`).
6. The goals reminder and the skills list, each only when present (`packages/workflow-engine/src/agent-output.ts:114-115`).
7. Guard lines: data-is-not-instructions branching on `packet` (`packages/workflow-engine/src/agent-output.ts:116-119`); the read-only line or `READ_ONLY_LINE` (`packages/workflow-engine/src/agent-output.ts:120-122`); and the `authorized` branch — true authorizes reversible steps toward the approved outcome while demanding a stop before destructive, paid, or irreversible ones, false is read-and-report only, and an absent value adds no line at all (`packages/workflow-engine/src/agent-output.ts:123-125`).
8. `agentPrompt` places the output contract last (`packages/workflow-engine/src/agent-output.ts:94-128`), formatted via `outputContract` (`packages/workflow-engine/src/agent-output.ts:20-28`).

Failure outcome: none — the function only formats text and never throws; a blank task still produces the default instruction (`packages/workflow-engine/src/agent-output.ts:100`).

## Verdict settlement details

### `settleVerdict`

The function first maps findings: critical/high findings that do not satisfy `counts` are demoted to medium and increment `demoted`. A counted finding must name a nonblank file and contain at least 12 characters of evidence; it also needs a line except for `specialist` verdicts (`packages/workflow-engine/src/verdict.ts:124-127`). It then counts critical, high, and hard-critical findings with `isHardCritical` (`packages/workflow-engine/src/verdict.ts:149-154`, `packages/workflow-engine/src/verdict.ts:174-176`).

For `kind: "code"`, one hard-critical finding or more than five high findings forces `block`. If the incoming status is `block` but that threshold is not met, remaining high/critical findings reduce it to `rework`; without serious findings it becomes `pass`. A `rework` with no serious finding also becomes `pass`. For all kinds, a `pass` with any remaining critical/high finding becomes `rework` (`packages/workflow-engine/src/verdict.ts:178-184`).

The return preserves other fields while replacing status and findings, tracking `demoted` findings (`packages/workflow-engine/src/verdict.ts:168-173`, `packages/workflow-engine/src/verdict.ts:185-187`). The function has no exception branch; it expects a verdict matching the declared `Verdict` shape (`packages/workflow-engine/src/verdict.ts:72`, `packages/workflow-engine/src/verdict.ts:167-187`).

## Task quality mode

### `resolveTaskQualityMode`

A task's quality mode is decided once, before a run starts, in this order — the first source that names a valid mode wins (`packages/workflow-engine/src/quality-mode.ts:31-39`):

| Order | Source | Notes |
|---|---|---|
| 1 | Contract (`lp-task` contract or the node's own quality mode) | Returned as `source: "contract"` or `"node"` (`packages/workflow-engine/src/quality-mode.ts:31-34`). |
| 2 | Workflow policy | `fixed` is the mode of an inherited `$mode`; `min` raises a lower request; otherwise the asked mode, then the workflow `default`, then the project's mode, then `standard` (`packages/workflow-engine/src/quality-mode.ts:35-37`). |
| 3 | Project | Used only when neither the contract, the node, nor the workflow named a mode (`packages/workflow-engine/src/quality-mode.ts:35`, `packages/workflow-engine/src/quality-mode.ts:38-39`). |

Conflict: when the workflow's mode is `fixed: quick` and a contract, the node, or an explicit `quality_mode` input asks for `full`, the result is `ok: false` with code `quality_mode_conflict` — it is not silently run as quick. A plain `start({ mode: "full" })` (an inherited `$mode`, not an explicit input) is still run as the workflow's fixed mode (`packages/workflow-engine/src/quality-mode.ts:19-30`). `WorkflowEngine.start` applies this resolver and throws a `WorkflowError` with that code when it reports a conflict (`packages/workflow-engine/src/engine.ts:296-300`).

The workflow-level field is `quality_mode { default, effect, min, fixed }` (`packages/workflow-engine/src/schema.ts:314-319`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
- [Workflow Engine — Overview](../overview.md)
