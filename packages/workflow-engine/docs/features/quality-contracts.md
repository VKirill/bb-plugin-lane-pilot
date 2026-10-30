---
title: Workflow Quality and Contracts
type: component
created: 2026-10-10
updated: 2026-10-30
status: active
confidence: medium
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

This capability validates declared artifacts and node output contracts, formats agent output prompts and JSON parsing, and normalizes verdict shapes used by critique flows (`packages/workflow-engine/src/artifacts.ts:160-226`, `packages/workflow-engine/src/contract.ts:26-93`, `packages/workflow-engine/src/verdict.ts:9-46`).

## How it works

1. A workflow node may declare `produces` artifacts and gates; the artifact registry maps kind/version pairs to Zod schemas and examples (`packages/workflow-engine/src/artifacts.ts:14-73`, `packages/workflow-engine/src/artifacts.ts:150-160`).
2. `checkProduces` checks required fields, list cardinality when `each` is set, and each artifact value; at most 12 problem strings are returned (`packages/workflow-engine/src/artifacts.ts:197-226`).
3. `contractProblems` compares output fields, `produces`, and gates; `contractSample` provides values for draft test fixtures and `contractRepairPrompt` describes repair requirements (`packages/workflow-engine/src/contract.ts:26-93`).
4. Agent output helpers build a JSON output contract and extract an object from model text; parse failures use `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-61`, `packages/workflow-engine/src/agent-output.ts:91-125`).
5. Verdict helpers parse a critic's answer leniently (unknown keys are dropped, and an empty or null optional text reads as absent), accept current and legacy shapes, classify serious findings, settle to the supported status, and create a blocking reason where required (`packages/workflow-engine/src/verdict.ts:15-35`, `packages/workflow-engine/src/verdict.ts:37-74`, `packages/workflow-engine/src/verdict.ts:102-152`).

## Modes and failures

| Check | Input | Failure output |
|---|---|---|
| Artifact lookup | Kind and positive version | Unknown kind/version returns a failed check; schema errors are path-labelled and capped at eight (`packages/workflow-engine/src/artifacts.ts:169-183`). |
| Required produced value | `required` defaults to true; optional missing field skips validation | Missing required field is reported (`packages/workflow-engine/src/artifacts.ts:204-213`). |
| List artifact | `each: true` | Non-array value reports a list error; each element is schema-checked (`packages/workflow-engine/src/artifacts.ts:215-221`). |
| Agent JSON extraction | Model response text | Missing/invalid object raises `AgentOutputError` (`packages/workflow-engine/src/agent-output.ts:8-19`, `packages/workflow-engine/src/agent-output.ts:29-61`). |
| Verdict compatibility | Current verdict or recognized legacy shape; unknown keys are dropped and empty/null optional text fields read as absent, not refused (`packages/workflow-engine/src/verdict.ts:15-35`) | Conversion helpers map supported legacy fields/statuses; unsupported shape is not a verdict (`packages/workflow-engine/src/verdict.ts:37-74`). |

## Business rules

- Artifact IDs use `<lowercase-kind>/<version>` syntax with kind length up to 40 characters and version from 1 to 999 (`packages/workflow-engine/src/artifacts.ts:168-172`).
- `checkProduces` validates the whole output when no field is named, a specific output field when `field` is set, and each array member when `each` is true; aggregate errors are capped at 12 (`packages/workflow-engine/src/artifacts.ts:197-226`).
- Verdict status and severity vocabularies are enumerated in the module; `settleVerdict` derives final status from findings, while `isHardCritical` identifies the high-severity blocking class (`packages/workflow-engine/src/verdict.ts:9-43`, `packages/workflow-engine/src/verdict.ts:102-139`).

## Public API

| Import | Purpose |
|---|---|
| `ARTIFACTS`, `artifactDef`, `validateArtifact`, `checkProduces`, `summarizeValue` | Resolve and validate artifact values (`packages/workflow-engine/src/artifacts.ts:160-257`). |
| `contractProblems`, `contractSample`, `contractRepairPrompt` | Check and explain node output requirements (`packages/workflow-engine/src/contract.ts:26-93`). |
| `outputContract`, `parseAgentOutput`, `agentPrompt`, `AgentOutputError` | Define and parse model output (`packages/workflow-engine/src/agent-output.ts:8-125`). |
| `settleVerdict`, `isHardCritical`, `blockReason`, conversion helpers | Normalize verdicts and determine blocking outcome (`packages/workflow-engine/src/verdict.ts:49-152`). |
| `extractModelJson`, `clipped`, `NO_TOOLS_LINE` | Extract bounded model JSON from text (`packages/workflow-engine/src/model-json.ts:9-47`). |

## Package shape

`artifacts.ts` owns artifact definitions and validation, `contract.ts` checks workflow output contracts, `agent-output.ts` shapes and parses agent output, and `verdict.ts` handles critic verdict compatibility and settlement (`packages/workflow-engine/src/artifacts.ts:1-13`, `packages/workflow-engine/src/contract.ts:1-10`, `packages/workflow-engine/src/verdict.ts:1-8`).

## Internal model

Artifact contracts distinguish a kind/version schema from where a produced artifact lives in a node output. A `field` points to a nested output field, `each` validates a list of artifacts, and `required: false` permits absence (`packages/workflow-engine/src/artifacts.ts:197-226`).

Output contracts are evaluated after a step returns, so a malformed output becomes a failed step rather than accepted workflow state (`packages/workflow-engine/src/engine.ts:170-176`).

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

The host re-reads a verdict in four steps, so a model's status cannot say more than its findings back up (`packages/workflow-engine/src/verdict.ts:120-139`):

1. Demotion. Each critical/high finding that fails `counts` is rewritten to medium and counted in `demoted`. `counts` requires a nonblank `file`, at least 12 characters of `evidence`, and — outside `specialist` verdicts — a `line` (`packages/workflow-engine/src/verdict.ts:121-126`, `packages/workflow-engine/src/verdict.ts:76-80`).
2. Counting. Critical, high, and hard-critical findings are counted after demotion (`packages/workflow-engine/src/verdict.ts:127-129`). A hard critical is a critical finding whose dimension is `security`, whose prose — code and quotes stripped by `proseOnly`, so quoted code full of words like `password` does not trigger it — matches the `HARD_CRITICAL` list (secrets, credentials, injection, data loss, forbidden operations), or whose evidence itself contains a credential-shaped literal (`packages/workflow-engine/src/verdict.ts:102-107`, `packages/workflow-engine/src/verdict.ts:87-101`).
3. Code-kind thresholds. For `kind: "code"` the block decision is made from the findings: at least one hard-critical finding or more than five high findings force `block`; a model-declared `block` below that threshold falls to `rework`, or to `pass` when no serious finding remains; a `rework` with no critical/high finding also becomes `pass` (`packages/workflow-engine/src/verdict.ts:130-136`).
4. Final check. For every kind, a `pass` that still carries a critical or high finding becomes `rework` (`packages/workflow-engine/src/verdict.ts:137`).

| Outcome | Condition |
|---|---|
| `block` | code kind with a hard-critical finding or more than five high findings (`packages/workflow-engine/src/verdict.ts:131-133`) |
| `rework` | a `pass` with critical/high findings remaining (`packages/workflow-engine/src/verdict.ts:137`); a model `block` below the code threshold with serious findings left (`packages/workflow-engine/src/verdict.ts:134`) |
| `pass` | a model `block` below the code threshold or a `rework`, in both cases with no critical/high finding left (`packages/workflow-engine/src/verdict.ts:134-135`) |
| unchanged | every other status carries over as the model sent it (`packages/workflow-engine/src/verdict.ts:130`) |

The return keeps the other verdict fields, replaces status and findings, and reports `demoted`. The function is pure — it has no exception branch and expects a `Verdict` already matching `verdictSchema`, so schema failures happen at parse time, not here (`packages/workflow-engine/src/verdict.ts:37-43`, `packages/workflow-engine/src/verdict.ts:138`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
