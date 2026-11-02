# Harness research batch (plan, 2026-11-02)

Owner's word: «делай» (thread thr_6pwx5dw9f8, 2026-11-02 ~04:00 Madrid) on the decomposition in
`.bb/chats/thr_6pwx5dw9f8/artifacts/research-harness-2026/synthesis.md` §5 (five items for the week), after the five-source
research on where agent harnesses go. Base 0.1.477 (669f9f39). One release for the batch.

## Items

| # | Item | Who | Where | Measure |
|---|---|---|---|---|
| 1 | Every Jev judge gets labels (outcome rules + sampled model relabel, nightly graph, «Судьи» table) | SWE-2 stream H1 | `packages/jev`, `src/rooms/jev`, `night-graphs`, improvement page | ≥50 labels per judge in 14 days |
| 2 | No attempt spent on a writer known to be unavailable (hold + wake, one PM line, attempts per accepted task) | SWE-2 stream H2 | `src/rooms/writer/server`, runs migration, attempt-metrics | 1.66 → ≤1.3 attempts per accepted task; blocked share 40 % → <10 % |
| 3 | Owner inbox: ranked, capped at 5 «now», the rest «later»; answer statistics | me | `src/rooms/owner-waiting` | ≤5 rows a day to the owner; the line on the board |
| 4 | Skill before graph: the lead's «process» proposal names the form (навык / граф) from the errands' shape | me | `src/rooms/lead/server/tick.ts` | the next proposals carry a form and a reason |
| 5 | Rules: PM rule use is recorded, so the trial can confirm or retire PM rules too; the rules page shows hits | me | `src/rooms/learning/pm-rules.ts`, `packages/run-insights/src/rules.ts` | no rule in force without a recorded use after 60 days |
| 6 | (owner's question tonight) `test_fit` respects an intended test removal declared in the contract (`test_removals`), and its refusal tells the PM the field | me | `packages/contracts/src/schemas.ts`, `src/rooms/writer/server/finish.ts`, tools | a cleanup task passes without a trip to another chat |

## Streams

| Stream | Branch | Worktree | Brief |
|---|---|---|---|
| H1 judge labels | swe2/h1-judge-labels | ~/BB-service/wt/h1-judge-labels | `.bb/chats/thr_6pwx5dw9f8/tmp/brief-h1.md` |
| H2 attempt waste | swe2/h2-attempt-waste | ~/BB-service/wt/h2-attempt-waste | `.bb/chats/thr_6pwx5dw9f8/tmp/brief-h2.md` |

## Not doing (the research said no)
Event-sourced status; per-step model routing; an architect that drafts graphs from a blank page; automatic promotion of any
autonomy class before N ≥ 20 labeled decisions; more memory notes to writers (the narrow-brief bench arm decides that).
