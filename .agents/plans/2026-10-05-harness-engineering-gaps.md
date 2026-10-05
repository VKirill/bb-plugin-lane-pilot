# Harness engineering gaps — follow-up plan

Source analysis: `.bb/chats/thr_kpymk3syj8/artifacts/harness-engineering-gap-analysis.md`.

## Completed (run lprun_a09b70b8c84744e9804b1774ccd4b1c0)
- [x] `lp-pm-tool-observations` — structured tool failures `{ok:false,error:{code,retryable,sideEffects}}` + `<outside_data>` fence for browser/errand/specialist/council text to the PM.
- [x] `lp-run-budget-enforcement` — children budget wired, wall/token budget checked mid-run, budget stop is its own uncharged outcome; dead `timeout` state resolved.

## Waiting for owner decision
- [ ] **Harness eval / replay**: fixed set of past accepted tasks replayed against a candidate LP version in a sandbox project; metrics first-try acceptance, attempts, tokens, wall time. Needs: which projects' tasks may be replayed, token budget per eval.
- [ ] **Containment of writers/critics**: read-only spawn for critics, per-role bb-bridge tool filter (no `env_get` for writers), verify sandbox without machine env forwarding / with read deny for `~/.ssh`. Needs BB core (VK) work; decide what writers must keep (npm install, test DB secrets).
- [ ] **Code critique default on** for risk ≥ medium (check `critic_stats` first).
- [ ] **Automatic browser QA** for `page:*` tasks when the project declares a dev server.
- [ ] **Non-idempotent verification**: `verification[].idempotent:false` disables the flaky re-run.
