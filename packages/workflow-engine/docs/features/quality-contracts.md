---
title: Workflow Quality and Contracts
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [workflow-engine, artifacts, contracts, verdicts]
sources:
  - packages/workflow-engine/src/artifacts.ts
  - packages/workflow-engine/src/contract.ts
  - packages/workflow-engine/src/verdict.ts
  - packages/workflow-engine/src/agent-output.ts
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/model-json.ts
---
# Workflow Quality and Contracts
TL;DR: Artifact schemas, output contracts, agent-output parsing, and verdict helpers define the quality checks that workflow nodes and critique stages can apply to model-produced values.

## Purpose

This capability validates declared artifacts and node output contracts, formats agent output prompts and JSON parsing, and normalizes verdict shapes used by critique flows (`packages/workflow-engine/src/artifacts.ts:160-226`, `packages/workflow-engine/src/contract.ts:26-93`, `packages/workflow-engine/src/verdict.ts:9-38`).

## How it works

1. A workflow node may declare `produces` artifacts and gates; the artifact registry maps kind/version pairs to Zod schemas and examples (`packages/workflow-engine/src/artifacts.ts:14-73`, `packages/workflow-engine/src/artifacts.ts:150-160`).
2. `checkProduces` checks required fields, list cardinality when `each` is set, and each artifact value; at most 12 problem strings are returned (`packages/workflow-engine/src/artifacts.ts:197-226`).
3. `contractProblems` compares output fields, `produces`, and gates; `contractSample` provides values for draft test fixtures and `contractRepairPrompt` describes repair requirements (`packages/workflow-engine/src/contract.ts:26-93`).
4. Agent output helpers build a JSON output contract and extract an object from model text; parse failures use `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-61`, `packages/workflow-engine/src/agent-output.ts:91-125`).
5. Verdict helpers accept current and legacy shapes, classify serious findings, settle to the supported status, and create a blocking reason where required (`packages/workflow-engine/src/verdict.ts:44-70`, `packages/workflow-engine/src/verdict.ts:87-148`).

## Modes and failures

| Check | Input | Failure output |
|---|---|---|
| Artifact lookup | Kind and positive version | Unknown kind/version returns a failed check; schema errors are path-labelled and capped at eight (`packages/workflow-engine/src/artifacts.ts:169-183`). |
| Required produced value | `required` defaults to true; optional missing field skips validation | Missing required field is reported (`packages/workflow-engine/src/artifacts.ts:204-213`). |
| List artifact | `each: true` | Non-array value reports a list error; each element is schema-checked (`packages/workflow-engine/src/artifacts.ts:215-221`). |
| Agent JSON extraction | Model response text | Missing/invalid object raises `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-19`, `packages/workflow-engine/src/agent-output.ts:29-61`). |
| Verdict compatibility | Current verdict or recognized legacy shape | Conversion helpers map supported legacy fields/statuses; unsupported shape is not a verdict (`packages/workflow-engine/src/verdict.ts:44-70`). |

## Business rules

- Artifact IDs use `<lowercase-kind>/<version>` syntax with kind length up to 40 characters and version from 1 to 999 (`packages/workflow-engine/src/artifacts.ts:168-172`).
- `checkProduces` validates the whole output when no field is named, a specific output field when `field` is set, and each array member when `each` is true; aggregate errors are capped at 12 (`packages/workflow-engine/src/artifacts.ts:197-226`).
- Verdict status and severity vocabularies are enumerated in the module; `settleVerdict` derives final status from findings, while `isHardCritical` identifies the high-severity blocking class (`packages/workflow-engine/src/verdict.ts:9-38`, `packages/workflow-engine/src/verdict.ts:96-135`).

## Public API

| Import | Purpose |
|---|---|
| `ARTIFACTS`, `artifactDef`, `validateArtifact`, `checkProduces`, `summarizeValue` | Resolve and validate artifact values (`packages/workflow-engine/src/artifacts.ts:160-257`). |
| `contractProblems`, `contractSample`, `contractRepairPrompt` | Check and explain node output requirements (`packages/workflow-engine/src/contract.ts:26-93`). |
| `outputContract`, `parseAgentOutput`, `agentPrompt`, `AgentOutputError` | Define and parse model output (`packages/workflow-engine/src/agent-output.ts:8-125`). |
| `settleVerdict`, `isHardCritical`, `blockReason`, conversion helpers | Normalize verdicts and determine blocking outcome (`packages/workflow-engine/src/verdict.ts:44-148`). |
| `extractModelJson`, `clipped`, `NO_TOOLS_LINE` | Extract bounded model JSON from text (`packages/workflow-engine/src/model-json.ts:9-47`). |

## Package shape

`artifacts.ts` owns artifact definitions and validation, `contract.ts` checks workflow output contracts, `agent-output.ts` shapes and parses agent output, and `verdict.ts` handles critic verdict compatibility and settlement (`packages/workflow-engine/src/artifacts.ts:1-13`, `packages/workflow-engine/src/contract.ts:1-10`, `packages/workflow-engine/src/verdict.ts:1-8`).

## Internal model

Artifact contracts distinguish a kind/version schema from where a produced artifact lives in a node output. A `field` points to a nested output field, `each` validates a list of artifacts, and `required: false` permits absence (`packages/workflow-engine/src/artifacts.ts:197-226`).

Output contracts are evaluated after a step returns, so a malformed output becomes a failed step rather than accepted workflow state (`packages/workflow-engine/src/engine.ts:139-145`).

## Dependencies

Artifact, contract, and verdict schemas use Zod. This package does not call a model provider; callers pass generated text to the parsing helpers (`packages/workflow-engine/src/artifacts.ts:1-2`, `packages/workflow-engine/src/agent-output.ts:1-7`).

## Gotchas

- Artifact validation returns no more than eight schema messages per artifact and `checkProduces` returns no more than twelve problems overall (`packages/workflow-engine/src/artifacts.ts:176-183`, `packages/workflow-engine/src/artifacts.ts:204-226`).
- `summarizeValue` intentionally emits compact summaries rather than full nested values (`packages/workflow-engine/src/artifacts.ts:234-256`).

## Verdict settlement details

### `settleVerdict`

The function first maps findings: critical/high findings that do not satisfy `counts` are demoted to medium and increment `demoted`. A counted finding must name a nonblank file and contain at least 12 characters of evidence; it also needs a line except for `specialist` verdicts. It then counts critical, high, and hard-critical findings (`packages/workflow-engine/src/verdict.ts:70-74`, `packages/workflow-engine/src/verdict.ts:114-124`).

For `kind: "code"`, one hard-critical finding or more than five high findings forces `block`. If the incoming status is `block` but that threshold is not met, remaining high/critical findings reduce it to `rework`; without serious findings it becomes `pass`. A `rework` with no serious finding also becomes `pass`. For all kinds, a `pass` with any remaining critical/high finding becomes `rework` (`packages/workflow-engine/src/verdict.ts:121-132`).

The return preserves other verdict fields while replacing status and findings, and includes the number demoted. The function has no exception branch; it expects a `Verdict` already matching its declared shape (`packages/workflow-engine/src/verdict.ts:31-41`, `packages/workflow-engine/src/verdict.ts:114-132`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
