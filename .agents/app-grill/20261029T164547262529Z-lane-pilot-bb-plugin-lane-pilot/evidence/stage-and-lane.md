# Source excerpts (revision 2896006b)

Runtime was not exercised in this audit. Lines below are the current tree, read 2026-10-29.

## Default plan critique is a gate

`src/rooms/core/server/core.ts` sets `plan_critique.enabled` to true and `plan_critique.mode` to `gate` when unset.

`packages/contracts/src/stage-proof.ts` still labels `plan-critique` as `kind: "advisory"`.

`workflows/lp-task-pipeline.json` routes `allowed === false` to `block-plan-critique`, which blocks the attempt before the writer node.

## PM-read "decides nothing", then blocks

`stage-proof.ts` reason for `pm-read`: "it only hands context to the critics and decides nothing".

`src/rooms/writer/server/dispatch-workflow.ts` `lp.block-pm-read` records skipped writer stages, `transitionAttempt(..., "blocked")`, `setRunState(..., "blocked")`.

`tests/workflow/equivalence.test.ts` expects malformed PM-read output to end `state: "blocked"`.

UI fallback for `pm_read.enabled` is false (`team-model.ts`). The block applies only when the owner turns the stage on.

## Checks run, then run again

`src/rooms/writer/server/finish.ts` after a candidate is already accepted:

- `runPlanFactStage` re-reads `verification[].exitCode` and the diff.
- `gitIntegrate` is called with `replayChecks` built from the same `task.verification` commands.
- Comment in that function: Vampirism Fire 2026-10-25, tasks reported stuck 47–63 minutes, each in a 7–18 minute replay of `studio_test` after green checks.

`quality-mode.ts`: quick turns off plan critique and code critique only. It does not mention the merge replay.

`src/rooms/phase/server/driver.ts` close refusal tells the PM: "If the work is in fact small, plan it as one or two pieces — the stages pass quickly then."

## Claude Lane inside the plugin

`tests/sma-map.test.ts` asserts 1798 nodes and 2654 links, and that every proof path exists. Roots include `~/tools/claude-lane-stack` and `~/.local/share/bb-source-vk`.

`src/rooms/sma-map/entries.ts` header: a proof link is navigation, not a behaviour check. 377 entries cite `lane-stack:`.

`src/rooms/native-agent/native-session-hooks.ts` writes bundled `guard_shell.py` and, if no project hook already matches `*` and that file, adds it for every tool.

`src/rooms/native-agent/bb-shim.ts`: deny list must stay equal to `_bb_args_error` in `lane-stack/hooks/guard_shell.py`.

`src/rooms/writer/server/skill-materialize.ts`: OpenCode writers get skill symlinks because Lane Stack's opencode-lane guard loads only those. `skill-pick.ts`: pick is on unless set off; deadline 45s; failure leaves role skills (`writer-practices`, `karpathy-guidelines` in `helper-context.ts`).

## Second pass (Lane Pilot 9fc31e88, Claude Lane 5f1dff1)

`bin/pipeline_stages.py` line 218 is `"mode": "advisory"`. Lane Pilot `core.ts` uses `?? "gate"`. Catalog row `s074` says default `gate` and cites that Python line.

`gate-detect.ts` finds `npm test` when `integration.gate_command` is empty. `finish.ts` `noteMergedForGate` runs the gate when the project's queue is empty. `integration-gate.ts` rechecks when every failure is a timeout.

`plugins/lane-stack/hooks/hooks.json`: SessionStart runs `winnow serve --ensure` with timeout 600; UserPromptSubmit runs skillranker. `plugin.json` description: Solo PM conveyor. `hooks/guard_shell.py` is 2069 lines and lists Lane Pilot roles.

`SELF_REPAIR_DEFAULTS.enabled` is true (`self-repair.ts`). The repair prompt excludes the claude-lane-stack copy of the guard.

GitNexus: no index for Lane Pilot. `claude-lane-stack` index commit matches HEAD. Graph was not queried; the contradictions are in the files above.
