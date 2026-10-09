# Fix: explicit service tier must not break helper spawns when providers.list fails

This is a redispatch of spawn-tier-best-effort-v2. Its sticky area writer ran on a provider that is out of quota. It is a new area, so a fresh writer takes it.

## Problem (deploy gate, 2026-10-09, reproduced in isolation)
Since spawn-explicit-service-tier (commit 076b2c5), helper spawns call `bb.sdk.providers.list` to check whether the provider has service tiers. Six tests now fail consistently, with `bb.sdk.providers.list is not stubbed`:
- tests/errands.test.ts: «wait_errand returns blocked repo_edited…»;
- tests/main-agent-spawn.test.ts: «puts the saved edited profile on the actual MAIN spawn…»;
- tests/remote-git-detect.test.ts: «an errand helper's stray file … found through the host»;
- tests/run-budget.test.ts: 3 tests.

In production, an error or timeout from the provider list would abort a helper spawn the same way. Start with the helper spawn in src/rooms/core/server/pm-spawn.ts and the direct spawns that 076b2c5 changed (`git show 076b2c5 --stat`).

## Fix
- The tier lookup is best-effort. When `providers.list` throws or the provider is not in the list, the spawn still proceeds:
  - an explicit tier configured for the role or by a setting is passed;
  - otherwise `"default"` is passed only when the provider is known to have tiers.
- When the lookup fails, send no tier, as before the change, and log one warn line.
- Cache the per-host provider list for about 60 s.
- Do not edit the six tests: they must pass as they are.
- Extend tests/spawn-service-tier.test.ts with three cases:
  - providers.list throws → the spawn succeeds with no tier;
  - the provider has no tiers → no tier;
  - the provider has tiers → `"default"`.

## Delivery
- [x] Provider service-tier lookup failures no longer prevent helper spawns — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `9b1b8ca`.
