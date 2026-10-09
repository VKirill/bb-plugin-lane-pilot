# Make the deploy gate green after today's batch (contract widened)

This redispatches batch-gate-green with owns_paths widened to the two test files the PM approved. Continue from your earlier work in this area.

## Failures to fix (main, full vitest)
1. **Explicit tier lost.** tests/server/architect-start.test.ts and tests/server/self-repair.test.ts: an explicitly configured tier (`"default"`, source `explicit`) is no longer sent when the provider lookup fails. In src/rooms/core/server/pm-spawn.ts, ANY tier given explicitly by the caller or by a setting is always sent. The lookup only decides the implicit default.
2. **Stage expectations after r2.** tests/stages/server-stage.test.ts:
   - Update only the expectations that assert the pre-r2 fallback text or behaviour, so they match fallback-continues-session-r2 (7146912, intended).
   - «spawns one docs child when two polls overlap before threadId is stored» must pass through a code fix if it still fails.
3. **Import boundaries.** tests/architecture/boundaries.test.ts reports new deep imports `entry > writer`, `ui-shell > writer`, `writer > verification`. Import through the room index files instead. Do not raise the baseline.
4. **`writer.skill_pick` editable row.** Make it a real editable row with a consumer key and channel, plus representative values.
   - tests/ui-runtime.test.ts: change only the two literals `toHaveLength(231)` (lines 124, 170) to 232, after the row is wired.
   - tests/applicability.test.ts must pass with consistent counts.

## Check
Run these together:
- architect-start, self-repair, server-stage, boundaries, ui-runtime, applicability;
- spawn-service-tier, writer-skill-pick, opencode-skill-materialize;
- typecheck.

## Delivery
- [x] Restored the deploy gate after the batch by fixing tier, stage, import-boundary, and skill applicability regressions — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `d71d4df`.
