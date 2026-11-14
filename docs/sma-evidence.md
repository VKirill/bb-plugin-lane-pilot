---
title: SMA map — authoring per-node evidence of the four proofs
type: how-to
created: 2026-11-14
updated: 2026-11-14
status: current
confidence: high
tags: [sma-map, evidence, mutation, reach, trace, hollow]
sources:
  - src/rooms/sma-map/evidence/types.ts
  - src/rooms/sma-map/evidence-check.ts
  - src/rooms/sma-map/states.ts
  - scripts/sma-mutate.mjs
---

# SMA map — the four proofs per node

A map node is closed only when four things are proven (sma-parity-tz.md §4), or it is an exception
(`upstream`, `deviation`, `deviation-data`, or `void` with a recorded review):

| proof | what makes it true | where it lives |
|---|---|---|
| `checked` | a behaviour test titled `[sma:<card id>]` | the test; `node scripts/sma-contracts.mjs` regenerates `contracts.ts` |
| `mutated` | a kill attestation of the node's `mutation` spec | `evidence/rNN.ts` + `attest/rNN.json` (written by the runner) |
| `reachable` | its `needs` hold under the hub's settings AND it has an `entry` or a reachable control predecessor | `evidence/rNN.ts` `reach` |
| `outcomeVerified` | checked ∧ mutated ∧ a `trace` newer than the node's change point | `evidence/rNN.ts` `trace`; `provenance.json` |

`--states` also reports `groupObserved` (the old group-level live signal). It is never node evidence.

## Author one node (worked example: n266 «Admission by verdict», region 1)

1. Find the node's gaps: `bb lane-pilot sma-map --gaps --json --region 1` (or `npx tsx scripts/sma-map-db.ts <data.db> --gaps --json --region 1` on a database copy).
2. Read the card's contract test (`grep -rn "sma:av_admission" tests`) and the code it covers.
3. Add ONE line to the node's own region file, `src/rooms/sma-map/evidence/r01.ts` (sorted by node number):

```ts
n266: {
  mutation: flip("packages/workflow-engine/src/verdict.ts", "const blocks = hard >= 1 || high > 5;", "const blocks = hard > 1 || high > 5;"),
  trace: gate("accept", ["passed", "rejected"]),        // what in the hub DB shows THIS node fired with its result
},
// reach is added only when it is needed: n266 is reached from its predecessors (n267, n84). A node a setting gates
// declares it — n169: `reach: via({ "run.max_tokens": isSet() })`; a node an input event enters declares the class —
// n300: `reach: entry("a PM or the owner enqueues a task contract")`.
```

4. `npx vitest run tests/sma-evidence.test.ts tests/sma-traces.test.ts` — rejects an unknown node, a node of another
   region, an unknown setting key, a malformed spec (find not exactly once, `null`/`undefined`/`throw`/empty return in
   the replacement, a deleted body, a test file) and a trace that does not run on the real schema.
5. `npm run sma:mutate -- --node n266` — runs the node's contract tests green, applies the mutation, requires an
   assertion failure, restores the file byte for byte and writes `attest/r01.json`. Results: `killed` (counts),
   `survived` (the test is hollow: strengthen it), `crash` (TypeError/ReferenceError/import error/timeout — not a kill:
   choose a mutation that keeps the result's type and shape), `baseline-red`, `no-tests`.
6. Commit the region file and its attestation together.

## Constructors (`evidence/types.ts`)

- mutation: `flip` (branch turned), `distort` (one field of a successful result wrong), `skipWrite` (one write
  statement dropped), `wrongTarget` (the right action on another row/file/task). `find` is exact text, once in `file`.
- reach: `entry("<class of normal input event>", needs?)`, `via(needs)`; needs values: a word (`"on"`, on/off spellings
  fold), a list of words, `not(words)`, `isSet()`. `notGatedBy: { key: "why" }` dismisses a setting the function reads
  that does not gate the node (silences an `undeclared gate`). `seedEntry` is reserved for the mechanical seed.
- trace: `gate`, `stage`, `receipt`, `transition({from,to,reason})`, `taskField`, `wfRun`, `wfStep`, `part`, `schedule`,
  `settingRow`, `rows(table, clock, where)` (last resort, `lane_pilot_*` only), `kv`, `rpc`, `drill("<scene>")`
  (a passed scene in `.agents/runs/drills/*.json`), `outside("<where>")` (not judged, never counts). Several sources: an array.
- reviews: `hollowAttested: attested(commit, "tests/x.test.ts › title")` (waives hollow sign 6),
  `voidReview: voidStays("why")` or `voidIsHave("where it is served")` (then also change entries.ts).

## Reachability, change points, hollow

- Control links carry reachability: `transition`, `calls`, `retries`, `guards`. Passive nodes (`store`, `document`,
  `screen`) are reachable when a reachable node writes, reads or shows them. Without a database: registry defaults;
  with `--live`: the hub's `*` rows, and per active project (tasks in the window, drill sandboxes left out) the
  projects whose own rows block the node (`blockedIn`).
- Change point: the newest commit touching the node's proof anchor (symbol span by git blame, else the file) or the
  anchor of a direct control predecessor (one hop), mapped to the first deployed version containing it
  (`~/.lane-pilot/deploys.log`). `npx tsx scripts/sma-provenance.ts [--check]` writes `provenance.json`; on the hub a
  change made after the file was generated is dated by the first newer version an attempt ran
  (`lane_pilot_attempt.harness_version`).
- Hollow (§4а): `npx tsx scripts/sma-hollow.ts [--check]` writes the static facts (`hollow-facts.json`); `--hollow --live`
  adds the live signs 2 and 6. On map nodes hollow must reach 0; off-map findings go to the owner's list.

## Regenerate before a deploy

`npm run sma:facts` (hollow facts, provenance, contracts) and `npm run sma:facts:check` to verify; `npm run sma:mutate -- --stale`
refreshes attestations whose file or test changed.
