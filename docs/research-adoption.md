---
title: Research adoption log
type: overview
created: 2026-10-30
updated: 2026-11-26
status: active
confidence: medium
tags: [research, critique, adoption]
sources:
  - src/rooms/tasks/models/task-size.ts
  - src/rooms/tasks/models/batch-shape.ts
  - src/rooms/writer/server/services/finish-merge.ts
  - src/rooms/critique/models/code-critique.ts
  - src/rooms/critique/models/role-method.ts
  - src/rooms/writer/server/services/start-attempt-spawn.ts
  - packages/models/src/model-profiles.ts
  - src/rooms/checkers/models/mutators.ts
---

# Research adoption log

TL;DR: Tracks which external research ideas Lane Pilot declined and which ones it implemented in tasks, critique, writer, models, and checker subsystems (`src/rooms/checkers/models/mutators.ts`).

## Rejected

| Idea | Source | Why not | Code reference |
|---|---|---|---|
| Learned routers (RouteLLM class) | arXiv-agents #26 | LP's executable checks are a stronger cascade signal than confidence scores; a learned router adds a component for less information | — |
| Multi-agent debate as default verifier | arXiv-agents #24 | Critical literature + LP's debate experience; not used as a default verifier | — |
| Formal verification stacks (Lean/Verus) | arXiv-agents | LP tasks are TypeScript plugin code; cost/benefit does not clear | — |
| Weight-update self-improvement (RL on trajectories) | arXiv-agents | LP trains nothing; models are external | — |
| Trained verifier (SWE-Gym) | arXiv-agents #16 | LP trains nothing; candidate selection exists via best-of + code critic (#18/#24) | `src/rooms/writer/server/services/start-attempt-spawn.ts` |
| SWE-fficiency task class | arXiv-agents #27 | LP runs no performance-optimization tasks; task mix is the owner's call, not a mechanism | — |
| SWE-bench-Pro-like long tasks | arXiv-agents #29 | Implemented instead as accepted-task size metrics (`taskSizeOf`) and per-project median grain warnings (`batchShapeAdvice`) | `src/rooms/tasks/models/task-size.ts`, `src/rooms/tasks/models/batch-shape.ts`, `src/rooms/writer/server/services/finish-merge.ts` |

## Adopted

| Idea | Where it lives | Code reference |
|---|---|---|
| Judge-survey mitigations (#12) | Structured findings with `criterion` matching acceptance lines in `codeCritiqueFindingSchema` | `src/rooms/critique/models/code-critique.ts` |
| CFT critique framing (#14) | Role-specific evidence-first method prompts (`CODE_CRITIC_METHOD`) returned by `roleMethod` | `src/rooms/critique/models/role-method.ts` |
| Recursive parallel scaling (#20) | Multi-round best-of seeding via `roundSeedBrief` and `roundSurvivors` | `src/rooms/writer/server/services/start-attempt-spawn.ts` |
| SWE-Compass profiles (#32) | `WRITER_PROFILES` describes writer models with provider, label, and cost tier | `packages/models/src/model-profiles.ts` |
| Bias-in-the-Loop audit (#13) | `gilded_defect` mutator (`gildedDefect`) plants a swallowed error wrapped in a reassuring design comment | `src/rooms/checkers/models/mutators.ts` |
