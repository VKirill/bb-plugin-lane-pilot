# Research adoption log

Which external (arXiv and audit) ideas Lane Pilot adopted, and which it declined — one line each, with the reason. New entries go at the bottom of their table. Source reports live in `.bb/chats/`.

## Rejected

| Idea | Source | Why not |
|---|---|---|
| Learned routers (RouteLLM class) | arXiv-agents #26 | LP's executable checks are a stronger cascade signal than confidence scores; a learned router adds a component for less information |
| Multi-agent debate as default verifier | arXiv-agents #24 | critical literature + LP's own council; kept behind a test, not expanded |
| Formal verification stacks (Lean/Verus) | arXiv-agents | LP tasks are TypeScript plugin code; cost/benefit does not clear |
| Weight-update self-improvement (RL on trajectories) | arXiv-agents | LP trains nothing; models are external |
| Code-as-harness survey direction | arXiv-agents #6 | framing, no mechanism; LP already treats harness as code (workflow JSON + harness trees) |
| Self-evolving agents surveys | arXiv-agents #11 | taxonomy only; the SMA map already plays the checklist role |
| Trained verifier (SWE-Gym) | arXiv-agents #16 | LP trains nothing; candidate selection exists via best-of + code critic (#18/#24) |
| SWE-fficiency task class | arXiv-agents #27 | LP runs no performance-optimization tasks today; task mix is the owner's call, not a mechanism. Checkable: rerun a bench stratum of perf-tag tasks and compare acceptance/seconds-per-accept — possible once the long stratum exists (stratify.ts) |
| SWE-bench-Pro-like long tasks | arXiv-agents #29 | done instead (wave24): accepted-task size metric on the gate receipt, median per project, grain warnings in plan-check + batch-shape, long bench stratum |

## Adopted (wave 16 verification pass)

| Idea | Where it already lives |
|---|---|
| AFlow/SEW graph search & evolution (#1, #2) | `workflows/lp.harness-edit.json`, `src/rooms/harness/server/graph-edit.ts` — workflow JSONs are tree files, `expect_path` + bench gate |
| Meta-Harness / AutoSaddler / VeRO (#3–#5) | `src/rooms/harness/server/{harness,trial,evidence}.ts` — versioned harness trees, arm trials, adopt by evidence; the edit itself names the lever |
| GEPA-style reflective prompt evolution (#7) | `lp.critic-edit` monthly graph + harness reflect |
| Agent KB layered lessons (#9) | lesson → project rule → hub (`learning/pm-rules.ts`), retrieval at dispatch via `pm-read` |
| AWM mined workflows (#10) | `evidence.ts` reads trial receipts; tree edits cover `workflows/*.json` |
| Judge-survey mitigations (#12) | structured findings with `criterion` = acceptance line (`code-critique.ts`) |
| CFT critique framing (#14) | `role-method.ts` — findings with evidence, not rewrites |
| Recursive parallel scaling (#20) | fallback continuation: failed attempt's worktree + handoff brief |
| SWE-Compass harness-conditional profiles (#32) | `WRITER_PROFILES` describe models inside LP's harness; the Jev pick reads task kind/risk |
| Bias-in-the-Loop audit (#13) | `gilded_defect` class in `checkers/mutators.ts` — defect under cosmetic polish, the scorecard reports the critic's miss rate |
