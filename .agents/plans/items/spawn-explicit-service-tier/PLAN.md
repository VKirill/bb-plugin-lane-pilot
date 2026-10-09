# Every Lane Pilot thread spawn sends an explicit service tier (no inherited fast mode)

## Incident (verified 2026-10-09 by errand thr_h9wpmtrt7v)
BB remembers execution settings per project in the hub DB table `project_execution_defaults`, which includes the service tier. The row is written whenever the owner creates a new thread from the app composer. Any spawn that passes no service tier inherits it.

BB-сервис had `fast` there since 2026-09-30. In 3 days, 22 Lane Pilot helper threads ran Claude in fast mode: errand, specialist, browser-qa and others, all of which spawn without `serviceTier`. The row was reset by hand. One manual fast chat poisons it again. The owner does not want fast mode unless he turns it on in a chat.

Self-repair and the workflow architect already pass `serviceTier: "default"`. The writer passes its configured tier.

## Fix
Find every Lane Pilot thread spawn: grep `threads.spawn` / `spawnThread` / `threads.create` / `fullAccessSpawn` / `helperChildPlacement` callers. Known files:
- src/rooms/core/server/pm-spawn.ts (central helper spawn)
- src/rooms/qa/server/errands.ts
- src/rooms/qa/server/qa-thread.ts
- src/rooms/council/server/council.ts
- src/rooms/memory/server/memory.ts
- src/rooms/docs/server/docs-nightly.ts
- src/rooms/native-agent/server/activation.ts
- src/rooms/native-agent/server/helper-probe.ts
- src/rooms/self-repair/server/rule-scan.ts
- src/rooms/stability/server/probes.ts
- src/rooms/writer/server/spawn.ts
- specialist spawns

Make each spawn send an explicit tier:
- the configured one when a setting exists (writer.service_tier, docs/memory/onboarding tiers);
- otherwise `"default"`.

The best place is the central helper spawn (pm-spawn.ts), so all helper roles get it. Then check the direct callers. The tier must respect the provider: skip it when the provider has no service tiers, the same way the writer path checks `provider.serviceTiers`. Do not change which tier the existing settings pick.

## Checks
- A unit test: the central helper spawn passes `serviceTier: "default"` when no setting is given, and the configured tier when one is set.
- Spot tests for errand and browser-qa spawn inputs.
- Typecheck.

## Delivery
- [x] Lane Pilot thread spawns now send an explicit configured or default service tier — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `076b2c5`.
