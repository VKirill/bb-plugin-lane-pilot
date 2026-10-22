---
title: Twins against the real thing
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, tests, doubles, q13]
sources:
  - src/rooms/twins/logic.ts
  - scripts/record-real-shapes.ts
  - tests/twins.test.ts
---

# Twins against the real thing (SMA Q13, agent rule 4)

«A double may do less than the library, never otherwise.» Tests answer in place of BB with doubles (a thread, the providers, the plugins).
`scripts/record-real-shapes.ts` records the shape of the real answers — keys and value types, never the values — into
`tests/fixtures/real-shapes/*.json`. `tests/twins.test.ts` then fails when:

- a shared twin (`tests/fixtures/twins.ts`) or any `stub("threads.get" | "providers.list" | "plugins.list", …)` in any test names a key the
  real answer does not have, or gives another type (a double may leave keys out);
- a record is more than a year old: record the real system again (`npx tsx scripts/record-real-shapes.ts`).
