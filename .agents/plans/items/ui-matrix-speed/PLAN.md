# ui-matrix test too slow: times out at 60 s under the integration gate

The integration gate (full suite, log .agents/plans/items/integration-gate/logs/integration-gate.log) failed on tests/ui-matrix.test.tsx > «Lane Pilot UI > shows localized enum labels and stores the original codes»: `Test timed out in 60000ms` (tests/ui-matrix.test.tsx:178). Alone, ui-matrix + realtime-ui took ~100 s and ui-matrix alone runs for minutes, so this test is close to its limit and fails under load. Other tests in the gate also hit 5 s timeouts under load (guard-secret-cli, helper-threads-phase, host-no-sync-spawn, owned-settings-ui, realtime-ui helper squares); they pass alone.

Find why this test is slow (it likely renders every settings row/tab of the full catalog, or waits on findBy* with long polling, or a recent UI change — today: writer fallback slot 3 and the fallback summary in tab-team.tsx that calls `workflow_model_catalog` — added an un-mocked RPC that hangs until timeout). Fix the cause so the test runs well under its limit: mock the new RPC in the test harness if it is missing, render only what the case needs, or split the case. Do not just raise the timeout or skip.

Also check tests/helper-threads-phase.test.tsx «renders verifying writer with distinct dot (no pulse, emerald)»: `expected <span> to be null` (line 65) — an assertion failure, not a timeout; fix if it reproduces alone.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
