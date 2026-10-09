# Last three red tests on main block the Lane Pilot deploy (contract widened: docs/adoc-applicability.md)

Writer's questions answered:
- Yes, record the `writer.skill_pick` row (and any other missing editable row, e.g. writer.fallback3.*) in `docs/adoc-applicability.md`, now owned; it is the data the applicability test reads.
- Fallback continuation prompt: keep the current behaviour. A continuation must NOT get the «Fallback writer: … do the whole task from the contract» line; it contradicts the handoff brief. Update the emergency-provider test in tests/stages/server-stage.test.ts to assert the handoff brief and stop reason are in the prompt, the «do the whole task» line is not, and the accepted receipt still records the emergency provenance (providers, models, trigger). Keep coverage of the old line only for a fallback that really does not continue a session.
Continue from the previous attempt's work if its worktree is offered.

## Failures (log /tmp/lp-deploy-tests.rerun.log)
1. tests/applicability.test.ts:111 — `{editable: 231}` expected 232: the catalog has a row the applicability doc does not record.
2. tests/stages/server-stage.test.ts — emergency-provider test (above).
3. tests/stages/server-stage.test.ts:925 — `attaches a spawned docs child after crash before threadId persist and does not spawn again`: stage 'passed', expected 'running'. Find which of today's changes caused it (cancel-stops-stage-threads, the self-repair cancel fix, writer-quota-silence) and fix the cause.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
