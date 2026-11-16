---
title: Research adoption log
type: overview
created: 2026-10-30
updated: 2026-11-16
status: active
confidence: medium
tags: [research, harness, bench, critique, adoption]
sources:
  - src/rooms/bench/stratify.ts
  - src/rooms/tasks/task-size.ts
  - src/rooms/tasks/batch-shape.ts
  - src/rooms/writer/server/finish-merge.ts
  - workflows/lp.harness-edit.json
  - src/rooms/harness/server/graph-edit.ts
  - src/rooms/harness/server/harness.ts
  - src/rooms/harness/server/trial.ts
  - src/rooms/harness/server/evidence.ts
  - workflows/lp.critic-edit.json
  - src/rooms/learning/pm-rules.ts
  - src/rooms/critique/code-critique.ts
  - src/rooms/critique/role-method.ts
  - src/rooms/writer/server/start-attempt-spawn.ts
  - packages/models/src/model-profiles.ts
  - src/rooms/checkers/mutators.ts
---

# Research adoption log

TL;DR: Tracks which external research ideas Lane Pilot declined and which ones it implemented in the harness, bench, critique, and checker subsystems (`src/rooms/bench/stratify.ts:68-81`, `src/rooms/checkers/mutators.ts:139-156`, `:223-227`).

## Rejected

| Idea | Source | Why not | Code reference |
|---|---|---|---|
| Learned routers (RouteLLM class) | arXiv-agents #26 | LP's executable checks are a stronger cascade signal than confidence scores; a learned router adds a component for less information | — |
| Multi-agent debate as default verifier | arXiv-agents #24 | Critical literature + LP's own council; kept behind a test, not expanded | — |
| Formal verification stacks (Lean/Verus) | arXiv-agents | LP tasks are TypeScript plugin code; cost/benefit does not clear | — |
| Weight-update self-improvement (RL on trajectories) | arXiv-agents | LP trains nothing; models are external | — |
| Code-as-harness survey direction | arXiv-agents #6 | Framing, no mechanism; LP already treats harness as code (`graphEditProblems` validates workflow JSONs as tree files) | `src/rooms/harness/server/graph-edit.ts:14-27` |
| Self-evolving agents surveys | arXiv-agents #11 | Taxonomy only; the SMA map already plays the checklist role | — |
| Trained verifier (SWE-Gym) | arXiv-agents #16 | LP trains nothing; candidate selection exists via best-of + code critic (#18/#24) | `src/rooms/writer/server/start-attempt-spawn.ts:92-112` |
| SWE-fficiency task class | arXiv-agents #27 | LP runs no performance-optimization tasks; task mix is the owner's call, not a mechanism (checkable via `Stratum` slices in `DEFAULT_STRATA`) | `src/rooms/bench/stratify.ts:7-19` |
| SWE-bench-Pro-like long tasks | arXiv-agents #29 | Implemented instead as accepted-task size metrics (`taskSizeOf`), per-project median grain warnings (`batchShapeAdvice`), and the `longStratum` bench slice | `src/rooms/tasks/task-size.ts:15-27`; `src/rooms/tasks/batch-shape.ts:39-45`; `src/rooms/writer/server/finish-merge.ts:170-171`; `src/rooms/bench/stratify.ts:68-81` |

## Adopted

| Idea | Where it lives | Code reference |
|---|---|---|
| AFlow/SEW graph search & evolution (#1, #2) | `lp.harness-edit` validates workflow JSONs as tree files with `graphEditProblems` and `expect_path` | `workflows/lp.harness-edit.json:1-45`; `src/rooms/harness/server/graph-edit.ts:6-27` |
| Meta-Harness / AutoSaddler / VeRO (#3–#5) | Versioned harness trees, alternating arm trials (`TRIAL_DEFAULTS`), and file-based `evidenceFiles` context | `src/rooms/harness/server/harness.ts:20-44`; `src/rooms/harness/server/trial.ts:8-35`; `src/rooms/harness/server/evidence.ts:36-60` |
| GEPA-style reflective prompt evolution (#7) | `lp.critic-edit` monthly calibration graph plus `reflect` harness step | `workflows/lp.critic-edit.json:1-45`; `src/rooms/harness/server/harness.ts:29`, `:42` |
| Agent KB layered lessons (#9) | Lesson to project rule (`pmRulesOf`, `pmRulesPromptBlock`) retrieved at PM dispatch and resume | `src/rooms/learning/pm-rules.ts:19-52` |
| AWM mined workflows (#10) | `evidenceFiles` reads trial receipts; tree edits validate `GRAPH_RX` (`workflows/*.json`) paths | `src/rooms/harness/server/evidence.ts:17-60`; `src/rooms/harness/server/graph-edit.ts:4-17` |
| Judge-survey mitigations (#12) | Structured findings with `criterion` matching acceptance lines in `codeCritiqueFindingSchema` | `src/rooms/critique/code-critique.ts:25-48` |
| CFT critique framing (#14) | Role-specific evidence-first method prompts (`CODE_CRITIC_METHOD`) returned by `roleMethod` | `src/rooms/critique/role-method.ts:24-32`, `src/rooms/critique/role-method.ts:73-85` |
| Recursive parallel scaling (#20) | Multi-round best-of seeding via `roundSeedBrief` and `roundSurvivors` | `src/rooms/writer/server/start-attempt-spawn.ts:94-112` |
| SWE-Compass harness-conditional profiles (#32) | `WRITER_PROFILES` describes writer models with provider, label, and cost tier | `packages/models/src/model-profiles.ts:16-34` |
| Bias-in-the-Loop audit (#13) | `gilded_defect` mutator (`gildedDefect`) plants a swallowed error wrapped in a reassuring design comment | `src/rooms/checkers/mutators.ts:139-156`, `:223-227` |
