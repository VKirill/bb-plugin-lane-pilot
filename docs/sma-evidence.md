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

`sma:mutate` regenerates the contract index (`contracts.ts`, `node scripts/sma-contracts.mjs`) before it picks tests, so a
new `[sma:<id>]` test is run; a failure to regenerate stops the run. A `survived` result prints the titles of the tests that ran
and still passed: read them. A test that never touches the mutated line (a wrong anchor) or a symmetric fixture (one acked
and one real item: `acked` → `!acked` changes nothing) is what survives; make the fixture asymmetric.
Mutation runs that spawn processes are slow (region 13 took 12 minutes): run `npm run sma:mutate -- --region N` in the
background, and use `--node` while authoring.

## Before you choose a mutation

- **The anchor is checked, then the mutation.** `bb lane-pilot sma-map --gaps --region N` (or `runSmaMapCli`) prints per node
  the resolved anchor: file, symbol, line count, and a WARNING for an anchor under `tests/` or over 150 lines (a dispatcher).
  `npx tsx scripts/sma-anchor-check.ts --region N` lists nodes whose anchor file no test of the node imports (directly or one
  hop): a hint, not a gate. Compare the anchor in `entries.ts` with what the card's test really exercises; a wrong anchor is
  fixed in `entries.ts`, never mutated. After changing an anchor run `--hollow` for the node again (a big dispatcher pulls
  unrelated `ponytail:` comments in as hollow sign 3).
- **A mutation cannot live under `tests/`** (`lintMutation` refuses it). When the card's behaviour is implemented in
  `tests/helpers/*`, the fix is a pure move to `src/` leaving a one-line re-export shim behind (allowed even past the
  40-line working-code limit). Other regions' nodes anchored at the moved file get their anchor path updated in the same
  commit: an anchor follows a move.
- **Commit moved and new files BEFORE `npm run sma:facts`**: `scripts/sma-provenance.ts` reads HEAD (blame, change points) and
  says so when a file is not in HEAD or the tree has uncommitted paths.
- **A `check`/`gate`/`step` node with «no entry and no control predecessor» needs an authored `entry(...)`**, naming the
  normal input that starts it:

```ts
n1041: { mutation: flip(GUARDS, "if (!read) unread.push(`${method}.${field}`);", "if (read) unread.push(`${method}.${field}`);"),
         reach: entry("the test suite runs") },
```

## Constructors (`evidence/types.ts`)

- mutation: `flip` (branch turned), `distort` (one field of a successful result wrong), `skipWrite` (one write
  statement dropped), `wrongTarget` (the right action on another row/file/task). `find` is exact text, once in `file`.
- reach: `entry("<class of normal input event>", needs?)`, `via(needs)`; needs values: a word (`"on"`, on/off spellings
  fold), a list of words, `not(words)`, `isSet()`. `notGatedBy: { key: "why" }` dismisses a setting the function reads
  that does not gate the node (silences an `undeclared gate`). `seedEntry` is reserved for the mechanical seed.
- trace: `gate`, `stage`, `receipt`, `transition({from,to,reason})`, `taskField`, `wfRun`, `wfStep`, `part`, `schedule`,
  `settingRow`, `rows(table, clock, where)` (last resort, `lane_pilot_*` only), `rpc`, `drill("<scene>")`
  (see «Trace choice»), `kv`, `outside("<where>")` (notes: never counted). Several sources: an array.
- reviews: `hollowAttested: attested(commit, "tests/x.test.ts › title")` (waives hollow sign 6),
  `voidReview: voidStays("why")` or `voidIsHave("where it is served")` (then also change entries.ts).

## Trace choice (a node-level trace)

Pick in this order:

1. **A hub database source** if the node writes a row (`gate`, `stage`, `receipt`, `transition`, `wfRun`, …).
2. **Otherwise a `prove()` line in the region's drill scene**, `trace: drill("sma_rNN")`. This is the route for checks that run in
   the test suite or the publish gate and write no row. It counts only for the node the scene itself proved: the receipt entry of
   the passed scene must list `{node:"n1036", ok:true, detail:"…"}`. A scene that merely passed proves nothing for anyone, and a
   `prove(..., False, ...)` fails the scene with a problem line naming the node.
3. `kv()` and `outside()` are **notes and never close a node** (KV has no timestamp to compare with the change point; `outside`
   is not judged). A node whose effect lives in KV or in a file on a machine closes through a `prove()` line in its region scene.

### The region scene `sma_rNN.py` in scripts/lp_drill/scenes

A file named `sma_rNN.py` (NN = two-digit region) is found by its name: no shared list is edited, and it is not part of `--quick`
or the default run. `scripts/lp_drill/scenes/sma_r13.py` (+ `sma_r13_probe.ts`) is the worked example: eight pure-check nodes.

```python
NODES = ["n1036", "n1037"]                      # what the scene proves
def scenario_sma_r13(tmp):                       # tmp: a scratch folder
    proofs = Proofs()                            # from lp_drill.prove import Proofs
    proofs.prove("n1036", result == expected, f"leak scan returned {result}")   # write the observed value, not «ok»
    return proofs.verdict("sma_r13")
```

- Add a node: append it to `NODES`, run its real check, `proofs.prove(node, ok, detail)` with the result the card expects, put
  `trace: drill("sma_rNN")` on its line in `evidence/rNN.ts`. A node is proved once per scene. Keep the file self-contained
  (import what you use from `lp_drill.*`; do not share names with another region's scene).
- Run: `scripts/lp-drill.sh --scenario sma_r13` (one), `scripts/lp-drill.sh --suite sma` (all that exist), add `--dry-run` to
  list what a scene proves without running it. Region scenes need no sandbox, hub write or lock, so agents run them in parallel;
  each run writes its own receipt.
- **Prefer deterministic, model-free paths**: a CLI call, an RPC, a database read, a refused dispatch, the real check of the
  checked-out commit. A model turn only when the node itself is a model step.
- The receipt is judged where the owner measures: after a run the drill copies it to the hub's plugin folder
  (`~/Documents/BB-сервис/plugins/bb-plugin-lane-pilot/.agents/runs/drills/`, over the ssh channel `hubsql` uses;
  `LP_DRILL_HUB_RECEIPTS=<abs path>|off`). A failed delivery is a problem line in the receipt and the log, not a silent skip.
  `bb lane-pilot sma-map --states --live` reads the receipts from the plugin's own root, whatever the current directory.

## Reachability, change points, hollow

- Control links carry reachability: `transition`, `calls`, `retries`, `guards`. Passive nodes (`store`, `document`,
  `screen`) are reachable when a reachable node writes, reads or shows them. Without a database: registry defaults;
  with `--live`: the hub's `*` rows, and per active project (tasks in the window, drill sandboxes left out) the
  projects whose own rows block the node (`blockedIn`).
- Change point: the newest commit touching the node's proof anchor (symbol span by git blame, else the file) or the
  anchor of a direct control predecessor (one hop), mapped to the first deployed version containing it
  (`~/.lane-pilot/deploys.log`). `npx tsx scripts/sma-provenance.ts [--check]` writes `provenance.json`; on the hub a
  change made after the file was generated is dated by the first newer version the hub ran: the earliest time any record stamps
  it (`lane_pilot_attempt.harness_version`, `lane_pilot_wf_run.harness_version` of the upkeep graphs, `lane_pilot_memory_probe.lp_version`),
  so a fresh deploy counts without waiting for a task. A version no record shows stays `unshipped` and no trace counts for it.
- Sign 2 on a workflow edge: an edge out of start is walked when its target has an entry step (any state); an edge into the end when a
  step of its source has an `exit` event; an edge into a join when a branch result arrived from its source. These records carry no
  condition, so two edges of one source and one kind are told apart only when none was walked: otherwise the finding says it cannot tell.
  `--hollow` and `--states` print the span the data covers next to the requested days: a young database is not an idle graph.
- Hollow (§4а): `npx tsx scripts/sma-hollow.ts [--check]` writes the static facts (`hollow-facts.json`); `--hollow --live`
  adds the live signs 2 and 6. On map nodes hollow must reach 0; off-map findings go to the owner's list.

## Proofs in a sibling repository

A node whose proof anchor is `core:<path>` (the BB core, vk layer) or `telegram:<path>` (the owner's plugin
bb-plugin-telegram-projects) needs the same four proofs. Its test and its mutated code live in that repository; its evidence line,
attestation and trace live here. Worked examples: n560 `m_ce_recover` (core, `evidence/r06.ts`) and n971 `m_tg_split` (telegram,
`evidence/r10.ts`).

**Where a sibling is** (`src/rooms/sma-map/siblings.ts`, the one place every tool asks): `SMA_SIBLING_CORE` /
`SMA_SIBLING_TELEGRAM` first (`off` or a missing path makes the sibling absent and never falls through), then the proofs worktree
`~/.lane-pilot/worktrees/<repo>/sma-proofs`, then the shared checkouts (`~/.local/share/bb-source-vk`, `~/BB-service/bb-core/vk`,
`~/BB-service/bb-plugin-telegram-projects`). The tools only read the shared checkouts. If a sibling resolves nowhere, every tool
says «sibling repository <repo> is not on this machine» for the nodes that need it: the node is not mutated (never a pass), and
the command still runs. On the hub there are no sources: the committed facts and attestations are what it uses.
`npm run sma:sibling -- status` prints where each sibling resolves, its HEAD and the pins.

**Setup (once per batch):**

```sh
npm run sma:sibling -- setup core --id <batch>       # ~/.lane-pilot/worktrees/bb-core/<batch> on sma/core-proofs-<batch>
export SMA_SIBLING_CORE=$HOME/.lane-pilot/worktrees/bb-core/<batch>
npm run sma:sibling -- setup telegram --id <batch>   # …/bb-plugin-telegram-projects/<batch> on sma/proofs-<batch>
export SMA_SIBLING_TELEGRAM=$HOME/.lane-pilot/worktrees/bb-plugin-telegram-projects/<batch>
```

The new branch is cut from `sma/core-proofs` / `sma/proofs` when it exists (so the proofs already written are there), else from
`vk/experimental` / the plugin's HEAD. Dependencies come offline from the machine's store. Core: `pnpm install --frozen-lockfile
--offline` (every workspace package gets its own `node_modules`), `scripts/ensure-native-modules.mjs`, and a turbo build of
`@get-bb/plugin-sdk` (plugins resolve the SDK through its dist; turbo's cache makes it instant). Telegram: `npm ci --offline`.
Measured on OVH under load: a fresh core worktree is ready in **13 s** (install 12 s), a fresh telegram one in **2.3 s**; re-running
setup on an existing worktree only installs (core 4 s, telegram 2 s). Without the id, setup makes or refreshes the shared proofs
worktree `sma-proofs`.

**The test** goes into the sibling and is committed there, on the worktree's branch. The index reads sibling tests from git at a
commit, so an uncommitted test is invisible.
- core: beside the code, in the package that owns it, picked up by that package's `vitest.config.ts` (for example
  `plugins/provider-retry/src/retry-policy.sma.test.ts`). It must pass with `pnpm exec vitest run <file>` from that package.
- telegram: `test/<name>.test.ts`, node:test (`import { test } from "node:test"`, `node:assert/strict`). It must pass with
  `npx tsx --test test/<name>.test.ts` from the root.
- The title carries `[sma:<card id>]` and the test checks the card's result, as for a local node. Follow the sibling's own rules:
  bb-core `AGENTS.md`/`VK_PATCHES.md` (the vk layer records its changes; a test-only commit adds no patch entry).

**The evidence line** uses the prefixed path, nothing else changes:
`n560: { mutation: flip("core:plugins/provider-retry/src/retry-policy.ts", "if (!isUnavailableFailure(failure))", "if (isUnavailableFailure(failure))") }`.
A spec may not point at a sibling test file. With the sibling present, `lintMutation` checks that the text occurs exactly once
there; without it, only the static checks run.

**Index and run:**

```sh
node scripts/sma-contracts.mjs                       # picks up core:/telegram: tests at the sibling's HEAD
npm run sma:mutate -- --node n560                    # mutates in $SMA_SIBLING_CORE, runs the sibling's runner there
```

The runner (`scripts/sma-mutate.mjs`, commands and report readers in `src/rooms/sma-map/mutation-run.ts`) runs vitest from the
package that holds the test for the core, and `tsx --test --test-name-pattern` with the JUnit reporter from the root for telegram.
Both filter to the `[sma:<id>]` title. The verdicts are the same as for a local node (an assertion kills; a TypeError, import error
or timeout is `crash`). Restoring is the same: finally, signals, exit, and a journal that the next run restores after `kill -9`.
Each sibling checkout has its own lock. **It refuses to write anywhere but a linked worktree under
`~/.lane-pilot/worktrees/<repo>/`**: the shared checkouts (the core is built and deployed from `~/BB-service/bb-core/vk`), a
repository's main checkout, a path with `..` and a symbolic link out of the worktree are all refused (`refuseMutation`). One
mutation run, measured on OVH: core **1.6 s** for the mutated vitest run, 4.7 s for the whole command; telegram **0.8 s** and 3.1 s.
The attestation records the sibling and its commit (`sibling`, `siblingCommit`) and the content hashes of the mutated file and the
test files, which carry their prefix. In a source checkout a sibling attestation is judged against that sibling's files:
`--stale` lists it when either file changed, and if the sibling is absent the node is not mutated.

**`--check` and the hub.** `contracts.ts` records the sibling tests with the pin they were read at (`SMA_SIBLING_TESTS_AT`), and
`provenance.json` records the sibling change points with `siblingsAt`. Generating moves a pin to the sibling's HEAD only when HEAD
contains the old pin. `--check` re-reads at the pin, so the result does not depend on the branch the checkout has out. If the
sibling is absent or lacks the pinned commit, its recorded lines are kept and a note says so: the files stay valid on the hub, and
the deploy gate on OVH, where both siblings exist, re-reads them.

**Change point.** For a sibling node it is the newest commit touching the anchor's span in the sibling (git blame at the pin: the
declared unit, the block a text anchor opens, else the file's last commit). The hub cannot date when it started running that
commit. `bb plugin list --json` gives each plugin's version (telegram-projects 0.5.2, disabled, while the repository is at 0.12.0),
and the core's version is the runtime folder (`bb-server-runtime-0.48.1-vk.6`). Neither carries an install time, and
`lane_pilot_attempt.harness_version` is this plugin's version, not theirs. So the rule is: a trace older than the sibling commit
never counts, and a newer one does. `--states` prints «closed with an unknown sibling change point: N», so these closes stay a
visible number.

**Trace.** The effects live in `bb.db` (core) or in the Telegram plugin's `data.db`, and this plugin reads neither (no
cross-database SQL). The route is a `prove()` line in the region scene, `trace: drill("sma_rNN")`, that sees the behaviour through
the `bb` CLI or a plugin RPC against the hub's sandbox project (`LP sandbox OVH (drill)`). When the hub is unreachable the scene
does not call `prove()` for that node and lists it under `notProved` (the pattern of `sma_r15.py`: `not_proved[node] = "needs the
hub: …"`, `proofs.verdict(name, notProved=not_proved)`). There is no second trace constructor (thread/event reads through the plugin
host's SDK) yet: one needs a read that carries a time and a negative test, and was not built in this round. A telegram node can only be traced while `telegram-projects` is enabled on the hub
at a version that has the change: `--gaps` says so. The two worked examples leave the trace open: n560 would need a turn cut off
by a dropped stream, and n971 needs the plugin enabled.

**`--gaps` / `--hollow`** list a sibling node like any other. Under it: the repository, the anchor and its size (or that the
sibling is absent), the `[sma:]` tests already there, whether the hub must enable a plugin, and the next command.

**What is committed where.** The sibling commit is the test only, on `sma/core-proofs[-<batch>]` (bb-core, cut from
`vk/experimental`) or `sma/proofs[-<batch>]` (telegram). Do not push, do not touch the shared checkout, do not deploy the core.
Here: the evidence line, `attest/rNN.json`, and the regenerated `contracts.ts`/`provenance.json`. A batch branch of the sibling is
merged into `sma/core-proofs` / `sma/proofs` before this repository's branch lands, so the pins stay reachable from the proofs
worktree that the deploy gate reads.

## Regenerate before a deploy

`npm run sma:facts` (hollow facts, provenance, contracts) and `npm run sma:facts:check` to verify; `npm run sma:mutate -- --stale`
refreshes attestations whose file or test changed.
