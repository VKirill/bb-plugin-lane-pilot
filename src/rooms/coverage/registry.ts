/**
 * The registry of what proves what (SMA D1-5, «not covered, with reason»). Every pipeline stage, attempt transition, failure class, gate,
 * memory path, room and key mechanism of Lane Pilot has an entry here that says
 *  - `live`: the deploy-drill scenarios (scripts/lp-drill.py) that run it on the hub by design, with `via` saying how; or
 *  - `tests`: the test files that exercise it, and `reason`: why no drill scenario does (a gap named is a gap that can be closed); or
 *  - neither, and `reason` says why it is not covered at all.
 * tests/coverage.test.ts fails when a stage, transition, failure class, gate, memory path or room has no entry (or an entry names a node
 * that is gone), when a drill scenario or a test file named here does not exist, and when a «live» claim has no drill scenario. A drill
 * receipt records what the run left on the hub (`seen`); `bb lane-pilot coverage --receipt <file>` checks the claims against it.
 */
export const NODE_KINDS = ["stage", "transition", "failure_class", "gate", "memory_path", "room", "mechanism"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type CoverageEntry = {
  kind: NodeKind;
  /** The nodes this entry covers; `from+event` for a transition (∅ for a new attempt). */
  ids: readonly string[];
  /** Drill scenarios that run it live, by design. */
  live?: readonly string[];
  /** How the drill exercises it. */
  via?: string;
  tests?: readonly string[];
  /** Required unless the entry is live: why no drill scenario covers it. */
  reason?: string;
};

const STAGE_SUITE = ["tests/stages/server-stage/part1.test.ts", "tests/stages/server-stage/part2.test.ts", "tests/stages/server-stage/part3.test.ts", "tests/stages/server-stage/part4.test.ts"];
const SANDBOX_OFF = "the sandbox project the drill runs in has this stage off, so every drill run records it skipped";

export const COVERAGE: readonly CoverageEntry[] = [
  // ── stages (STAGE_IDS) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  { kind: "stage", ids: ["writer-agent"], live: ["parallel3", "conflict", "main_moved", "provider", "provider_limit", "reload", "nogit", "nogit_repo"], via: "every drill task is written by a real writer and passes the owns-paths and validate gates", tests: ["tests/dispatch-idempotent.test.ts", "tests/parallel-writers-own-worktree.test.ts"] },
  { kind: "stage", ids: ["acceptance-receipt"], live: ["parallel3"], via: "each accepted drill task ends with an acceptance-v2 receipt that validates against the schema", tests: ["tests/acceptance-v2.test.ts"] },
  { kind: "stage", ids: ["plan-fact"], live: ["parallel3"], via: "the writer closes its answer with the plan-fact table and the blind check passes (3 of 3 in the 2026-10-22 quick drill)", tests: ["tests/plan-fact.test.ts"] },
  { kind: "stage", ids: ["memory-maintenance"], live: ["parallel3"], via: "the memory helper runs after each accepted drill task and its candidates pass the schema check", tests: ["tests/stages/memory.test.ts"] },
  { kind: "stage", ids: ["project-life"], live: ["parallel3"], via: "runs after the accepted task; it often fails on the hub (60 of 96 receipts of drill tasks) and never blocks the task, so the drill proves it starts, not that it passes", tests: ["tests/stages/project-life.test.ts"] },
  { kind: "stage", ids: ["verification"], tests: ["tests/dispatch-verification-check.test.ts", "tests/check-timing.test.ts"], reason: "drill tasks carry verification: [], so the stage passes with no command to run (the verification gate was skipped for 3 of 4 tasks in the 2026-10-22 quick drill); give a drill task a real check to make this live" },
  { kind: "stage", ids: ["pm-read"], tests: ["tests/stages/pm-read.test.ts", "tests/stages/read-first.test.ts"], reason: SANDBOX_OFF },
  { kind: "stage", ids: ["plan-critique"], tests: ["tests/critic-stats.test.ts", "tests/cancel-stage-threads.test.ts", "tests/stages/critique-policy.test.ts"], reason: SANDBOX_OFF },
  { kind: "stage", ids: ["specialist-review"], tests: ["tests/stages/specialist.test.ts", "tests/pipeline-proof.test.ts"], reason: SANDBOX_OFF },
  { kind: "stage", ids: ["run-gate"], tests: [...STAGE_SUITE, "tests/pipeline-proof.test.ts"], reason: "its receipt is written only for an explicit pre-merge review gate; no drill project sets one" },
  { kind: "stage", ids: ["code-critique"], tests: ["tests/stages/code-critique.test.ts"], reason: "the code critic is off by default (critic.code.default_for_risk=off) and the sandbox does not turn it on" },
  { kind: "stage", ids: ["browser-qa"], tests: ["tests/stages/browser-qa.test.ts"], reason: "needs a dev server and a browser host; the sandbox project has neither" },
  { kind: "stage", ids: ["docs-maintenance"], tests: ["tests/stages/docs.test.ts", ...STAGE_SUITE], reason: "a nightly pass on its own schedule, off in the sandbox" },
  { kind: "stage", ids: ["onboarding-preview", "onboarding-apply"], tests: ["tests/stages/onboarding.test.ts", "tests/stages/onboarding-host.test.ts", ...STAGE_SUITE], reason: "no tool starts it since 0.1.341 (its PM tools were removed); kept for old receipts; it was a one-time pass when a project is first adopted; the drill's projects are already onboarded" },
  { kind: "stage", ids: ["night-review", "night-fix", "workspace-status"], tests: ["tests/stages/night.test.ts", "tests/stages/night-fix.test.ts", ...STAGE_SUITE], reason: "the night stages run after the day's accepted tasks and are off in the sandbox" },
  { kind: "stage", ids: ["opencode-telemetry"], tests: ["tests/stages/opencode-telemetry.test.ts"], reason: "runs only for an OpenCode writer; the drill's writers are claude-code and codex" },
  { kind: "stage", ids: ["gate-triage"], tests: ["tests/stages/gate-triage.test.ts"], reason: "a helper triages a gate failure; no drill task fails a gate on purpose" },

  // ── attempt transitions (TRANSITION_TABLE) ───────────────────────────────────────────────────────────────────────────────────────
  { kind: "transition", ids: ["∅+form_task", "queued+spawn_called", "spawn_requested+spawn_ok", "running+checks_passed"], live: ["parallel3"], via: "the happy path of every drill task", tests: ["tests/state-machine-enforce.test.ts", "tests/pipeline.test.ts"] },
  { kind: "transition", ids: ["running+cancel", "cancel_requested+cancel_observed"], live: ["memory_paths"], via: "the probe's writer is cancelled once its thread exists, and quiet() cancels what a scenario leaves running", tests: ["tests/state-machine-enforce.test.ts", "tests/cancel-stage-threads.test.ts"] },
  { kind: "transition", ids: ["spawn_requested+spawn_explicit_error", "spawn_rejected+retry_exhausted"], live: ["provider_limit"], via: "a writer model that does not exist is refused at spawn and that attempt ends blocked; a new attempt on the next writer is accepted (hub: 9 of 9 provider_limit tasks)", tests: ["tests/state-machine-enforce.test.ts", "tests/writer-fallbacks.test.ts"] },
  { kind: "transition", ids: ["spawn_rejected+retry"], tests: ["tests/state-machine-enforce.test.ts", "tests/pipeline.test.ts"], reason: "a rejected spawn is not retried inside the same attempt: provider_limit ends it blocked and hands the task to the next writer as a new attempt, so no scenario drives this move" },
  { kind: "transition", ids: ["spawn_requested+spawn_network_error", "spawn_unknown+reconcile_found", "spawn_unknown+reconcile_not_found", "spawn_unknown+reconcile_ambiguous", "spawn_unknown+reconcile_error"],
    tests: ["tests/state-machine-enforce.test.ts", "tests/reconcile.test.ts"], reason: "a spawn whose answer is lost happens only when the network or a reload hits that instant; the reload scenario reaches it by chance, not by design" },
  { kind: "transition", ids: ["provider_error+retry_exhausted", "timeout+retry_exhausted", "empty_output+retry_exhausted", "validation_failed+retry_exhausted"],
    tests: ["tests/state-machine-enforce.test.ts", "tests/retry-budget.test.ts"], reason: "needs a task that fails its allowed attempts; the drill's tasks are trivial and every scenario ends accepted" },
  { kind: "transition", ids: ["running+provider_error", "running+wait_timeout", "running+empty_output", "running+validation_failed", "provider_error+retry", "timeout+retry", "empty_output+retry", "validation_failed+retry"],
    tests: ["tests/state-machine-enforce.test.ts", "tests/failure-class.test.ts", "tests/pipeline.test.ts"], reason: "the failures of a running writer (provider error, timeout, no output, a red check) are not provoked by any scenario: provider_limit stops the writer before it runs, and the drill's tasks carry no check to fail" },

  // ── failure classes (FailureClass) ───────────────────────────────────────────────────────────────────────────────────────────────
  { kind: "failure_class", ids: ["merge"], live: ["conflict", "main_moved"], via: "two tasks rewrite the same line, and main moves under a working writer: the merge is redone for free", tests: ["tests/failure-class.test.ts"] },
  { kind: "failure_class", ids: ["provider"], live: ["provider_limit"], via: "a writer model that does not exist ends the attempt as writer_model_unavailable, a provider failure; the next writer takes the task (hub: 9 of 9 provider_limit tasks)", tests: ["tests/failure-class.test.ts", "tests/writer-fallbacks.test.ts"] },
  { kind: "failure_class", ids: ["limit"], tests: ["tests/failure-class.test.ts", "tests/writer-fallbacks.test.ts"], reason: "a provider's plan or usage-window notice; provider_limit uses a model that does not exist, which is the provider class, and the drill cannot make a real provider run out of quota" },
  { kind: "failure_class", ids: ["task", "judgment", "contract"], tests: ["tests/failure-class.test.ts", "tests/jev/failure-class.test.ts"], reason: "classes of a failing task: the drill's tasks do not fail their own checks, the PM never needs a human answer, and a bad contract is refused before an attempt exists" },
  { kind: "failure_class", ids: ["dirty_base", "harness", "infra", "budget", "reassign"], tests: ["tests/failure-class.test.ts", "tests/reassign-task.test.ts"], reason: "each needs a fault the drill must not cause on the owner's machines (a dirty base checkout, a full disk, an internal error, an exhausted run budget, a PM reassignment)" },

  // ── gates (GATE_CATEGORIES) ──────────────────────────────────────────────────────────────────────────────────────────────────────
  { kind: "gate", ids: ["owns-paths", "validate", "accept"], live: ["parallel3", "conflict", "main_moved"], via: "every accepted drill task passes the three gates (3 of 3 each in the 2026-10-22 quick drill); the rejecting side is tests only", tests: ["tests/gate-detect.test.ts", "tests/owns-overlap.test.ts", "tests/stages/gate-report.test.ts"] },
  { kind: "gate", ids: ["verification"], tests: ["tests/dispatch-verification-check.test.ts", "tests/check-timing.test.ts"], reason: "drill tasks carry verification: [], so the gate is skipped (3 of 4 tasks in the 2026-10-22 quick drill) or passes with nothing to run" },

  // ── rooms (src/rooms/<room>) ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { kind: "room", ids: ["writer", "runs", "storage", "core", "contracts", "host-worker", "tasks", "verification", "tools"], live: ["parallel3"], via: "the code path of every drill task: dispatch-bb, contract lint, the writer, the gates, the state machine, the host calls", tests: ["tests/pipeline.test.ts"] },
  { kind: "room", ids: ["deferral"], live: ["deferrals"], via: "the scenario reads the register over RPC and fails on an overdue entry or a bad skip citation", tests: ["tests/deferral-register.test.ts"] },
  { kind: "room", ids: ["memory", "memory-probe"], live: ["memory_paths"], via: "the probe plants a token through the write door and checks every delivery path, then the real writer brief and PM prompt", tests: ["tests/memory-paths.test.ts"] },
  { kind: "room", ids: ["native-agent"], live: ["helper_providers", "provider"], via: "one helper per provider in use, and the worktree provider of the writer", tests: ["tests/native-run.test.ts"] },
  { kind: "room", ids: ["night-graphs"], reason: "the night jobs (rules scan, wall hunters, harness editor) run as graphs on their own night crons, which are off in the sandbox", tests: ["tests/night-graphs/rules-scan.test.ts", "tests/night-graphs/wall-hunt.test.ts", "tests/night-graphs/harness.test.ts"] },
  { kind: "room", ids: ["stability"], live: ["reload"], via: "a plugin reload while a writer works: the task still ends accepted", tests: ["tests/reconcile.test.ts"] },
  { kind: "room", ids: ["settings"], live: ["provider_limit"], via: "the scenario sets writer.model through the settings RPC and puts it back", tests: ["tests/owned-settings.test.ts"] },
  { kind: "room", ids: ["project-life"], live: ["parallel3"], via: "the project-life stage runs after each accepted drill task", tests: ["tests/stages/project-life.test.ts"] },
  { kind: "room", ids: ["acceptance"], tests: ["tests/plan-fact.test.ts", "tests/acceptance-card-ui.test.tsx"], reason: "the acceptance card is a screen read; no drill opens a screen" },
  { kind: "room", ids: ["anamnesis", "learning"], tests: ["tests/anamnesis/card.test.ts", "tests/learning/digest.test.ts"], reason: "they read the owner's own messages and run on their own schedules; the sandbox has none" },
  { kind: "room", ids: ["improvement"], tests: ["tests/improvement/hub.test.ts", "tests/improvement/improvement-ui.test.tsx"], reason: "a settings screen and the rows behind it: no drill opens a screen, and the readers it feeds (wall, bench, push) are covered by their own rooms" },
  { kind: "room", ids: ["bench", "memory-eval"], tests: ["tests/bench/runner.test.ts", "tests/memory-eval.test.ts"], reason: "replay real tasks and score memory over hours and tokens on hub data; too slow and too dear for a pre-deploy drill (the bench is its own gate for harness changes)" },
  { kind: "room", ids: ["council", "world", "world-assets"], tests: ["tests/council-page.test.tsx", "tests/council-office.test.ts", "tests/world/service.test.ts", "tests/world-assets.test.ts"], reason: "owner-started screens (council, the pixel office); no autonomous run to drill" },
  { kind: "room", ids: ["critique"], tests: ["tests/critic-pair.test.ts", "tests/stages/critique-policy.test.ts"], reason: SANDBOX_OFF },
  { kind: "room", ids: ["docs", "night", "harness", "self-repair"], tests: ["tests/stages/docs.test.ts", "tests/stages/night.test.ts", "tests/harness/harness.test.ts", "tests/server/self-repair.test.ts"], reason: "nightly passes and repairs of Lane Pilot's own faults, off or idle in the sandbox" },
  { kind: "room", ids: ["native-install"], tests: ["tests/native-install.test.ts"], reason: "installs the native stack on hosts; guard_hash checks the installed guard's bytes but no scenario runs an install" },
  { kind: "room", ids: ["phase"], live: ["phase"], via: "a drill phase of three pieces in two waves through phase_act: issued wave by wave and driven to verification", tests: ["tests/phase-logic.test.ts", "tests/sma-rooms.test.ts"] },
  { kind: "room", ids: ["sma-map"], tests: ["tests/sma-map.test.ts"], reason: "the registry of the SMA map and its proofs: a code check, nothing to run on the hub" },
  { kind: "room", ids: ["front", "cockpit"], tests: ["tests/sma-rooms.test.ts"], reason: "the window's front and cockpit: screens and their reads; no drill opens a screen (scripts/lp-ui-drive.mjs runs scenes against a live window)" },
  { kind: "room", ids: ["forge"], tests: ["tests/sma-rooms.test.ts"], reason: "a forge draft is a writer task the PM orders; the sandbox has no PM ordering one" },
  { kind: "room", ids: ["money", "receipts", "self-improve", "outbound", "guard-tools"], tests: ["tests/sma-rooms.test.ts", "tests/guard-tools.test.ts"], reason: "reads and reports over the hub's data (spend, receipts, history), not a step a drill task takes" },
  { kind: "room", ids: ["permits"], tests: ["tests/sma-rooms.test.ts"], reason: "a permit ticket needs a writer the guard refuses (delete for good, DROP); no drill task asks for one" },
  { kind: "room", ids: ["policy", "rule-forms"], tests: ["tests/policy/exam.test.ts", "tests/rule-mechanisms.test.ts"], reason: "decisions of the night loop over owner decisions and rules; read by the morning list, not by the deploy" },
  { kind: "room", ids: ["qa"], tests: ["tests/qa-host.test.ts"], reason: "browser QA needs a dev server and a browser host" },
  { kind: "room", ids: ["relay"], tests: ["tests/server/relay.test.ts", "tests/server/pm-notices.test.ts"], reason: "task results do reach the drill's PM, but no scenario asserts on the message" },
  { kind: "room", ids: ["wall"], tests: ["tests/wall/helpers.ts", "tests/wall/journal.test.ts", "tests/wall/ladder-select.test.ts", "tests/wall/logs.test.ts"], reason: "the night loop runs at 03:00 over a day of failures and spends model tokens on repairs and hunters; its retro over hub data and a dry-run night are the live check, not the pre-deploy drill" },
  { kind: "room", ids: ["baseline"], tests: ["tests/baseline/baseline.test.ts", "tests/baseline/logic.test.ts", "tests/baseline/regress.test.ts", "tests/baseline/start.test.ts"], reason: "the baseline runs before every real writer (the drill tasks carry no checks yet) and the regression pass runs nightly on real projects; checked live on a sandbox clone" },
  { kind: "room", ids: ["checkers"], live: ["checkers"], via: "the quick drill plants defects in a fixture repository and runs every code checker on them (model critics: hand runs, scripts/lp-checkers.ts)", tests: ["tests/checkers/score.test.ts"] },
  { kind: "room", ids: ["work-graph"], tests: ["tests/work-graph/logic.test.ts", "tests/work-graph-ui.test.tsx"], reason: "a read-only view over stage events, receipts, attempts and token cursors; no drill task asserts what the owner's screens show" },
  { kind: "room", ids: ["forecast"], tests: ["tests/forecast/forecast.test.ts"], reason: "a report over accepted tasks that carry a forecast; read by the PM before it promises a date, no drill task carries a forecast" },
  { kind: "room", ids: ["wires"], tests: ["tests/wires/wires.test.ts", "tests/acceptance-card-ui.test.tsx"], reason: "runs in the plan-fact stage of a task whose contract declares wires; no drill task declares one" },
  { kind: "room", ids: ["run-goal"], tests: ["tests/run-goal/run-goal.test.ts", "tests/baseline/regress.test.ts"], reason: "the sweep runs every 20 minutes on finished runs; the quick drill's parallel3 run (three accepted tasks) is checked by it after each deploy" },
  { kind: "room", ids: ["capability"], tests: ["tests/capability/capability.test.ts"], live: ["helper_providers"], via: "the quick drill runs the same helper probe on every provider in use; the hourly sweep runs it once per new adapter version" },
  { kind: "room", ids: ["outage"], tests: ["tests/outage/outage-conveyor.test.ts"], reason: "a gap shows only after the plugin was down for more than five minutes; the daily report reads the table" },
  { kind: "room", ids: ["backlog"], tests: ["tests/backlog/backlog.test.ts"], reason: "the hourly scan reads real projects' todos and writes to their PMs; the drill has no backlog" },
  { kind: "room", ids: ["pilot"], tests: ["tests/pilot/pilot.test.ts", "tests/run-pause-start.test.ts"], reason: "takes effect only for three sibling tasks of one area and kind in a run; the drill's tasks have no area" },
  { kind: "room", ids: ["memory-tiers"], tests: ["tests/memory-tiers/tiers.test.ts"], reason: "runs inside the PM's memory query; the memory probe drill covers the active paths, the cold tier needs notes unused for 90 days" },
  { kind: "room", ids: ["atlas"], tests: ["tests/atlas.test.ts"], reason: "a generated document; the test fails when docs/atlas.md no longer matches the registries" },
  { kind: "room", ids: ["design-eval"], tests: ["tests/design-eval/design-eval.test.ts"], reason: "a script a person or the night runs on a page (scripts/lp-design-eval.ts); checked live on the self-improvement page" },
  { kind: "room", ids: ["twins"], tests: ["tests/twins.test.ts"], reason: "checks the tests' own doubles against recorded real answers; nothing of it runs in the plugin" },
  { kind: "room", ids: ["hypotheses"], tests: ["tests/hypotheses/hypotheses.test.ts"], reason: "a hypothesis is checked by two bench arms (hours, tokens); the drill does not run the bench" },
  { kind: "room", ids: ["conveyor"], tests: ["tests/outage/outage-conveyor.test.ts", "tests/run-pause-start.test.ts"], reason: "a switch a person or an agent turns; the drill keeps it on" },
  { kind: "room", ids: ["owner-presence"], tests: ["tests/owner-presence/presence.test.ts", "tests/run-budget.test.ts"], reason: "acts only while the owner types in a session of his own; the drill runs with no owner at the keyboard" },
  { kind: "room", ids: ["stage-return"], tests: ["tests/stage-return/logic.test.ts", "tests/stage-return/return.test.ts", "tests/stage-return/spawn-brief.test.ts", "tests/stage-return-ui.test.tsx"], reason: "a person sends a task back to an earlier stage; the drill has no owner to do it, checked live on the sandbox project" },
  { kind: "room", ids: ["rollback"], tests: ["tests/rollback.test.ts"], reason: "no drill merges a change and reverts it on the sandbox" },
  { kind: "room", ids: ["schedule"], tests: ["tests/schedule/scheduler.test.ts"], reason: "scheduled errands tick on their own clock; the drill starts none" },
  { kind: "room", ids: ["secrets"], tests: ["tests/server/secrets.test.ts"], reason: "the Env Catalog access of the sandbox is not exercised" },
  { kind: "room", ids: ["ui-shell", "usage", "workflow"], tests: ["tests/ui-project-nav.test.tsx", "tests/attempt-metrics.test.ts", "tests/workflow/contract.test.ts"], reason: "screens, token accounting and workflow chains; checked by hand on the live UI (375 and 1280 px), no drill scenario drives them" },
  { kind: "room", ids: ["owner-waiting"], tests: ["tests/owner-waiting.test.ts", "tests/owner-waiting-ui.test.tsx", "tests/owner-push-script.test.ts"], reason: "a screen and a Telegram digest; checked by hand on the live UI harness at 375 and 1280 px, and a send needs the hub's bot" },
  { kind: "room", ids: ["coverage"], tests: ["tests/coverage.test.ts"], reason: "this registry; its test is its check" },

  // ── key mechanisms ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  { kind: "mechanism", ids: ["deferral.register", "deferral.skip-scan"], live: ["deferrals"], via: "the scenario fails on an overdue entry and on a skipped test that cites a missing or closed entry", tests: ["tests/deferral-register.test.ts", "tests/deferral-skips.test.ts"] },
  { kind: "mechanism", ids: ["merge.queue"], live: ["conflict", "main_moved"], via: "two writers rewrite one line; main moves under a writer: both are accepted, no conflict markers", tests: ["tests/server/merge-intent.test.ts"] },
  { kind: "mechanism", ids: ["worktree.provider"], live: ["provider", "parallel3"], via: "each accepted attempt must carry its own environment and no holder thread", tests: ["tests/parallel-writers-own-worktree.test.ts"] },
  { kind: "mechanism", ids: ["nogit.mode"], live: ["nogit", "nogit_repo"], via: "a folder without git, and one git repository inside it", tests: ["tests/live-folder.test.ts", "tests/nested-repo-flow.test.ts"] },
  { kind: "mechanism", ids: ["reload.recovery"], live: ["reload"], via: "plugin reload while a writer works", tests: ["tests/reconcile.test.ts", "tests/deploy-drain.test.ts"] },
  { kind: "mechanism", ids: ["provider.fallback"], live: ["provider_limit"], via: "a bad writer model hands the task to the next writer", tests: ["tests/writer-fallbacks.test.ts"] },
  { kind: "mechanism", ids: ["helper.providers"], live: ["helper_providers"], via: "one cheap helper per provider in use must start and answer", tests: ["tests/server/helper-probe.test.ts"] },
  { kind: "mechanism", ids: ["guard.hash"], live: ["guard_hash"], via: "the installed shell guard on each machine equals the repository's copy", tests: ["tests/lp-drill-guard-hash.test.ts"] },
  { kind: "mechanism", ids: ["plan-fact.blind-check"], live: ["parallel3"], via: "the stage passes on real drill writers' tables", tests: ["tests/plan-fact.test.ts"] },
  { kind: "mechanism", ids: ["rollback.reverify", "rollback.revert"], tests: ["tests/rollback.test.ts"], reason: "no drill merges a change and reverts it on the sandbox; the tests run on throwaway git repositories" },
  { kind: "mechanism", ids: ["bench.run", "bench.compare", "bench.harness-adoption"], tests: ["tests/bench/runner.test.ts", "tests/bench/build.test.ts", "tests/bench/harness-adoption.test.ts"], reason: "a bench run replays real tasks for hours and tokens; it gates harness changes by itself" },
  { kind: "mechanism", ids: ["policy.exam", "policy.classify"], tests: ["tests/policy/exam.test.ts", "tests/policy/classify.test.ts"], reason: "the exam scores owner decisions made after the policy's freeze; it is a test and a CLI, not a deploy step" },
  { kind: "mechanism", ids: ["memory.conflict-hold"], tests: ["tests/memory-conflicts.test.ts"], reason: "detection runs after memory writes; the drill's memory probe plants one token, never two notes that disagree" },
  { kind: "mechanism", ids: ["owner-waiting.digest"], tests: ["tests/owner-waiting.test.ts", "tests/owner-push-script.test.ts"], reason: "the hub script needs the daily report's Telegram bot; the test runs it with a fake bb and curl" },
  { kind: "mechanism", ids: ["coverage.registry"], tests: ["tests/coverage.test.ts"], reason: "the registry checks itself against the code on every test run" },
];

/** Mechanisms the spec names; the test keeps them present. */
export const REQUIRED_MECHANISMS = ["rollback.reverify", "rollback.revert", "deferral.register", "bench.run", "policy.exam", "policy.classify", "plan-fact.blind-check", "memory.conflict-hold"] as const;
