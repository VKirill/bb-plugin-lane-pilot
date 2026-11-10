# Parity stream d8-providers-money-2 — REPORT

Branch `parity/d8-providers-money-2` in worktree `/home/ubuntu/BB-service/wt/parity-d8-providers-money-2`. All 17 rows implemented with one `[sma:<id>]` contract test each in `tests/sma/parity-d8-providers-money-2.test.ts` (17 tests, all green).

## Rows

| sma | row | what changed |
|---|---|---|
| m_tl_terminal_parity | n1042 | `terminalParity(attempt)` compares the six fixed layers (hooks, memory, rules, skills, permissions, model) between the recorded dispatch context and a terminal session; `bb lane-pilot parity <attempt-id>` |
| k_t_capreg | n1579 | `featureRegistry()` / `featureRegistryGaps()` in `src/rooms/native-install/feature-registry.ts`, derived from the bundled agent catalog, STREAMS and REQUIRED_CAPABILITIES |
| m_tick_deps | n451 | `TICK_DEPS` + `checkTickDeps(services)` in `src/rooms/platform/server/tick-deps.ts`; checked in server.ts after the last `Object.assign`, before the first `scheduleIsolated`; missing names logged at error level and stored under `lp.tick-deps` |
| k_d_ref_gates_inv | n1630 | `GUARD_INVENTORY` (one row per pretask deny and per stream, with matcher/text/switch) + `guardInventoryGaps()` in session-hooks |
| m_cfg_max_turns | n486 | `WRITER_MAX_TURNS=80`, setting `writer.max_turns` (1–500); the silence sweep counts completed tool-call items (event fetch raised to 200) and ends the attempt `turn ceiling N reached`, which the nudge record hands to the watcher as a timeout |
| m_restart_scoped | n484 | `maxTurns` frozen in `run_policy_json` at run creation; the sweep reads the stored policy first, falls back to the live setting |
| k_c_stats | n1226 | `projectStats(db, projectId, days)` in usage/server: phases, plans, requirements (coverageGaps), git metrics, timeline + attemptMetrics; `bb lane-pilot stats [project] [--days N]` |
| m_tl_codex_lane | n1044 | `ThreadUsage.parts` (input/output/cached/total from the last usage event); `accountingPartsProblem` names a missing number in the accounting probe |
| m_lesson | n1048 | accepted attempts' `LESSON:` line files via `upsertLessonProposal` (evidence `accepted attempt <id>`); `LESSON: none - …` files nothing |
| k_wqa_route | n1290 | `qaRoute(receipts)` in contracts/quality-mode: failed→returnable to builder, blocked→not returnable (environment), second failure→stop; used by writer dispatch next-step text |
| m_md_parity | n625 | launch profile parity refuses a provider/model/effort swap: thread stopped, attempt `spawn_rejected` with `writer_provider_unavailable:launch_profile_mismatch:<asked> vs <got>`; `writer.launch_parity=warn` keeps the old warning; LIMIT recognises the reason |
| ar_receipt | n1121 | verification rows record `stdoutSha256`/`stderrSha256`; reverify items get `expectedStdoutSha256`/`stdoutSha256`/`outputChanged`, the summary counts differing outputs; exit code still decides |
| m_mo_fallback | n640 | `WriterHoldDeps.money` — a paid chain member at the money cap is held (`writer_provider_unavailable:money_cap:…`, until next month); subscription lanes unaffected |
| m_md_role_wanted | n628 | `writer.kind_models` narrows `writerPickOverlay` candidates to the kind's profile keys; unlisted kind unchanged, empty pool keeps the project's writer with `kind_pool` exclusion |
| k_t_capgen | n1580 | atlas input carries `capabilities` (registry counts), rendered as a `## Feature capabilities` section and folded into `atlasHash`; `docs/capabilities.snapshot.json` written by the generator and compared by `--check` |
| m_mo_task_ceiling | n641 | `money.holds(providerId, model, hostId, { appetiteTokens })` prices the task at its appetite in output tokens; `walkWriterChain` passes the task's appetite so the estimate applies before an attempt starts |
| m_mo_rule | n633 | `money.strict` in `walkWriterChain`: paid lanes held while a subscription member is free, and held outright while `money.monthly_cap_usd` is unset; off keeps today's order |

## Commits

- `25807f22` rows n1042, n1579, n451, n1630
- `097f5bdc` rows n486, n484
- `02f3279a` the remaining 11 rows, generated atlas docs and `docs/capabilities.snapshot.json`

## Verification

- `npx vitest run tests/sma/parity-d8-providers-money-2.test.ts` — 17/17 pass
- `npx tsc --noEmit -p .` — clean
- `npx vitest run tests/writer-silence.test.ts tests/atlas.test.ts packages/settings-catalog/tests/keys.test.ts` — pass (writer-silence's events.list assertion updated for the 200-event fetch the ceiling needs)
- `npx tsx scripts/generate-atlas.ts --check` — docs/atlas.md, README numbers, docs/map and capabilities snapshot match the code

## Notes and intentional simplifications

- `writer.max_turns` is registered in the settings catalog (keys + channel OWN); it is not added to the generated UI catalog to avoid hand-editing generated rows — it can be set through the normal settings store.
- The turn ceiling counts completed tool-call items from the newest 200 thread events (ponytail: a thread whose newest 200 events hold fewer than the ceiling of calls is still under its ceiling in every realistic pacing; a deeper scan is possible by paging).
- `money.strict` with an unset cap holds paid lanes (strict reading of «the cap is set»); `money.cap_unset_zero` explicitly opt-outs as before.
- `k_c_stats` is exposed as `bb lane-pilot stats`; no new RPC method was added to keep the RPC contract untouched.
- n625 keeps BB's account choice opaque: parity compares provider/model/effort only.
