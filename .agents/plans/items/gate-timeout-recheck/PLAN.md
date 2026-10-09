# Integration gate: recheck load timeouts before calling the batch red

## Incident (2026-10-09, verified by the PM)
The integration gate for lprun_3830fb02731046e89c6d9706ca217fd7 ran at 11:58, while the deploy script ran the full suite on the same Mac mini (load ~10). 7 tests failed, every one with `Error: Test timed out in 5000ms`:
- tests/guard-secret-cli.test.ts
- tests/helper-threads-phase.test.tsx (2 tests)
- tests/host-no-sync-spawn.test.ts
- tests/owned-settings-ui.test.tsx
- tests/realtime-ui.test.tsx
- tests/ui-matrix.test.tsx

Run alone afterwards, all of these files pass (65/65 and 7/7), and the deploy suite at 12:07 was green. The gate still reported «Could not unambiguously identify culprit» and asked the owner what to do: a false red that cost the owner a decision. Log: .agents/plans/items/integration-gate/logs/integration-gate.log.

## Fix
1. In `IntegrationGateRunner.executeGate` (src/rooms/verification/server/integration-gate.ts), after a red result and after the existing environment-failure branch, but before culprit search, add a **timeout recheck**.
   - **When it runs.** Every failing test parsed by extractFailingTests failed with a timeout. Detect «Test timed out in», «Hook timed out in» and similar vitest/jest timeout lines, per failing test, in the output. Put the detection in a small pure exported helper, e.g. `allFailuresAreTimeouts(output, failingTests)`.
   - **What it reruns.** Run the gate once more through the same host `gateRun` call, limited to the failing test files when the command is a vitest/jest run. Append the file paths to the command; vitest/jest treat them as filters, and the existing excludes stay. For any other command, rerun the whole gate command once.
   - **If the recheck passes,** treat the gate as passed: same bookkeeping as the passed branch (reset counters, lastGreenCommit, episode cleared). Record the evaluation as passed with a summary noting `rechecked: timeouts under load` and the list of tests. Log one line `integration-gate: N timeouts passed on recheck (load), gate green`. No fix turn, no owner question.
   - **If the recheck fails** with any non-timeout failure, continue with the normal culprit flow, using the recheck output for the failing tests. If it fails with timeouts again, continue the normal flow with the original output and add a note «timed out twice (also on recheck)» to the PM message.
2. Raise the project's default vitest `testTimeout` to 15000 in vitest.config.ts. UI tests under the deploy suite routinely approach 5 s; several tests already carry per-test 30 s overrides for the same reason. This is only extra headroom, not the fix.

## Checks
In tests/integration-gate.test.ts, add cases with a stubbed host:
- a red gate whose failures are all timeouts, with a recheck that exits 0, leads to passed, sends no tellPm/fix turn, and records the evaluation as passed with the recheck note;
- a recheck that fails with an assertion error leads to the normal culprit path;
- a red gate with mixed timeout and assertion failures gets no recheck;
- a vitest command gets the failing files appended to the recheck command.

Pure tests cover `allFailuresAreTimeouts`.

## Delivery
- [x] Timeout-only integration gate failures are rechecked once, and the default test timeout is 15 seconds — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `cf409c8`.
