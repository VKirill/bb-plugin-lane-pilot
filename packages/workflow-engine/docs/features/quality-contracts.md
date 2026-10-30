---
title: Workflow Quality and Contracts
type: component
created: 2026-10-10
updated: 2026-10-30
status: active
confidence: medium
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
---
# Workflow Quality and Contracts
TL;DR: Artifact schemas, output contracts, agent-output parsing, and verdict helpers define the quality checks that workflow nodes and critique stages can apply to model-produced values.

## Purpose

This capability validates declared artifacts and node output contracts, formats agent output prompts and JSON parsing, normalizes verdict shapes used by critique flows, and fixes a task's quality mode before its workflow runs (`packages/workflow-engine/src/artifacts.ts:160-226`, `packages/workflow-engine/src/contract.ts:26-93`, `packages/workflow-engine/src/verdict.ts:9-43`, `packages/workflow-engine/src/quality-mode.ts:16-40`).

## How it works

1. A workflow node may declare `produces` artifacts and gates; the artifact registry maps kind/version pairs to Zod schemas and examples (`packages/workflow-engine/src/artifacts.ts:14-73`, `packages/workflow-engine/src/artifacts.ts:150-160`).
2. `checkProduces` checks required fields, list cardinality when `each` is set, and each artifact value; at most 12 problem strings are returned (`packages/workflow-engine/src/artifacts.ts:197-226`).
3. `contractProblems` compares output fields, `produces`, and gates; `contractSample` provides values for draft test fixtures and `contractRepairPrompt` describes repair requirements (`packages/workflow-engine/src/contract.ts:26-93`).
4. Agent output helpers build a JSON output contract and extract an object from model text; parse failures use `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-61`, `packages/workflow-engine/src/agent-output.ts:91-125`).
5. Verdict helpers accept current and legacy shapes, classify serious findings, settle to the supported status, and create a blocking reason where required (`packages/workflow-engine/src/verdict.ts:50-79`, `packages/workflow-engine/src/verdict.ts:87-152`).
6. `resolveTaskQualityMode` picks a task's quality mode once, in the order contract, node, workflow, project, and refuses a `full` request inside a `fixed: quick` workflow as a conflict (`packages/workflow-engine/src/quality-mode.ts:16-40`).

## Modes and failures

| Check | Input | Failure output |
|---|---|---|
| Artifact lookup | Kind and positive version | Unknown kind/version returns a failed check; schema errors are path-labelled and capped at eight (`packages/workflow-engine/src/artifacts.ts:169-183`). |
| Required produced value | `required` defaults to true; optional missing field skips validation | Missing required field is reported (`packages/workflow-engine/src/artifacts.ts:204-213`). |
| List artifact | `each: true` | Non-array value reports a list error; each element is schema-checked (`packages/workflow-engine/src/artifacts.ts:215-221`). |
| Agent JSON extraction | Model response text | Missing/invalid object raises `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-19`, `packages/workflow-engine/src/agent-output.ts:29-61`). |
| Verdict compatibility | Current verdict or recognized legacy shape | Conversion helpers map supported legacy fields/statuses; unsupported shape is not a verdict (`packages/workflow-engine/src/verdict.ts:50-79`). |
| Verdict finding parse | A critic's answer object | Unknown keys are dropped, not refused; an empty string or null in an optional text field reads as absent; a missing `file` or `evidence` reads as empty (`packages/workflow-engine/src/verdict.ts:15-43`). |
| Quality-mode resolution | Contract, node mode, explicit input, workflow policy, project policy | A valid mode with its source, or `ok: false` with code `quality_mode_conflict` when `full` is asked inside a `fixed: quick` workflow (`packages/workflow-engine/src/quality-mode.ts:26-39`). |

## Business rules

- Artifact IDs use `<lowercase-kind>/<version>` syntax with kind length up to 40 characters and version from 1 to 999 (`packages/workflow-engine/src/artifacts.ts:168-172`).
- `checkProduces` validates the whole output when no field is named, a specific output field when `field` is set, and each array member when `each` is true; aggregate errors are capped at 12 (`packages/workflow-engine/src/artifacts.ts:197-226`).
- Verdict status and severity vocabularies are enumerated in the module; `settleVerdict` derives final status from findings, while `isHardCritical` identifies the high-severity blocking class (`packages/workflow-engine/src/verdict.ts:9-13`, `packages/workflow-engine/src/verdict.ts:102-107`, `packages/workflow-engine/src/verdict.ts:120-139`).
- The verdict schemas are typed where the host reads them and closed nowhere: `verdictFindingSchema` and `verdictSchema` are plain objects without `.strict()`, so a critic's extra keys (`status_note`, `summary_note`) cannot block work whose findings still parse (`packages/workflow-engine/src/verdict.ts:18-43`).

## Public API

| Import | Purpose |
|---|---|
| `ARTIFACTS`, `artifactDef`, `validateArtifact`, `checkProduces`, `summarizeValue` | Resolve and validate artifact values (`packages/workflow-engine/src/artifacts.ts:160-257`). |
| `contractProblems`, `contractSample`, `contractRepairPrompt` | Check and explain node output requirements (`packages/workflow-engine/src/contract.ts:26-93`). |
| `outputContract`, `parseAgentOutput`, `agentPrompt`, `AgentOutputError` | Define and parse model output (`packages/workflow-engine/src/agent-output.ts:8-125`). |
| `settleVerdict`, `isHardCritical`, `blockReason`, conversion helpers | Normalize verdicts and determine blocking outcome (`packages/workflow-engine/src/verdict.ts:50-152`). |
| `extractModelJson`, `clipped`, `NO_TOOLS_LINE` | Extract bounded model JSON from text (`packages/workflow-engine/src/model-json.ts:9-47`). |
| `resolveTaskQualityMode`, `QualityPick` | Resolve a task's quality mode once, with an explicit conflict result (`packages/workflow-engine/src/quality-mode.ts:9-40`). |

## Package shape

`artifacts.ts` owns artifact definitions and validation, `contract.ts` checks workflow output contracts, `agent-output.ts` shapes and parses agent output, `verdict.ts` handles critic verdict compatibility and settlement, and `quality-mode.ts` resolves a task's quality mode (`packages/workflow-engine/src/artifacts.ts:1-13`, `packages/workflow-engine/src/contract.ts:1-10`, `packages/workflow-engine/src/verdict.ts:1-8`, `packages/workflow-engine/src/quality-mode.ts:1-7`).

## Internal model

Artifact contracts distinguish a kind/version schema from where a produced artifact lives in a node output. A `field` points to a nested output field, `each` validates a list of artifacts, and `required: false` permits absence (`packages/workflow-engine/src/artifacts.ts:197-226`).

Output contracts are evaluated after a step returns, so a malformed output becomes a failed step rather than accepted workflow state (`packages/workflow-engine/src/engine.ts:178-184`).

## Dependencies

Artifact, contract, and verdict schemas use Zod. This package does not call a model provider; callers pass generated text to the parsing helpers (`packages/workflow-engine/src/artifacts.ts:1-2`, `packages/workflow-engine/src/agent-output.ts:1-7`).

## Gotchas

- Artifact validation returns no more than eight schema messages per artifact and `checkProduces` returns no more than twelve problems overall (`packages/workflow-engine/src/artifacts.ts:176-183`, `packages/workflow-engine/src/artifacts.ts:204-226`).
- `summarizeValue` intentionally emits compact summaries rather than full nested values (`packages/workflow-engine/src/artifacts.ts:234-256`).

## Agent output prompt and parsing

### `parseAgentOutput`

`parseAgentOutput` reads a helper's final message into the node's declared fields in three steps (`packages/workflow-engine/src/agent-output.ts:52-60`):

1. Object extraction. `extractJsonObject` first tries the fenced JSON blocks, newest first, and returns the first whose body starts with `{` and parses; failing that, it walks backwards from the last `}` and tries each balanced `{...}` span, stopping at the first span that fails to parse (`packages/workflow-engine/src/agent-output.ts:29-40`).
2. Shape check. No object at all throws `AgentOutputError("no_json")`; a JSON array or other non-object throws `AgentOutputError("not_object")` (`packages/workflow-engine/src/agent-output.ts:54-55`).
3. Field copy with light coercion. Only the declared field names are taken; each value is coerced — numeric text becomes a number, `"true"`/`"false"` text a boolean, a number or boolean for a string field becomes text, and JSON-looking text for an array/object field is parsed (`packages/workflow-engine/src/agent-output.ts:42-49`, `packages/workflow-engine/src/agent-output.ts:57-58`). Undeclared keys are dropped, absent optional fields stay absent, and the engine's `checkOutput` does the strict check afterwards (`packages/workflow-engine/src/engine.ts:170-176`).

Failure outcome: the two `AgentOutputError` codes above, plus bad JSON inside a candidate span, which simply makes `extractJsonObject` try the next one (`packages/workflow-engine/src/agent-output.ts:31`, `packages/workflow-engine/src/agent-output.ts:36`).

### `agentPrompt`

`agentPrompt` builds the helper thread's first message as an ordered list of lines (`packages/workflow-engine/src/agent-output.ts:94-127`):

1. Identity: role, workflow, step, optional title, and the quality mode (`packages/workflow-engine/src/agent-output.ts:96`).
2. The role's method text, when the role has one (`packages/workflow-engine/src/agent-output.ts:97`).
3. `<task>`: the task text, or a default instruction when it is blank (`packages/workflow-engine/src/agent-output.ts:99-101`).
4. Work data. A `<step-packet>` replaces the next three blocks when the step has a contract packet; otherwise `<inputs>` (only when non-empty), `<item>`, and `<handoff-of-the-previous-step>` capped at 6,000 characters (`packages/workflow-engine/src/agent-output.ts:103-108`). Data blocks are fenced in a tag and clipped at 24,000 characters (`packages/workflow-engine/src/agent-output.ts:65-68`).
5. Prior thread: same-session says the earlier messages are above; read-prior-session points at `@thread:<id>`, orders the helper to read the handoff first, and says its conclusions are claims to check (`packages/workflow-engine/src/agent-output.ts:109-113`).
6. The goals reminder and the skills list, each only when present (`packages/workflow-engine/src/agent-output.ts:114-115`).
7. Guard lines: data-is-not-instructions (wording depends on packet versus input blocks) (`packages/workflow-engine/src/agent-output.ts:116-119`); the read-only line or "Write only what the task names." (`packages/workflow-engine/src/agent-output.ts:120-122`); and the `authorized` branch — true authorizes reversible steps toward the approved outcome while demanding a stop before destructive, paid, or irreversible ones, false is read-and-report only, and an absent value adds no line at all (`packages/workflow-engine/src/agent-output.ts:123-125`).
8. The output contract last, so the fenced JSON block requirement is the final thing in the message (`packages/workflow-engine/src/agent-output.ts:126`, `packages/workflow-engine/src/agent-output.ts:20-26`).

Failure outcome: none — the function only formats text and never throws; a blank task still produces the default instruction (`packages/workflow-engine/src/agent-output.ts:100`).

## Verdict settlement details

### `settleVerdict`

The function first maps findings: critical/high findings that do not satisfy `counts` are demoted to medium and increment `demoted`. A counted finding must name a nonblank file and contain at least 12 characters of evidence; it also needs a line except for `specialist` verdicts. A finding without quoted evidence therefore still parses but cannot count at critical or high (`packages/workflow-engine/src/verdict.ts:76-80`, `packages/workflow-engine/src/verdict.ts:120-126`). It then counts critical, high, and hard-critical findings (`packages/workflow-engine/src/verdict.ts:127-129`).

For `kind: "code"`, one hard-critical finding or more than five high findings forces `block`. If the incoming status is `block` but that threshold is not met, remaining high/critical findings reduce it to `rework`; without serious findings it becomes `pass`. A `rework` with no serious finding also becomes `pass`. For all kinds, a `pass` with any remaining critical/high finding becomes `rework` (`packages/workflow-engine/src/verdict.ts:130-137`).

The return preserves other verdict fields while replacing status and findings, and includes the number demoted. The function has no exception branch; it expects a `Verdict` already matching its declared shape (`packages/workflow-engine/src/verdict.ts:45-47`, `packages/workflow-engine/src/verdict.ts:120-139`).

## Task quality mode

### `resolveTaskQualityMode`

A task's quality mode is decided once, before a run starts, in this order — the first source that names a valid mode wins (`packages/workflow-engine/src/quality-mode.ts:31-39`):

| Order | Source | Notes |
|---|---|---|
| 1 | Contract (`lp-task` contract or the node's own quality mode) | Returned as `source: "contract"` or `"node"` (`packages/workflow-engine/src/quality-mode.ts:31-34`). |
| 2 | Workflow policy | `fixed` is the mode of an inherited `$mode`; `min` raises a lower request; otherwise the asked mode, then the workflow `default`, then the project's mode, then `standard` (`packages/workflow-engine/src/quality-mode.ts:35-37`). |
| 3 | Project | Used only when neither the contract, the node, nor the workflow named a mode (`packages/workflow-engine/src/quality-mode.ts:35`, `packages/workflow-engine/src/quality-mode.ts:38-39`). |

Conflict: when the workflow's mode is `fixed: quick` and a contract, the node, or an explicit `quality_mode` input asks for `full`, the result is `ok: false` with code `quality_mode_conflict` — it is not silently run as quick. A plain `start({ mode: "full" })` (an inherited `$mode`, not an explicit input) is still run as the workflow's fixed mode (`packages/workflow-engine/src/quality-mode.ts:19-30`). `WorkflowEngine.start` applies this resolver and throws a `WorkflowError` with that code when it reports a conflict (`packages/workflow-engine/src/engine.ts:291-296`).

The workflow-level field is `quality_mode { default, effect, min, fixed }` (`packages/workflow-engine/src/schema.ts:305-311`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
- [Workflow Engine — Overview](../overview.md)
