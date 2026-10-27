import { prototypeConfigSchema, taskV2Schema } from "../../contracts";
import { getActivation, getAttempt, getRun, getTask, importSettingsOnce, inspectState, listRunsWithAttempts, loadProjectSettings, loadPrototypeConfig, savePrototypeConfig, saveProjectSetting, transitionAttempt } from "../../storage";
import { cancelRejection, confirmWriterStopped, finishRunSafely, pauseRun } from "../../runs/server";
import { stringAt, valueAt } from "../../core/server";
import { outputText } from "../../writer/server";
import { THREAD_WATCH_EVENT_TYPES, decideThreadCompletion, eventsListQueryLabel, listThreadEventsRaw, waitThreadIdle } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../../core/server";
import { RUN_BUDGET_SETTINGS, runHealth } from "../../stability/server";
import { configuredSetting } from "../../core/server";
import { getCouncilSession } from "@lane-pilot/council";
import { SCHEDULE_USAGE, runScheduleCli } from "../../schedule/server";
import { AGENTS_USAGE, agentRegistry, runAgentsCli } from "../../native-agent/server";
import type { Services } from "../../core/server";
import { ANAMNESIS_USAGE } from "../../anamnesis";
import { anamnesisFor } from "../../anamnesis";
import { LEARNING_USAGE, runLearningCli } from "../../learning";
import { learningFor } from "../../learning";
import { attemptMetrics, renderAttemptMetrics } from "../../usage/server";
import { DEFERRAL_USAGE, runDeferralCli } from "../../deferral/server";
import { MEMORY_EVAL_USAGE, runMemoryEvalCommand } from "../../memory-eval/server";
import { MEMORY_CONFLICT_USAGE, runMemoryConflictCli } from "../../memory/server";
import { BENCH_USAGE, runBenchCli } from "../../bench/server";
import { BASELINE_USAGE, runBaselineCli } from "../../baseline/server";
import { RETURN_USAGE, runReturnCli } from "../../stage-return/server";
import { FORECAST_USAGE, runForecastCli } from "../../forecast/server";
import { RUN_GOAL_USAGE, runRunGoalCli } from "../../run-goal/server";
import { CAPABILITY_USAGE, runCapabilityCli } from "../../capability/server";
import { OUTAGE_USAGE, runOutageCli } from "../../outage/server";
import { BACKLOG_USAGE, runBacklogCli } from "../../backlog/server";
import { runHypothesisCli } from "../../hypotheses/server";
import { tierReport } from "../../memory-tiers/server";
import { conveyorState, setConveyor } from "../../conveyor";
import { WALL_USAGE, runWallCli } from "../../wall/server";
import { CHECKERS_USAGE, runCheckersCli } from "../../checkers/server";
import { POLICY_USAGE, runPolicyCli } from "../../policy";
import { WAITING_USAGE, runWaitingCli } from "../../owner-waiting/server";
import { COVERAGE_USAGE, runCoverageCli } from "../../coverage";
import { SMA_MAP_USAGE, runSmaLiveCli, runSmaMapCli } from "../../sma-map";
import { readinessWords, trainedConditions, trainingRatios, type DesignJournalLine } from "../../design-eval";
import { PHASE_USAGE, runPhaseCli } from "../../phase/server";
import { unknownReasons } from "../../runs";
import { manifest, passport, preship, prPassport, receiptChain, verifyChain } from "../../receipts";
import { EXCAVATE_LOG_ARGS, approvalSuggestions, costPerVerified, excavate, htmlReport, missCurriculum } from "../../self-improve";
import { smaCounts, smaDonePercent, smaRows } from "../../sma-map";
import { loadLiveExam } from "../../policy";
import { RULES_USAGE, runRulesCli } from "../../rule-forms";
import { retireAdoptedRule } from "../../self-repair/server";
import { ROLLBACK_USAGE, runRollbackCli } from "../../rollback/server";
import { CODE_CRITIC_DEFAULTS, isCodeCriticDefault } from "../../critique";
import type { CodeCriticDefault } from "../../critique";

function requireCriticCodeDefault(value: string): CodeCriticDefault {
  if (!isCodeCriticDefault(value)) throw new Error(`critic.code.default_for_risk must be one of ${CODE_CRITIC_DEFAULTS.join(", ")}`);
  return value;
}

export function registerCli(ctx: ServerCore, services: Services) {
  const { bb, cancelQueuedAttempt, db, effectiveProjectSettings, host } = ctx;

  const usage = [
    "bb lane-pilot configure <json>",
    "bb lane-pilot activate <project-id> <ordinary-source-thread-id>",
    "bb lane-pilot state <project-id>",
    "bb lane-pilot metrics <project-id> [--days N] [--json]",
    "bb lane-pilot finish <project-id>",
    "bb lane-pilot deactivate <project-id>",
    "bb lane-pilot cancel <attempt-id>",
    "bb lane-pilot recover <attempt-id>",
    "bb lane-pilot pause <run-id>   (new tasks wait, running attempts finish their current stage and then wait; nothing is canceled)",
    "bb lane-pilot resume <run-id>   (let a paused run go on; `resume [project-id]` still reconciles orphaned writers)",
    ROLLBACK_USAGE,
    "bb lane-pilot start-cancel-probe <project-id> <pm-thread-id>",
    "bb lane-pilot start-provider-error-probe <project-id> <pm-thread-id>",
    "bb lane-pilot start-ambiguous-probe <project-id> <pm-thread-id>",
    "bb lane-pilot helper-probe <project-id> <run-id> <provider-id> <model>",
    "bb lane-pilot memory-probe <project-id> [--paths a,b] [--keep] [--clean] [--report] [--force]",
    MEMORY_EVAL_USAGE,
    MEMORY_CONFLICT_USAGE,
    "bb lane-pilot host-detect <host-id> <workspace-path>",
    "bb lane-pilot host-snapshot <host-id> <absolute-path>...",
    "bb lane-pilot host-snapshot-manifest <host-id> [thread-storage]",
    "bb lane-pilot host-install <host-id> [thread-storage] [pm-workspace]",
    "bb lane-pilot host-rollback <host-id> <snapshot-path>",
    "bb lane-pilot host-connect-opencode <host-id>",
    "bb lane-pilot host-import-config <host-id> <project-id> [workspace-path]",
    "bb lane-pilot host-run-cli <host-id> <cwd> <binary> <subcommand> [args...]",
    "bb lane-pilot resume [project-id]",
    "bb lane-pilot dispatch-cli <project-id> <pm-thread-id> [binary] [subcommand] [task-file] [task-id] [run-dir]",
    "bb lane-pilot dispatch-bb <project-id> <pm-thread-id> [task-json] [base-ref] [critic-code-default: off|medium|high]",
    "bb lane-pilot events-list <thread-id>",
    "bb lane-pilot wait-thread <thread-id>",
    "bb lane-pilot workflow-trigger <project-id> <workflow-id> [inputs-json] [key]",
    SCHEDULE_USAGE,
    AGENTS_USAGE,
    ANAMNESIS_USAGE,
    DEFERRAL_USAGE,
    POLICY_USAGE,
    WAITING_USAGE,
    COVERAGE_USAGE,
    SMA_MAP_USAGE,
    PHASE_USAGE,
    RULES_USAGE,
  ].join("\n");

  bb.cli.register({
    name:"lane-pilot",
    summary:"Lane Pilot stage-0 prototype controls",
    commands:[
      { name:"configure", summary:"Save prototype project settings", usage:"bb lane-pilot configure '<json>'" },
      { name:"activate", summary:"Spawn a visible isolated PM thread", usage:"bb lane-pilot activate <project-id> <ordinary-source-thread-id>" },
      { name:"state", summary:"Inspect persisted stage-0 state", usage:"bb lane-pilot state <project-id>" },
      { name:"budget", summary:"Set or show the run budget of a project (attempts, wall minutes, tokens, child threads; empty value clears)", usage:"bb lane-pilot budget <project-id> [run.max_attempts=N] [run.max_wall_minutes=N] [run.max_tokens=N] [run.max_children=N]" },
      { name:"metrics", summary:"Per attempt: stages passed or failed, seconds per stage, writer tokens and list-price cost; cost shows not measured where the provider reports no usage, never 0", usage:"bb lane-pilot metrics <project-id> [--days N] [--json]" },
      { name:"health", summary:"Provider breaker state and the budgets of open runs", usage:"bb lane-pilot health [run-id]" },
      { name:"harness", summary:"The writer harness that learns: active trees, trials and their arms, keys with enough attempts", usage:"bb lane-pilot harness <project-id>" },
      { name:"harness-edit", summary:"Run the harness editor now for one key (two editors, one composer; the result goes on trial)", usage:"bb lane-pilot harness-edit <project-id> [area] [writer-key] [wait=1]" },
      { name:"harness-tick", summary:"Judge the project's trials and start the night's editors (dry=1 only reports)", usage:"bb lane-pilot harness-tick <project-id> [dry=1]" },
      { name:"harness-trajectory", summary:"A writer thread rendered as the trajectory the harness editor reads, cut to one task when given", usage:"bb lane-pilot harness-trajectory <thread-id> [task-id]" },
      { name:"council", summary:"Convene a council of directors on a question in an open PM run", usage:"bb lane-pilot council <run-id> <question> [roles=product,skeptic] [rounds=N] [mode=room|rounds] [judge=on|off] [materials=a.md,b.csv]" },
      { name:"council-say", summary:"Say something to a running council as the owner, or decide=1 to ask for the decision", usage:"bb lane-pilot council-say <council-id> [text] [decide=1]" },
      { name:"council-status", summary:"A council session and its feed", usage:"bb lane-pilot council-status <council-id> [after-seq]" },
      { name:"council-seats", summary:"Which provider/model pair each seat would get in a project and the pairs the stage selections offer", usage:"bb lane-pilot council-seats <project-id>" },
      { name:"docs-nightly", summary:"Run the nightly docs pass now for docs-enabled folders of a project", usage:"bb lane-pilot docs-nightly <project-id> [folder-path] [since-commit]" },
      { name:"finish", summary:"Close a PM run after observing it idle and release activation", usage:"bb lane-pilot finish <project-id> [run-id]" },
      { name:"deactivate", summary:"Alias for finish", usage:"bb lane-pilot deactivate <project-id> [run-id]" },
      { name:"cancel", summary:"Stop a writer and persist canceled after observing idle", usage:"bb lane-pilot cancel <attempt-id>" },
      { name:"pause", summary:"Pause a run at a safe boundary: new tasks wait, running attempts finish their current stage and then wait, nothing is canceled", usage:"bb lane-pilot pause <run-id>" },
      { name:"reverify", summary:"Run a task's verification[] again on its recorded base plus the accepted change, in a fresh worktree on the project host; exit 0 only when every item passes, a receipt is kept", usage:"bb lane-pilot reverify <task-id|attempt-id>" },
      { name:"revert", summary:"Revert an accepted task's merge commit(s) with git revert in a worktree, check them, merge through the normal merge queue; refuses with the next step when later commits touch the same lines", usage:"bb lane-pilot revert <task-id> [--dry-run] [--no-gate]" },
      { name:"changes", summary:"What is on record for a task or an attempt: base, merge, changed files (deletions included) and the reverify / revert receipts", usage:"bb lane-pilot changes <task-id|attempt-id>" },
      { name:"recover", summary:"Reconcile a known writer identity and emit its validated receipt", usage:"bb lane-pilot recover <attempt-id>" },
      { name:"start-cancel-probe", summary:"Spawn a long-running writer for a live stop observation", usage:"bb lane-pilot start-cancel-probe <project-id> <pm-thread-id>" },
      { name:"start-provider-error-probe", summary:"Observe a live provider error and persist provider_error", usage:"bb lane-pilot start-provider-error-probe <project-id> <pm-thread-id>" },
      { name:"helper-probe", summary:"Start one cheap helper (pm-read path) on a provider and check it answered", usage:"bb lane-pilot helper-probe <project-id> <run-id> <provider-id> <model>" },
      { name:"memory-probe", summary:"Plant a token through the memory write door and check that every delivery path (writer brief, PM, critics, terminal) hands it to its agent; sandbox project only unless --force", usage:"bb lane-pilot memory-probe <project-id> [--paths a,b] [--keep] [--clean] [--report] [--force]" },
      { name:"memory-eval", summary:"Score memory retrieval at 30, 300 and 3000 notes on real accepted tasks (right answer, nothing relevant, off-topic) against a plain path-and-keyword baseline; reads the hub data, writes nothing", usage:MEMORY_EVAL_USAGE },
      { name:"memory-conflicts", summary:"Memory notes that disagree: held out of every brief until a person settles them; --detect looks for new ones", usage:"bb lane-pilot memory-conflicts [--project P] [--state held|settled] [--detect]" },
      { name:"memory-conflict-settle", summary:"Settle a held memory conflict: keep one note, both, or neither, with the evidence", usage:"bb lane-pilot memory-conflict-settle <mc_id> --keep a|b|both|none --evidence <text>" },
      { name:"start-ambiguous-probe", summary:"Create duplicate metadata and prove reconcile blocks", usage:"bb lane-pilot start-ambiguous-probe <project-id> <pm-thread-id>" },
      { name:"host-detect", summary:"Call the host worker detect method", usage:"bb lane-pilot host-detect <host-id> <workspace-path>" },
      { name:"host-snapshot", summary:"Call read-only snapshotDryRun", usage:"bb lane-pilot host-snapshot <host-id> <absolute-path>..." },
      { name:"host-snapshot-manifest", summary:"Full §11.1 snapshot", usage:"bb lane-pilot host-snapshot-manifest <host-id> [thread-storage]" },
      { name:"host-install", summary:"Install target SHA without external ops", usage:"bb lane-pilot host-install <host-id> [thread-storage] [pm-workspace]" },
      { name:"host-rollback", summary:"Rollback a snapshot", usage:"bb lane-pilot host-rollback <host-id> <snapshot-path>" },
      { name:"host-connect-opencode", summary:"S5 JSONC plugin patch", usage:"bb lane-pilot host-connect-opencode <host-id>" },
      { name:"host-import-config", summary:"S7 one-shot YAML read", usage:"bb lane-pilot host-import-config <host-id> <project-id> [workspace-path]" },
      { name:"host-run-cli", summary:"Run run-controller/lane-ctl on the project host", usage:"bb lane-pilot host-run-cli <host-id> <cwd> <binary> <subcommand> [args...]" },
      { name:"resume", summary:"Reconcile orphaned writer attempts without spawning duplicates", usage:"bb lane-pilot resume [project-id]" },
      { name:"dispatch-cli", summary:"Dispatch a CLI writer run for a PM thread", usage:"bb lane-pilot dispatch-cli <project-id> <pm-thread-id> [binary] [subcommand]" },
      { name:"dispatch-bb", summary:"Dispatch a BB writer task, optional task-v2 JSON", usage:"bb lane-pilot dispatch-bb <project-id> <pm-thread-id> [task-json] [base-ref] [critic-code-default: off|medium|high]" },
      { name:"events-list", summary:"Read-only SDK events.list probe", usage:"bb lane-pilot events-list <thread-id>" },
      { name:"wait-thread", summary:"Read-only waitThreadIdle probe", usage:"bb lane-pilot wait-thread <thread-id>" },
      { name:"anamnesis", summary:"What Lane Pilot knows about its owner (records on the owner's machine); sensitive ones only on explicit request", usage:"bb lane-pilot anamnesis status|list|show|history|add|edit|confirm|reject|forget|sources|host" },
      { name:"learning", summary:"What Lane Pilot learned from the owner's own messages: status, review, learned items, yes or no, settings", usage:LEARNING_USAGE },
      { name:"policy-exam", summary:"Score the night policy on the newest unseen split (owner decisions made after its freeze) and store the result; without 20 such decisions at 0.8 the night proposes instead of deciding", usage:"bb lane-pilot policy-exam" },
      { name:"policy", summary:"The night policy: show the lists, classify a change descriptor, the three-line morning list", usage:"bb lane-pilot policy show|classify '<json>'|exam-collect|exam-add '<json>'|exam-export|morning" },
      { name:"waiting", summary:"Everything only the owner can decide, with why, evidence and the exact action; what went red overnight; the Telegram digest of new items (quiet hours 23:00-08:00 Europe/Madrid by default)", usage:WAITING_USAGE },
      { name:"coverage", summary:"What proves each pipeline stage, attempt transition, failure class, gate, memory path, room and key mechanism: covered live by a deploy-drill scenario, covered by tests only (and why no drill), or not covered; --receipt checks the live claims against a drill receipt", usage:COVERAGE_USAGE },
      { name:"passport", summary:"An attempt's passport: provider, model, harness and Lane Pilot versions, the receipts of its stages", usage:"bb lane-pilot passport <attempt-id>" },
      { name:"manifest", summary:"This build: name, version, its tables", usage:"bb lane-pilot manifest" },
      { name:"receipt-chain", summary:"A task's stage receipts hashed in order (tip), or verify a tip recorded earlier", usage:"bb lane-pilot receipt-chain <run-id> <task-id> [--verify <tip>]" },
      { name:"preship", summary:"What is open before a release (unfinished tasks, open regressions, deferrals) and the disposition each needs; exit 1 when not clear", usage:"bb lane-pilot preship [--project <id>]" },
      { name:"pr-passport", summary:"A pull request body assembled from a task's receipts", usage:"bb lane-pilot pr-passport <run-id> <task-id>" },
      { name:"curriculum", summary:"The queries memory failed to answer lately, grouped (the next lessons to write)", usage:"bb lane-pilot curriculum [--days 30]" },
      { name:"excavate", summary:"Fix commits of a repository's history as lesson candidates (runs git log on the given run's machine)", usage:"bb lane-pilot excavate <run-id> [<path in the checkout>]" },
      { name:"approvals-suggest", summary:"Owner decisions that repeat the same way three times or more: candidates for an automatic night rule", usage:"bb lane-pilot approvals-suggest" },
      { name:"cost", summary:"Cost per verified result: writer tokens per accepted task, per project, over 30 days", usage:"bb lane-pilot cost [--days 30]" },
      { name:"report", summary:"A local HTML report: the SMA map by region, the spend, the cost per verified result", usage:"bb lane-pilot report > report.html" },
      { name:"money", summary:"Money: spent month to date on paid lanes, the 14-day series, the monthly cap (money.monthly_cap_usd) and what is left", usage:"bb lane-pilot money" },
      { name:"unknown-codes", summary:"Failure reasons no class or rule names yet (the unknown code register), most frequent first, over the last 14 days", usage:"bb lane-pilot unknown-codes [--days 14]" },
      { name:"phase", summary:"Phases on rails: list, show (with the phase book), drive now, return to an earlier stage with a note, pause, resume, close in words", usage:PHASE_USAGE },
      { name:"design-metrics", summary:"The designer's training: the four ratios from the design measurement journal, the four conditions of «trained» and the readiness words", usage:"bb lane-pilot design-metrics [--project <id>] [--json]" },
      { name:"sma-map", summary:"The SMA product map node by node: what Lane Pilot has for each of its 1768 nodes, the proof in the code, what is missing, and the share done", usage:SMA_MAP_USAGE },
      { name:"rules", summary:"The rules by form (always | skill | check | hook | memory) and the mechanism that enforces each; classify them, generate mechanism tasks for the recurring check rules, retire the text a mechanism now holds", usage:RULES_USAGE },
      { name:"workflow-trigger", summary:"Start a workflow in a project as its schedule trigger does (the automation of a schedule calls this); exit 1 with the reason when it cannot start", usage:"bb lane-pilot workflow-trigger <project-id> <workflow-id> [inputs-json] [key]" },
      { name:"defer", summary:"Put a mandatory check off: write it in the register with the reason. It is born with no term (only a date in a message of the owner sets one, --owner-msg) and counts as unproven in its project's phase acceptance until closed with evidence", usage:"bb lane-pilot defer <what> --kind drill_scenario|skipped_test|gate|plan_decision --reason \"…\" [--area A] [--project P]" },
      { name:"defer-close", summary:"Close a deferral with the evidence that settles it", usage:"bb lane-pilot defer-close <dfr_id> --evidence <text>" },
      { name:"deferrals", summary:"The register of deferrals: overdue and open, with their terms", usage:"bb lane-pilot deferrals [--project P] [--state open|overdue|closed]" },
      { name:"owner-presence", summary:"Where the owner typed in a session of his own in the last minutes: Lane Pilot's writers keep off that provider meanwhile", usage:"bb lane-pilot owner-presence" },
      { name:"hypothesis", summary:"Ideas to make the system better (from outside or inside) as the settings that carry them, checked on the bench set: two arms, the verdict, adoption through the night policy", usage:"bb lane-pilot hypothesis list|add|test|verdict|revert" },
      { name:"memory-tiers", summary:"The memory's cold tier (notes unused for 90 days, kept out of briefs) and how many of it a PM needed again, plus the PM queries that found nothing (candidates for memory-eval's golden set)", usage:"bb lane-pilot memory-tiers [--project P]" },
      { name:"backlog", summary:"A project's ready todos sorted for issue: issuable in queue order (estimate at most 13, dependencies done), to estimate, to split, blocked; --scan hands the next ones to the PMs now", usage:BACKLOG_USAGE },
      { name:"conveyor", summary:"The conveyor switch: off, no new work is issued anywhere (writers wait, parked tasks stay, the night queues nothing) while running stages finish and checks go on", usage:"bb lane-pilot conveyor on|off [reason]|status" },
      { name:"outages", summary:"The gaps of more than 5 minutes when Lane Pilot was not running", usage:OUTAGE_USAGE },
      { name:"capabilities", summary:"Per provider in use: the adapter (BB plugin) version installed and whether it is proven to answer; --probe tries the unproven ones now", usage:CAPABILITY_USAGE },
      { name:"run-goal", summary:"Every accepted task's checks of a run together on the final main (two tasks green alone can break each other): check one run, sweep the finished ones, or read a verdict", usage:RUN_GOAL_USAGE },
      { name:"forecast", summary:"The PM's forecasts (contract `forecast`) against the facts of accepted tasks: files, first try, tokens and minutes, per area", usage:FORECAST_USAGE },
      { name:"regress", summary:"Regression after acceptance: the last accepted tasks' cheap checks on current main, a bisect to the first bad commit for the ones gone red; --plan only picks, --dry-run writes nothing, nothing is reverted", usage:BASELINE_USAGE },
      { name:"regressions", summary:"The regression findings still open (--all for settled ones too)", usage:"bb lane-pilot regressions [project-id] [--all]" },
      { name:"regress-close", summary:"Settle a regression finding by hand", usage:"bb lane-pilot regress-close <id> <reason...>" },
      { name:"baseline", summary:"The checks already green or red on the base a task started from, and what turned red after its merge", usage:"bb lane-pilot baseline <task-id>" },
      { name:"return", summary:"Send a task back to discussion, planning or the writer with a note: recorded, the stale receipts reset, the running attempt stopped with the exit confirmed, the work restarted from that stage with the note in its input", usage:"bb lane-pilot return <task-id> --to discussion|planning|writer --note \"…\"" },
      { name:"returns", summary:"The returns on record for a task: the note, the stale and kept stages, how far each got", usage:"bb lane-pilot returns <task-id>" },
      { name:"bench", summary:"LP-Bench: a fixed set of real past tasks replayed on an arm (writer, harness tree, setting) and compared in pairs: stages passed, cost, time", usage:BENCH_USAGE },
      { name:"wall", summary:"The wall journal and the night loop: failures grouped by class, the 3/10-5/100-6/500 recurrence, the night's repairs, hunters and the backlog, re-runs on the new head", usage:WALL_USAGE },
      { name:"checkers", summary:"Checking the checkers: plant known defects in accepted candidates, run every checker on them and print the checker scorecard (score, scorecard, drill, defects)", usage:CHECKERS_USAGE },
      { name:"schedule", summary:"The schedule board: scheduled workflows, errands and scripts (list, show, history, preview, create, update, pause, resume, run-now, delete)", usage:SCHEDULE_USAGE },
      { name:"agents", summary:"The agents the owner can pick: list and show the bundled ones, create, update and delete his own (a JSON or a markdown file with frontmatter)", usage:AGENTS_USAGE },
    ],
    async run(argv, invocation) {
      try {
        const [command, ...args] = argv;
        // The same door as the tools: a PM's shell does not start work (a schedule, a dispatch, a workflow, a council) for a request
        // the machine took. Automations and drills call the CLI without a thread and are not touched.
        const launches = command === "schedule" ? ["create", "update", "run-now"].includes(args[0] ?? "") : ["dispatch-cli", "dispatch-bb", "workflow-trigger", "council"].includes(command ?? "");
        const refusal = invocation?.threadId && launches ? await services.phaseIntake.launchRefusal(invocation.threadId) : null;
        if (refusal) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:refusal }) };
        if (command === "reverify" || command === "revert" || command === "changes") {
          return await runRollbackCli(services.rollback, command, args);
        }
        if (command === "pause" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(await pauseRun(ctx, args[0]!, "pause"), null, 2) };
        }
        // `resume <run-id>` lets a paused run go on; `resume [project-id]` is the older reconcile of orphaned writers.
        if (command === "resume" && args.length === 1 && getRun(db, args[0]!)) {
          return { exitCode:0, stdout:JSON.stringify(await pauseRun(ctx, args[0]!, "resume"), null, 2) };
        }
        if (command === "anamnesis") {
          return await anamnesisFor(ctx).cli(args);
        }
        if (command === "learning") {
          const learning = learningFor(ctx);
          return learning ? await runLearningCli(learning, args) : { exitCode:1, stderr:"learning is not mounted" };
        }
        if (command === "policy-exam" || command === "policy") {
          return await runPolicyCli({ db, kv:bb.storage.kv as never }, command, args);
        }
        if (command === "coverage") {
          return runCoverageCli(args);
        }
        if (command === "passport") {
          const result = args[0] ? passport(db, args[0]) : null;
          return result ? { exitCode:0, stdout:JSON.stringify(result, null, 2) } : { exitCode:1, stderr:"bb lane-pilot passport <attempt-id>: no such attempt" };
        }
        if (command === "manifest") return { exitCode:0, stdout:JSON.stringify(manifest(db), null, 2) };
        if (command === "receipt-chain" && args[0] && args[1]) {
          if (args[2] === "--verify" && args[3]) { const ok = verifyChain(db, args[0], args[1], args[3]); return { exitCode:ok ? 0 : 1, stdout:ok ? "intact" : "the receipts changed since that tip" }; }
          return { exitCode:0, stdout:JSON.stringify(receiptChain(db, args[0], args[1]), null, 2) };
        }
        if (command === "preship") {
          const result = preship(db, args[0] === "--project" ? args[1] : undefined);
          return { exitCode:result.clear ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
        }
        if (command === "pr-passport" && args[0] && args[1]) return { exitCode:0, stdout:prPassport(db, args[0], args[1]) };
        if (command === "curriculum") return { exitCode:0, stdout:JSON.stringify(missCurriculum(db, args[0] === "--days" ? Number(args[1]) || 30 : 30), null, 2) };
        if (command === "cost") return { exitCode:0, stdout:JSON.stringify(costPerVerified(db, args[0] === "--days" ? Number(args[1]) || 30 : 30), null, 2) };
        if (command === "approvals-suggest") {
          const live = await loadLiveExam(bb.storage.kv as never).catch(() => ({ items: [] as never[] }));
          return { exitCode:0, stdout:JSON.stringify(approvalSuggestions((live as { items?: never[] }).items ?? []), null, 2) };
        }
        if (command === "excavate" && args[0]) {
          const run = db.prepare("SELECT writer_workspace_path AS path, writer_host_id AS hostId FROM lane_pilot_run WHERE id=?").get(args[0]) as { path?: string; hostId?: string } | undefined;
          if (!run?.path || !run.hostId) return { exitCode:1, stderr:"the run has no checkout on a machine" };
          const cwd = args[1] ? `${run.path}/${args[1].replace(/^\.?\//, "")}` : run.path;
          const out = await host.call("runCommand", { requestedHostId:run.hostId, command:`git ${EXCAVATE_LOG_ARGS.map((arg) => `'${arg}'`).join(" ")}`, cwd, timeoutSec:60 }, { hostId:run.hostId, timeoutMs:90_000 }) as { stdout?: string };
          return { exitCode:0, stdout:JSON.stringify(excavate(out.stdout ?? ""), null, 2) };
        }
        if (command === "report") {
          const rows = smaRows();
          const regions = [...new Set(rows.map((row) => row.region))].map((region) => { const part = rows.filter((row) => row.region === region); return { region, done: `${smaDonePercent(part)}%`, ...smaCounts(part) }; });
          return { exitCode:0, stdout:htmlReport({ title:`Lane Pilot report ${new Date().toISOString().slice(0, 10)}`, sections:[
            { heading:`SMA map: ${smaDonePercent(rows)}% done`, rows:regions },
            { heading:"Money", rows:[services.money.status() as never] },
            { heading:"Cost per verified result (30 days)", rows:costPerVerified(db) as never },
          ] }) };
        }
        if (command === "money") {
          return { exitCode:0, stdout:JSON.stringify(services.money.status(), null, 2) };
        }
        if (command === "unknown-codes") {
          const days = args[0] === "--days" && Number(args[1]) > 0 ? Number(args[1]) : 14;
          const rows = db.prepare("SELECT reason, updated_at AS at FROM lane_pilot_attempt WHERE updated_at >= ? AND reason IS NOT NULL").all(Date.now() - days * 86_400_000) as Array<{ reason: string | null; at: number }>;
          return { exitCode:0, stdout:JSON.stringify(unknownReasons(rows).slice(0, 50), null, 2) };
        }
        if (command === "phase") {
          return await runPhaseCli(services.phases, args);
        }
        if (command === "design-metrics") {
          const all = ((await ctx.bb.storage.kv.get("lp.design.journal").catch(() => null)) as DesignJournalLine[] | null) ?? [];
          const project = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
          const lines = project ? all.filter((line) => line.projectId === project) : all;
          const report = { ratios:trainingRatios(lines), conditions:trainedConditions(lines), readiness:readinessWords(lines) };
          return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(report, null, 2) : `${report.readiness}\n\n${JSON.stringify(report.ratios)}\n${report.conditions.map((row) => `${row.ok ? "✓" : "✗"} ${row.id}: ${row.detail}`).join("\n")}` };
        }
        if (command === "sma-map") {
          return args.includes("--live") ? runSmaLiveCli(db as never, args) : runSmaMapCli(args);
        }
        if (command === "waiting") {
          return runWaitingCli(db, args);
        }
        if (command === "rules") {
          const hostAt = args.indexOf("--host");
          const hostId = hostAt >= 0 ? args[hostAt + 1] : undefined;
          const ask = hostId ? async (state:string, questions:Record<string, { instructions:string; criteria:Record<string, string> }>) => {
            const judged = await host.call("councilJudge", { requestedHostId:hostId, state, questions }, { hostId, timeoutMs:20_000 });
            return judged.status === "ok" ? judged.probabilities ?? null : null;
          } : null;
          return await runRulesCli({ db, ask, repoPath:process.cwd(), retire:(projectId, ruleId, reason) => retireAdoptedRule(db, projectId, ruleId, reason) }, args.filter((arg, index, all) => arg !== "--host" && all[index - 1] !== "--host"));
        }
        if (command === "workflow-trigger" && args.length >= 2 && args.length <= 4) {
          const parsed: unknown = args[2] ? JSON.parse(args[2]) : {};
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("inputs must be a JSON object");
          // The tick's id is the key: a retried tick is the same run, not a second one.
          const result = await services.workflowTriggers.start({ projectId:args[0]!, workflowId:args[1]!, inputs:parsed as Record<string, unknown>, source:"schedule", key:args[3] || undefined });
          return { exitCode:result.ok ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
        }
        if (command === "defer" || command === "defer-close" || command === "deferrals") {
          return await runDeferralCli(services.deferrals, command, args);
        }
        if (command === "regress" || command === "regressions" || command === "regress-close" || command === "baseline") {
          return await runBaselineCli(services, command, args);
        }
        if (command === "forecast") return runForecastCli(db, args);
        if (command === "run-goal") return await runRunGoalCli(services.runGoal, args);
        if (command === "capabilities") return await runCapabilityCli(services.capabilities, args);
        if (command === "outages") return runOutageCli(ctx, args);
        if (command === "backlog") return await runBacklogCli(services.backlog, args);
        if (command === "hypothesis") return await runHypothesisCli(services.hypotheses, args);
        if (command === "owner-presence") {
          const now = Date.now(), presence = await services.ownerPresence.sweep();
          return { exitCode:0, stdout:JSON.stringify(presence.map((row) => ({ ...row, minutesAgo:Math.round((now - row.at) / 60_000), holdsWriters:services.ownerPresence.holds(row.providerId, now) !== null })), null, 2) };
        }
        if (command === "memory-tiers") {
          if (args.length && !(args.length === 2 && args[0] === "--project")) return { exitCode:1, stderr:"usage: bb lane-pilot memory-tiers [--project P]" };
          return { exitCode:0, stdout:JSON.stringify(tierReport(db, args[1]), null, 2) };
        }
        if (command === "conveyor" && ["on", "off", "status"].includes(args[0] ?? "")) {
          const kv = bb.storage.kv as never;
          const state = args[0] === "status" ? await conveyorState(kv) : await setConveyor(kv, args[0] === "on", args.slice(1).join(" "));
          return { exitCode:0, stdout:JSON.stringify(state, null, 2) };
        }
        if (command === "return" || command === "returns") {
          return await runReturnCli(services.stageReturn, command, args);
        }
        if (command === "bench") {
          return await runBenchCli(services.bench, args);
        }
        if (command === "wall") {
          return await runWallCli(services.wall, args);
        }
        if (command === "checkers") {
          return await runCheckersCli(services.checkers, args);
        }
        if (command === "schedule") {
          return await runScheduleCli(services, args);
        }
        if (command === "agents") {
          return await runAgentsCli({ list: () => services.listedAgentProfiles(), registry: agentRegistry(ctx) }, args);
        }
        if (command === "configure" && args.length === 1) {
          const config = prototypeConfigSchema.parse(JSON.parse(args[0]!));
          savePrototypeConfig(db, config);
          return { exitCode:0, stdout:JSON.stringify({ ok:true, projectId:config.projectId }) };
        }
        if (command === "activate" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.activate(args[0]!, args[1]!, args[2] === "cli" ? "cli" : "bb")) };
        }
        if (command === "budget" && args.length >= 1) {
          const projectId = args[0]!;
          for (const pair of args.slice(1)) {
            const [key, value = ""] = pair.split("=", 2) as [string, string?];
            if (!(RUN_BUDGET_SETTINGS as readonly string[]).includes(key)) throw new Error(`unknown budget setting ${key}; use ${RUN_BUDGET_SETTINGS.join(", ")}`);
            if (value !== "" && !/^\d+$/.test(value)) throw new Error(`${key} must be a positive integer or empty`);
            saveProjectSetting(db, projectId, key, value);
          }
          const settings = loadProjectSettings(db, projectId);
          return { exitCode:0, stdout:JSON.stringify({ projectId, budget:Object.fromEntries(RUN_BUDGET_SETTINGS.map((key) => [key, settings[key] ?? ""])) }, null, 2) };
        }
        if (command === "council" && args.length >= 2) {
          const run = getRun(db, args[0]!);
          if (!run || !run.pm_thread_id || run.closed_at) throw new Error("run must be open and have a PM thread");
          const options = Object.fromEntries(args.slice(2).filter((arg) => arg.includes("=")).map((arg) => arg.split("=", 2) as [string, string]));
          const session = await services.council.startCouncil({
            projectId: run.project_id, runId: run.id, pmThreadId: run.pm_thread_id, question: args[1]!,
            roles: options.roles ? options.roles.split(",") : undefined, maxRounds: options.rounds ? Number(options.rounds) : undefined,
            mode: options.mode === "rounds" ? "rounds" : options.mode === "room" ? "room" : undefined, judge: options.judge === "off" ? false : options.judge === "on" ? true : undefined,
            materials: options.materials ? options.materials.split(",") : undefined,
          });
          return { exitCode:0, stdout:JSON.stringify({ id: session.id, state: session.state, seats: session.seats.map((seat) => `${seat.id}:${seat.providerId}/${seat.model}`) }, null, 2) };
        }
        if (command === "council-say" && args.length >= 1) {
          const text = args.slice(1).filter((arg) => !/^decide=/.test(arg)).join(" ").trim();
          const decide = args.some((arg) => /^decide=(1|true|yes)$/.test(arg));
          const said = text ? services.council.say(args[0]!, text) : null;
          const decided = decide ? services.council.requestDecision(args[0]!) : null;
          return { exitCode:0, stdout:JSON.stringify({ said: said ? said.seq : null, decideRequested: Boolean(decided) }) };
        }
        if (command === "council-seats" && args.length === 1) {
          const settings = (await effectiveProjectSettings(args[0]!)).values;
          const keys = ["writer.provider","writer.model","plan_critique.provider","plan_critique.model","code_critique.provider","code_critique.model","specialist.provider","specialist.model","night_review.provider","night_review.model","memory.provider","memory.model","docs.provider","docs.model"];
          return { exitCode:0, stdout:JSON.stringify({ ...await services.council.seatDefaults(args[0]!), settings: Object.fromEntries(keys.map((key) => [key, configuredSetting(settings, key) ?? null])) }, null, 2) };
        }
        if (command === "council-status" && args.length >= 1) {
          const found = getCouncilSession(db, args[0]!);
          if (!found) throw new Error("council not found");
          return { exitCode:0, stdout:JSON.stringify(services.council.councilView(found, args[1] ? Number(args[1]) : 0), null, 2) };
        }
        if (command === "harness" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(await services.harness.status(args[0]!), null, 2) };
        }
        if (command === "harness-edit" && args.length >= 1 && args.length <= 4) {
          const wait = args.includes("wait=1");
          const plain = args.filter((arg) => arg !== "wait=1");
          const run = services.harness.runEditor({ projectId:plain[0]!, area:plain[1] ?? "", writerKey:plain[2] ?? "*", reason:"cli" });
          if (!wait) { void run.catch(() => undefined); return { exitCode:0, stdout:JSON.stringify({ status:"started", detail:"running in the background; bb lane-pilot harness <project-id> shows the trial when it lands" }, null, 2) }; }
          return { exitCode:0, stdout:JSON.stringify(await run, null, 2) };
        }
        if (command === "harness-trajectory" && (args.length === 1 || args.length === 2)) {
          const result = await services.harness.trajectory(args[0]!, args[1]);
          return { exitCode:0, stdout:`# ${result.events} events, ${result.sliced} in the slice\n\n${result.text}` };
        }
        if (command === "harness-tick" && args.length >= 1 && args.length <= 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.harness.tick(args[0]!, { dryRun:args[1] === "dry=1" }), null, 2) };
        }
        if (command === "metrics" && args.length >= 1) {
          const projectId = args[0]!;
          const flag = (name:string) => args.indexOf(name);
          const at = flag("--days");
          const days = at >= 0 ? Number(args[at + 1]) : 7;
          if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days must be an integer from 1 to 90");
          const report = attemptMetrics(db, { projectId, days });
          return { exitCode:0, stdout:flag("--json") >= 0 ? JSON.stringify(report, null, 2) : renderAttemptMetrics(report) };
        }
        if (command === "health" && args.length <= 1) {
          const runIds = args[0] ? [args[0]] : [...services.runBudgets.keys()];
          return { exitCode:0, stdout:JSON.stringify({ providers:services.providerBreaker.snapshot(), runs:runIds.map((runId) => runHealth(services, runId)) }, null, 2) };
        }
        if (command === "state" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(inspectState(db, args[0]!), null, 2) };
        }
        if ((command === "finish" || command === "deactivate") && (args.length === 1 || args.length === 2)) {
          const projectId = args[0]!;
          const runs = listRunsWithAttempts(db, projectId).filter((run) => !run.closed_at);
          const activation = getActivation(db, projectId);
          const runId = args[1] ?? (activation?.run_id && runs.some((run) => run.id === activation.run_id)
            ? activation.run_id
            : runs.length === 1 ? runs[0]!.id : null);
          if (!runId) {
            if (!runs.length) return { exitCode:0, stdout:JSON.stringify({ projectId, finishedRunIds:[], closed:true }) };
            throw new Error("specify a run id when the project has multiple open runs");
          }
          await finishRunSafely(bb, db, projectId, runId, "cli");
          return { exitCode:0, stdout:JSON.stringify({ projectId, finishedRunIds:[runId], closed:true }) };
        }
        if (command === "cancel" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt) return { exitCode:1, stdout:JSON.stringify({ok:false,attemptId:args[0],state:"missing",reason:"attempt does not exist"}) };
          if (!attempt.thread_id) {
            const canceled=cancelQueuedAttempt(attempt);
            return {exitCode:canceled.ok?0:1,stdout:JSON.stringify({attemptId:attempt.id,...canceled})};
          }
          const rejection = cancelRejection(db, attempt);
          if (rejection) return { exitCode:1, stdout:JSON.stringify({ ok:false, attemptId:attempt.id, state:attempt.state, reason:rejection }) };
          transitionAttempt(db, attempt.id, "cancel_requested", { threadId:attempt.thread_id });
          await bb.sdk.threads.stop({ threadId:attempt.thread_id });
          // A stop is two things (SMA rule 9): the writer is confirmed gone, waiting a bounded time for it, and its work is on record.
          const confirmed = await confirmWriterStopped(bb, attempt.thread_id);
          const status = confirmed.status;
          if (!confirmed.stopped) throw new Error(`writer stop was not independently observed (status=${status ?? "unknown"}, waited ${Math.round(confirmed.waitedMs / 1000)}s)`);
          await services.rollback.noteStopped(attempt.id).catch(() => undefined);
          transitionAttempt(db, attempt.id, "canceled", { threadId:attempt.thread_id });
          return { exitCode:0, stdout:JSON.stringify({
            ok:true, attemptId:attempt.id, threadId:attempt.thread_id, state:"canceled", observedStatus:status,
          }) };
        }
        if (command === "recover" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt) throw new Error("attempt does not exist");
          const run = getRun(db, attempt.run_id);
          if (!run?.pm_thread_id) throw new Error("attempt run has no PM thread");
          const writerThreadId = await services.reconcileAttemptThread(run.project_id, attempt);
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:writerThreadId });
          if (valueAt(metadata, "lanePilotRunId") !== attempt.run_id
            || valueAt(metadata, "lanePilotTaskId") !== attempt.task_id
            || valueAt(metadata, "attemptId") !== attempt.id) {
            transitionAttempt(db, attempt.id, "blocked", { threadId:writerThreadId, reason:"idempotency triple mismatch" });
            throw new Error("writer metadata does not match the persisted idempotency triple");
          }
          const thread = await bb.sdk.threads.get({ threadId:writerThreadId });
          if (stringAt(thread, "status") !== "idle") throw new Error(`writer is not idle: ${stringAt(thread, "status") ?? "unknown"}`);
          const config = loadPrototypeConfig(db, run.project_id);
          if (!config) throw new Error("prototype configuration is missing");
          const [hello, test, output] = await Promise.all([
            bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:`${config.writerWorkspacePath}/hello.txt` }),
            bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:`${config.writerWorkspacePath}/tests/hello.test.txt` }),
            bb.sdk.threads.output({ threadId:writerThreadId }),
          ]);
          if (stringAt(hello, "content") !== "hello from native BB writer\n"
            || stringAt(test, "content") !== "hello from native BB writer\n") {
            transitionAttempt(db, attempt.id, "validation_failed", { threadId:writerThreadId, reason:"fixture output content mismatch" });
            throw new Error("reconciled writer output failed validation");
          }
          const savedTask = getTask(db, attempt.task_id);
          if (!savedTask) throw new Error(`reconciled task missing: ${attempt.task_id}`);
          const recoveredTask = taskV2Schema.parse(savedTask.contract);
          const verification = await services.runVerification(config, recoveredTask,attempt.run_id);
          if (verification.some((item) => item.exitCode !== 0)) {
            transitionAttempt(db, attempt.id, "validation_failed", { threadId:writerThreadId, reason:"recovered writer verification failed" });
            throw new Error("reconciled writer verification failed");
          }
          const receipt = await services.persistWriterAcceptance({
            config, task:recoveredTask, runId:attempt.run_id,
            taskId:attempt.task_id, attempt:attempt.attempt_no, attemptId:attempt.id,
            pmThreadId:run.pm_thread_id, writerThreadId, output:outputText(output), verification,
          });
          transitionAttempt(db, attempt.id, "accepted", { threadId:writerThreadId });
          return { exitCode:0, stdout:JSON.stringify(receipt, null, 2) };
        }
        if (command === "start-cancel-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.startCancelProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "start-provider-error-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.startProviderErrorProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "helper-probe" && args.length === 4) {
          const probe = await services.startHelperProbe(args[0]!, args[1]!, args[2]!, args[3]!);
          return { exitCode:probe.ok ? 0 : 1, stdout:JSON.stringify(probe, null, 2) };
        }
        if (command === "memory-probe" && args.length >= 1) {
          const flags = args.slice(1);
          const has = (name: string) => flags.includes(`--${name}`);
          const paths = flags.find((flag) => flag.startsWith("--paths="))?.slice("--paths=".length) ?? (flags.includes("--paths") ? flags[flags.indexOf("--paths") + 1] : undefined);
          if (has("clean")) return { exitCode:0, stdout:JSON.stringify({ removed:services.memoryProbe.clean(args[0]!) }, null, 2) };
          if (has("report")) return { exitCode:0, stdout:JSON.stringify(services.memoryProbe.report(args[0]!), null, 2) };
          const probe = await services.memoryProbe.run({ projectId:args[0]!, paths:paths ? paths.split(",").map((item) => item.trim()).filter(Boolean) : undefined, keep:has("keep"), force:has("force") });
          return { exitCode:probe.ok ? 0 : 1, stdout:JSON.stringify(probe, null, 2) };
        }
        if (command === "memory-eval") {
          return await runMemoryEvalCommand(db, args);
        }
        if (command === "memory-conflicts" || command === "memory-conflict-settle") {
          return runMemoryConflictCli(services.memoryConflicts, command, args);
        }
        if (command === "start-ambiguous-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.startAmbiguousProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "host-detect" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("detect", { requestedHostId:args[0]!, workspacePath:args[1]! }, { hostId:args[0]! }), null, 2) };
        }
        if (command === "host-snapshot" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("snapshotDryRun", { requestedHostId:args[0]!, paths:args.slice(1) }, { hostId:args[0]! }), null, 2) };
        }
        if (command === "host-snapshot-manifest" && args.length >= 1) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("snapshot", {
            requestedHostId:args[0]!,
            threadStoragePath:args[1],
          }, { hostId:args[0]!, timeoutMs:120_000 }), null, 2) };
        }
        if (command === "host-install" && args.length >= 1) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("install", {
            requestedHostId:args[0]!,
            threadStoragePath:args[1],
            pmWorkspacePath:args[2],
            confirmExternalOps:false,
          }, { hostId:args[0]!, timeoutMs:600_000 }), null, 2) };
        }
        if (command === "host-rollback" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("rollback", {
            requestedHostId:args[0]!,
            snapshotPath:args[1]!,
          }, { hostId:args[0]!, timeoutMs:180_000 }), null, 2) };
        }
        if (command === "host-connect-opencode" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("connectOpencode", {
            requestedHostId:args[0]!,
          }, { hostId:args[0]!, timeoutMs:30_000 }), null, 2) };
        }
        if (command === "host-run-cli" && args.length >= 4) {
          const config = loadPrototypeConfig(db, "unused") ;
          void config;
          return { exitCode:0, stdout:JSON.stringify(await host.call("runCli", {
            requestedHostId:args[0]!,
            cwd:args[1]!,
            binary:args[2] as "run-controller"|"lane-ctl",
            argv:args.slice(3),
            env:{},
          }, { hostId:args[0]!, timeoutMs:180_000 }), null, 2) };
        }
        if (command === "resume") {
          return { exitCode:0, stdout:JSON.stringify(await services.resumeOrphans(args[0]), null, 2) };
        }
        if (command === "dispatch-cli" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.dispatchCli({
            projectId:args[0]!,
            threadId:args[1]!,
            binary:args[2] as "run-controller"|"lane-ctl"|undefined,
            subcommand:args[3],
            taskFile:args[4] || undefined,
            taskId:args[5] || undefined,
            runDir:args[6] || undefined,
          }), null, 2) };
        }
        if (command === "dispatch-bb" && args.length >= 2) {
          const task = args[2] ? taskV2Schema.parse(JSON.parse(args[2])) : undefined;
          return { exitCode:0, stdout:JSON.stringify(await services.dispatchWriter({
            projectId:args[0]!,
            threadId:args[1]!,
            task,
            baseRef:args[3]||undefined,
            ...(args[4] ? { criticCodeDefault:requireCriticCodeDefault(args[4]) } : {}),
          }), null, 2) };
        }
        if (command === "docs-nightly" && args.length >= 1 && args.length <= 3) {
          return { exitCode:0, stdout:JSON.stringify(await services.runNightlyDocs({force:true,projectId:args[0]!,path:args[1],base:args[2]}), null, 2) };
        }
        if (command === "wait-thread" && args.length === 1) {
          const threadId = args[0]!;
          const startedAt = Date.now();
          try {
            await waitThreadIdle(bb,threadId,"wait_thread_probe_timeout", 15_000);
            const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
            const listed = await listThreadEventsRaw(bb, {
              threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50",
            });
            const decision = listed.ok
              ? decideThreadCompletion({
                threadId,
                status:stringAt(thread, "status"),
                queuedWork:stringAt(thread, "queuedWork"),
                events:listed.events,
              })
              : { ok:false as const, via:"incomplete" as const, detail:listed.detail };
            return { exitCode: decision.ok ? 0 : 1, stdout:JSON.stringify({
              threadId,
              helper:"waitThreadIdle",
              elapsedMs:Date.now() - startedAt,
              status:stringAt(thread, "status"),
              decision,
            }) };
          } catch (cause) {
            return { exitCode:1, stdout:JSON.stringify({
              threadId,
              helper:"waitThreadIdle",
              elapsedMs:Date.now() - startedAt,
              ok:false,
              error:cause instanceof Error ? cause.message : String(cause),
            }) };
          }
        }
        if (command === "events-list" && args.length === 1) {
          const threadId = args[0]!;
          const filteredQuery = { threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc" as const, limit:"50" as const };
          const unfilteredQuery = { threadId, order:"desc" as const, limit:"50" as const };
          const summarize = (listed: unknown[]) => listed.map((row) => ({
            seq: row && typeof row === "object" ? Reflect.get(row, "seq") : null,
            type: row && typeof row === "object" ? Reflect.get(row, "type") : null,
            threadId: row && typeof row === "object" ? Reflect.get(row, "threadId") : null,
            status: row && typeof row === "object" && Reflect.get(row, "data") && typeof Reflect.get(row, "data") === "object"
              ? Reflect.get(Reflect.get(row, "data") as object, "status") : null,
          }));
          const filtered = await listThreadEventsRaw(bb, filteredQuery);
          const unfiltered = await listThreadEventsRaw(bb, unfilteredQuery);
          return { exitCode:0, stdout:JSON.stringify({
            threadId,
            filtered: filtered.ok
              ? { ok:true, query:eventsListQueryLabel(filteredQuery), n:filtered.events.length, rows:summarize(filtered.events) }
              : { ok:false, kind:filtered.kind, detail:filtered.detail },
            unfiltered: unfiltered.ok
              ? { ok:true, query:eventsListQueryLabel(unfilteredQuery), n:unfiltered.events.length, rows:summarize(unfiltered.events) }
              : { ok:false, kind:unfiltered.kind, detail:unfiltered.detail },
          }, null, 2) };
        }
        if (command === "host-import-config" && args.length >= 2) {
          const imported = await host.call("importConfig", {
            requestedHostId:args[0]!,
            projectId:args[1]!,
            workspacePath:args[2],
          }, { hostId:args[0]!, timeoutMs:30_000 });
          const persisted = importSettingsOnce(db, args[1]!, imported.imported);
          return { exitCode:0, stdout:JSON.stringify({ ...imported, persisted }, null, 2) };
        }
        return { exitCode:1, stderr:usage };
      } catch (cause) {
        return { exitCode:1, stderr:cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });
}
