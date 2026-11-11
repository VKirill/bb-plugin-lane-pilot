import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { listReviewedObservations } from "../../learning";
import { prototypeConfigSchema, taskV2Schema } from "../../contracts";
import { taskBaselineEntries } from "../../baseline";
import { attemptStateCounts, failureFieldsOf, getActivation, getAttempt, getRun, getRunWriterHost, getTask, importSettingsOnce, inspectAttempt, inspectState, listAttemptReasonsSince, listRunsWithAttempts, loadProjectSettings, loadPrototypeConfig, markCancelCode, saveProjectSetting, savePrototypeConfig, transitionAttempt, failedTasksAllProjects, listNearMissReceipts } from "../../storage";
import { outsideWorkSummary } from "../../owner-presence";
import { cancelAttemptById, finishRunSafely, pauseRun } from "../../runs/server";
import { conveyorState, renderTimeline, setConveyor, taskTimeline, unknownReasons } from "../../runs";
import { TASK_RECORD_USAGE, blindRecord, readsBlind, renderTaskRecord, taskRecord } from "./task-record";
import {bestEffort, isNotFound, orMiss, outputText, pluginRootFromModule, spawnAsync, stringAt, valueAt} from "@lane-pilot/kit";
import { PAIR_ROLE_SPECS } from "@lane-pilot/models";
import {runSkillsCli, parseSkillHub, SKILLS_USAGE} from "../../platform/server";
import {codeFactsOnHost, CODE_FACTS_REFRESH} from "../../platform";
import {runOnHost} from "@lane-pilot/host-calls";
import { attemptSessionLayers, terminalParity, terminalSessionLayers } from "../../native-agent";
import { projectStats } from "./project-stats";
import { THREAD_WATCH_EVENT_TYPES, decideThreadCompletion, eventsListQueryLabel, listThreadEventsRaw, waitThreadIdle } from "@lane-pilot/thread-observe";
import type { InsightsApi, ScheduleAgentApi } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { RUN_BUDGET_SETTINGS, runHealth } from "../../stability/server";
import { ERRAND_EPISODE_TRACE_EVENTS, configuredSetting } from "../../contracts/server";
import { getCouncilSession } from "@lane-pilot/council";
import { SCHEDULE_USAGE, runScheduleCli, scheduleFailureSweep } from "../../schedule/server";
import { answerWorkflowQuestion } from "../../workflow/server";
import { AGENTS_USAGE, agentRegistry, PM_SKILLS_USAGE, runAgentsCli, runPmSkillsCli, runPmSkillUseCli } from "../../native-agent/server";

import { ANAMNESIS_USAGE, anamnesisFor, collectOwnerMessages, sdkThreadsPort } from "../../anamnesis";
import { LEARNING_USAGE, learningFor, runLearningCli } from "../../learning";
import { PM_REPLAY_USAGE, runPmReplayCli, listScenarios } from "../../pm-replay";
import { attemptMetrics, renderAttemptMetrics } from "../../usage/server";
import { DEFERRAL_USAGE, runDeferralCli } from "../../deferral/server";
import { MEMORY_EVAL_USAGE, runMemoryEvalCommand } from "../../memory-eval/server";
import { MEMORY_CONFLICT_USAGE, runMemoryConflictCli, sessionMemoryRpc, memorySettingsFor, type WallThreadReader } from "../../memory/server";
import { dropMemoryIndexes, hideRecord, lintMemory, listMemory, memoryConceptsJson, memoryIndexStatus, memoryRecordExists, memoryTokenStats, rebuildMemoryIndexes, recordMemoryMiss, reviewMemory } from "@lane-pilot/memory-core";
import { BENCH_USAGE, runBenchCli } from "../../bench/server";
import { BASELINE_USAGE, runBaselineCli } from "../../baseline/server";
import { RETURN_USAGE, runReturnCli } from "../../stage-return/server";
import { FORECAST_USAGE, runForecastCli } from "../../forecast/server";
import { calibrationPassport } from "../../forecast/server";
import { RUN_GOAL_USAGE, runGoalSweep, runRunGoalCli } from "../../run-goal/server";
import { CAPABILITY_USAGE, runCapabilityCli } from "../../capability/server";
import { workerSecretReach } from "../../verification";
import { explainCatalog, explainWord, guideDocs } from "./explain";
import { VERDICT_LIST_COMMAND, renderVerdicts, verdictFiles, verdictInventory } from "./verdicts";
import { OUTAGE_USAGE, runOutageCli } from "../../outage/server";
import { BACKLOG_USAGE, runBacklogCli } from "../../backlog/server";
import { runHypothesisCli } from "../../hypotheses/server";
import { tierReport } from "../../memory-tiers/server";
import { WALL_USAGE, runWallCli } from "../../wall/server";
import { CHECKERS_USAGE, runCheckersCli } from "../../checkers/server";
import { POLICY_USAGE, loadLiveExam, runPolicyCli } from "../../policy";
import { WAITING_USAGE, runWaitingCli } from "../../owner-waiting/server";
import type { LearningItemsReader } from "../../owner-waiting";
import { LEAD_USAGE, runLeadCli } from "../../lead/server";
import { COVERAGE_USAGE, runCoverageCli } from "../../coverage";
import { mergeFrontmatter, parseFrontmatter, setFrontmatter } from "../../docs";
import { SMA_MAP_USAGE, runSmaLiveCli, runSmaMapCli, smaCheckedPercent, smaCounts, smaDonePercent, smaRows } from "../../sma-map";
import { designJournalLines, readinessWords, trainedConditions, trainingRatios } from "../../design-eval";
import { DESIGN_PAIR_USAGE, runDesignPairCli } from "../../design-eval/server";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import { getPhase } from "../../phase";
import { jev } from "@lane-pilot/jev";
import { PHASE_USAGE, phaseWordSweep, runPhaseCli } from "../../phase/server";
import { attemptRecord, manifest, passport, preship, prPassport, receiptChain, subagentReceipts, verifyChain } from "./receipts";
import { listTripped, rearmBreaker, breakerRowId } from "../../learning";
import { EXCAVATE_LOG_ARGS, approvalSuggestions, costPerVerified, excavate, htmlReport, missCurriculum } from "./self-improve";
import { RULES_USAGE, runRulesCli } from "../../rule-forms";
import { JEV_USAGE, runJevCli } from "../../jev";
import { ERRANDS_USAGE, runErrandsCli } from "../../errands";
import { retireAdoptedRule } from "../../self-repair/server";
import { ROLLBACK_USAGE, runRollbackCli } from "../../rollback/server";
import { casUpsertSettings, deleteBoundSetting, getSettingVersions, listEvidence, listSettingRows } from "../../storage";
import { UNLISTED_SWITCHES, switchValue } from "../../settings";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { integrityReport, renewDisarm } from "../../policy";
import { isCodeCriticDefault } from "../../contracts/task-enums"
import { CODE_CRITIC_DEFAULTS } from "../../contracts/task-enums";
import { runSkillLintCli } from "../../forge";
import { EPISODES_USAGE, runEpisodesCli } from "../../errands/server";
import { episodeSweepDeps } from "../../night-graphs/server";

import type { BacklogApi } from "../../backlog/server/scanner";
import type { BenchApi } from "../../bench/service";
import type { CapabilitiesApi } from "../../capability/server/capability";
import type { CheckersApi } from "../../checkers/api";
import type { CouncilApi } from "../../council/server/council";
import type { DeferralApi } from "../../deferral/service";
import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { HarnessApi } from "../../harness/server/harness";
import type { HypothesesApi } from "../../hypotheses/server/hypotheses";
import type { LeadApi } from "../../lead/server/service";
import type { MemoryProbeApi } from "../../memory-probe/server/memory-probe";
import type { MemoryConflictsApi } from "../../memory/server/memory-conflicts";
import type { MoneyApi } from "../../money/server";
import type { ActivationApi } from "../../contracts/agent-ops";
import type { OwnerPresenceApi } from "../../owner-presence/server/presence";
import type { PhaseApi } from "../../phase/server/driver";
import type { PhaseIntake } from "../../phase/server/intake";
import type { PmReplay } from "../../pm-replay/service";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RunGoalApi } from "../../run-goal/server/run-goal";
import type { ProbesApi } from "../../stability/server/probes";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { StageReturnApi } from "../../stage-return/server/stage-return";
import type { WallApi } from "../../wall/service";
import { writerQuestionSweep, budgetSpentSweep } from "../../writer/server";
import type { WriterDispatchApi } from "../../writer/server/dispatch";
import type { WriterStateApi } from "../../writer/server/state";
import type { WriterVerifyApi } from "../../writer/server/verify";

import type { BaselineApi } from "../../baseline/server/baseline";
import type { ScheduleService } from "../../schedule/server/schedule-service";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";

import type { RegressionApi } from "../../baseline/server/regress";
import type { WriterSpawnApi } from "../../writer/server/spawn";
import type { WriterStartApi } from "../../writer/server/start";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activate: ActivationApi["activate"];
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  backlog: BacklogApi;
  baseline: BaselineApi;
  bench: BenchApi;
  capabilities: CapabilitiesApi;
  checkers: CheckersApi;
  council: CouncilApi;
  deferrals: DeferralApi;
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  docsPlaces: DocsNightlyApi["docsPlaces"];
  harness: HarnessApi;
  hypotheses: HypothesesApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  lead: LeadApi;
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  memoryConflicts: MemoryConflictsApi;
  memoryProbe: MemoryProbeApi;
  money: MoneyApi;
  wallThreadReader: WallThreadReader;
  ownerLearningItems: LearningItemsReader;
  ownerPresence: OwnerPresenceApi;
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  phaseIntake: PhaseIntake;
  phases: PhaseApi;
  pmReplay?: PmReplay;
  providerBreaker: WriterStateApi["providerBreaker"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  regression: RegressionApi;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  resumeOrphans: ReconcileApi["resumeOrphans"];
  rollback: RollbackApi;
  ruleScan: RuleScanApi;
  insights: InsightsApi;
  scheduleAgents: ScheduleAgentApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runBudgets: WriterStateApi["runBudgets"];
  runGoal: RunGoalApi;
  runNightlyDocs: DocsNightlyApi["runNightlyDocs"];
  schedules: ScheduleService;
  stageReturn: StageReturnApi;
  startAmbiguousProbe: ProbesApi["startAmbiguousProbe"];
  startCancelProbe: ProbesApi["startCancelProbe"];
  startHelperProbe: ProbesApi["startHelperProbe"];
  startProviderErrorProbe: ProbesApi["startProviderErrorProbe"];
  startWriterTask: WriterStartApi["startWriterTask"];
  validateWriterResult: WriterVerifyApi["validateWriterResult"];
  wall: WallApi;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

const MEMORY_CLI_USAGE = 'bb lane-pilot memory search "<question>" [--project P] | memory write "<fact>" [--project P]   (the project memory on the hub; inside a BB thread the project is the thread\'s own)';

const OWNER_ITEM_SWEEPS = [writerQuestionSweep, runGoalSweep, phaseWordSweep, scheduleFailureSweep];
import type { CodeCriticDefault } from "../../contracts/task-enums";

import type { WorkflowEngineApi, WorkflowTriggersApi, WriterHostApi } from "../../platform/server";

function requireCriticCodeDefault(value: string): CodeCriticDefault {
  if (!isCodeCriticDefault(value)) throw new Error(`critic.code.default_for_risk must be one of ${CODE_CRITIC_DEFAULTS.join(", ")}`);
  return value;
}

/** `timeline <task-id> [--run <run-id>] [--json]`: without --run the first bare word is the task (it was skipped until 2026-11-02). */
export function timelineArgs(args: string[]): { taskId: string | undefined; runId: string | undefined } {
  const runAt = args.indexOf("--run");
  return { taskId: args.find((arg, index) => !arg.startsWith("--") && (runAt < 0 || index !== runAt + 1)), runId: runAt >= 0 ? args[runAt + 1] : undefined };
}

export function registerCli(ctx: ServerCore, services: Services, migrations: readonly string[]) {
  const { bb, db, effectiveProjectSettings, host } = ctx;

  const usage = [
    "bb lane-pilot configure <json>",
    "bb lane-pilot activate <project-id> <ordinary-source-thread-id>",
    "bb lane-pilot state <project-id> [--limit N] [--before <created-at[:id]>] [--attempt <attempt-id> [--reason-offset N]]",
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
    MEMORY_CLI_USAGE,
    "bb lane-pilot host-detect <host-id> <workspace-path>",
    "bb lane-pilot host-snapshot <host-id> <absolute-path>...",
    "bb lane-pilot host-snapshot-manifest <host-id> [thread-storage]",
    "bb lane-pilot host-install <host-id> [thread-storage] [pm-workspace]",
    "bb lane-pilot remove-claude-lane-leftovers <host-id> [--apply]",
    "bb lane-pilot host-rollback <host-id> <snapshot-path>",
    "bb lane-pilot host-connect-opencode <host-id>",
    "bb lane-pilot host-import-config <host-id> <project-id> [workspace-path]",
    "bb lane-pilot resume [project-id]",
    "bb lane-pilot dispatch-bb <project-id> <pm-thread-id> [task-json] [base-ref] [critic-code-default: off|medium|high]",
    "bb lane-pilot events-list <thread-id>",
    "bb lane-pilot wait-thread <thread-id>",
    "bb lane-pilot workflow-trigger <project-id> <workflow-id> [inputs-json] [key]",
    "bb lane-pilot workflow-answer <run-id> <step-key> <option or words>",
    "bb lane-pilot workflow-cancel <run-id> [reason]",
    SCHEDULE_USAGE,
    AGENTS_USAGE,
    ANAMNESIS_USAGE,
    DEFERRAL_USAGE,
    POLICY_USAGE,
    WAITING_USAGE,
    LEAD_USAGE,
    COVERAGE_USAGE,
    SMA_MAP_USAGE,
    PHASE_USAGE,
    RULES_USAGE,
    JEV_USAGE,
    SKILLS_USAGE,
    PM_SKILLS_USAGE,
  ].join("\n");

  const commands:Array<{ name:string; summary:string; usage:string }> = [
      { name:"configure", summary:"Save prototype project settings", usage:"bb lane-pilot configure '<json>'" },
      { name:"skills", summary:"Searchable skill catalog list for the PM", usage:SKILLS_USAGE },
      { name:"pm-skills", summary:"Which skills PM sessions opened lately", usage:PM_SKILLS_USAGE },
      { name:"activate", summary:"Spawn a visible isolated PM thread", usage:"bb lane-pilot activate <project-id> <ordinary-source-thread-id>" },
      { name:"state", summary:"Inspect a project's runs and attempts, newest first, one page at a time", usage:"bb lane-pilot state <project-id> [--limit N] [--before <created-at[:id]>] [--attempt <attempt-id> [--reason-offset N]]" },
      { name:"setting", summary:"The settings that have no row in the settings window: list them with what each does, show a project's or the hub's values, set one (empty value clears). Only the owner at a terminal sets", usage:"bb lane-pilot setting [<project-id>|global [key=value …]]" },
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
      { name:"task", summary:"One task's record for another agent: what it asked for, what the server saw done (changed files, merge), acceptance against fact, what is left", usage:TASK_RECORD_USAGE },
      { name:"changes", summary:"What is on record for a task or an attempt: base, merge, changed files (deletions included) and the reverify / revert receipts", usage:"bb lane-pilot changes <task-id|attempt-id>" },
      { name:"evidence", summary:"The reason and checks stored before each risky operation, newest first", usage:"bb lane-pilot evidence <project-id> [--op permit|revert|janitor] [--days N]" },
      { name:"integrity", summary:"Each protection with its hazard, armed and current value, disarm term and shadow findings; renew a disarm with a reason", usage:"bb lane-pilot integrity [project-id] [--renew <key> --days N --why <cause>]" },
      { name:"airbag", summary:"List, prune and probe the return points (refs/lane-airbag/*) of a project's checkout", usage:"bb lane-pilot airbag <project-id> [--prune DAYS] [--probe]" },
      { name:"recover", summary:"Reconcile a known writer identity and emit its validated receipt", usage:"bb lane-pilot recover <attempt-id>" },
      { name:"start-cancel-probe", summary:"Spawn a long-running writer for a live stop observation", usage:"bb lane-pilot start-cancel-probe <project-id> <pm-thread-id>" },
      { name:"start-provider-error-probe", summary:"Observe a live provider error and persist provider_error", usage:"bb lane-pilot start-provider-error-probe <project-id> <pm-thread-id>" },
      { name:"helper-probe", summary:"Start one cheap helper (pm-read path) on a provider and check it answered", usage:"bb lane-pilot helper-probe <project-id> <run-id> <provider-id> <model>" },
      { name:"memory-probe", summary:"Plant a token through the memory write door and check that every delivery path (writer brief, PM, critics) hands it to its agent; sandbox project only unless --force", usage:"bb lane-pilot memory-probe <project-id> [--paths a,b] [--keep] [--clean] [--report] [--force]" },
      { name:"memory-eval", summary:"Score memory retrieval at 30, 300 and 3000 notes on real accepted tasks (right answer, nothing relevant, off-topic) against a plain path-and-keyword baseline; reads the hub data, writes nothing", usage:MEMORY_EVAL_USAGE },
      { name:"memory-conflicts", summary:"Memory notes that disagree: held out of every brief until a person settles them; --detect looks for new ones", usage:"bb lane-pilot memory-conflicts [--project P] [--state held|settled] [--detect]" },
      { name:"memory-conflict-settle", summary:"Settle a held memory conflict: keep one note, both, or neither, with the evidence", usage:"bb lane-pilot memory-conflict-settle <mc_id> --keep a|b|both|none --evidence <text>" },
      { name:"start-ambiguous-probe", summary:"Create duplicate metadata and prove reconcile blocks", usage:"bb lane-pilot start-ambiguous-probe <project-id> <pm-thread-id>" },
      { name:"host-detect", summary:"Call the host worker detect method", usage:"bb lane-pilot host-detect <host-id> <workspace-path>" },
      { name:"host-snapshot", summary:"Call read-only snapshotDryRun", usage:"bb lane-pilot host-snapshot <host-id> <absolute-path>..." },
      { name:"host-snapshot-manifest", summary:"Full §11.1 snapshot", usage:"bb lane-pilot host-snapshot-manifest <host-id> [thread-storage]" },
      { name:"host-install", summary:"Install target SHA without external ops", usage:"bb lane-pilot host-install <host-id> [thread-storage] [pm-workspace]" },
      { name:"remove-claude-lane-leftovers", summary:"Move Claude Lane leftovers on one machine into a dated backup. Dry-run unless --apply", usage:"bb lane-pilot remove-claude-lane-leftovers <host-id> [--apply]" },
      { name:"host-rollback", summary:"Rollback a snapshot", usage:"bb lane-pilot host-rollback <host-id> <snapshot-path>" },
      { name:"host-connect-opencode", summary:"S5 JSONC plugin patch", usage:"bb lane-pilot host-connect-opencode <host-id>" },
      { name:"host-import-config", summary:"S7 one-shot YAML read", usage:"bb lane-pilot host-import-config <host-id> <project-id> [workspace-path]" },
      { name:"resume", summary:"Reconcile orphaned writer attempts without spawning duplicates", usage:"bb lane-pilot resume [project-id]" },
      { name:"dispatch-bb", summary:"Dispatch a BB writer task, optional task-v2 JSON", usage:"bb lane-pilot dispatch-bb <project-id> <pm-thread-id> [task-json] [base-ref] [critic-code-default: off|medium|high]" },
      { name:"events-list", summary:"Read-only SDK events.list probe", usage:"bb lane-pilot events-list <thread-id>" },
      { name:"wait-thread", summary:"Read-only waitThreadIdle probe", usage:"bb lane-pilot wait-thread <thread-id>" },
      { name:"anamnesis", summary:"What Lane Pilot knows about its owner (records on the owner's machine); sensitive ones only on explicit request", usage:"bb lane-pilot anamnesis status|list|show|history|add|edit|confirm|reject|forget|sources|host" },
      { name:"learning", summary:"What Lane Pilot learned from the owner's own messages: status, review, learned items, yes or no, settings", usage:LEARNING_USAGE },
      { name:"pm-replay", summary:"The PM replay set: scenarios grown from the owner's corrections, replayed on the PM surface to prove PM rules", usage:PM_REPLAY_USAGE },
      { name:"policy-exam", summary:"Score the night policy on the newest unseen split (owner decisions made after its freeze) and store the result; a failed or short exam is a measurement and does not change what the night may decide", usage:"bb lane-pilot policy-exam" },
      { name:"policy", summary:"The night policy: show the lists, classify a change descriptor, the three-line morning list", usage:"bb lane-pilot policy show|classify '<json>'|exam-collect|exam-add '<json>'|exam-export|morning" },
      { name:"waiting", summary:"Everything only the owner can decide, with why, evidence and the exact action; what went red overnight; the Telegram digest of new items (quiet hours 23:00-08:00 Europe/Madrid by default)", usage:WAITING_USAGE },
      { name:"lead", summary:"Штурман, the lead over the runs: its state and ticks, the road tree, the owner's answers to its proposals, the rights per class, the decision journal with the prediction made before each answer, the exam and the backtest", usage:LEAD_USAGE },
      { name:"coverage", summary:"What proves each pipeline stage, attempt transition, failure class, gate, memory path, room and key mechanism: covered live by a deploy-drill scenario, covered by tests only (and why no drill), or not covered; --receipt checks the live claims against a drill receipt", usage:COVERAGE_USAGE },
      { name:"frontmatter", summary:"Read, set and merge a file's YAML header; the body is never touched and a file changed under the read is refused", usage:"bb lane-pilot frontmatter <project-id> <path> [--set k=v]... [--merge k=a,b]..." },
      { name:"attempt", summary:"One attempt's whole record: writer thread, stage receipts and gate events of that attempt, dispatch context, verification results, critic input hash, the attempt-change row", usage:"bb lane-pilot attempt <attempt-id>" },
      { name:"stats", summary:"Project report (sma-stats): phases, plans, requirements, git metrics, a timeline and the attempt metrics", usage:"bb lane-pilot stats [project-id] [--days N]" },
      { name:"parity", summary:"Session and terminal parity of one attempt: six lines (hooks, memory, rules, skills, permissions, model) saying whether the BB session and a terminal session got the same layer", usage:"bb lane-pilot parity <attempt-id> [--json]" },
      { name:"passport", summary:"An attempt's passport: provider, model, harness and Lane Pilot versions, the receipts of its stages; --calibration prints the current PM model's calibration badge", usage:"bb lane-pilot passport <attempt-id> | --calibration --project <id>" },
      { name:"manifest", summary:"This build: name, version, its tables", usage:"bb lane-pilot manifest" },
      { name:"intel", summary:"The code facts of a project: whether the GitNexus index exists, is fresh or lags HEAD, and --refresh re-analyzes it on the project's machine", usage:"bb lane-pilot intel <project-id> [--refresh]  (from a thread: its own project only, --refresh from the PM thread only)" },
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
      { name:"gates", summary:"Gate firings: mark one a false alarm so it stops counting against the gate", usage:"bb lane-pilot gates ack <event-id> --why \"<reason>\"" },
      { name:"design-metrics", summary:"The designer's training: the four ratios from the design measurement journal, the four conditions of «trained» and the readiness words", usage:"bb lane-pilot design-metrics [--project <id>] [--json]" },
      { name:"design-pair", summary:"Paired design judgement of two pages: measures both, asks the judge, asks the owner (owner at a terminal or the project's PM chat; one pair per phase unless --again)", usage:DESIGN_PAIR_USAGE.split("   |   ")[0]! },
      { name:"design-pair-answer", summary:"The owner's pick for a started design pair; closes its waiting item", usage:DESIGN_PAIR_USAGE.split("   |   ")[1]! },
      { name:"sma-map", summary:"The SMA product map node by node: what Lane Pilot has for each of its 1798 nodes, the card text, the proof link, the contract tests that check it, and the shares mapped and checked", usage:SMA_MAP_USAGE },
      { name:"explain", summary:"One word about a verb or a concept: the verb's summary and usage with the doc that names it, or the guide doc whose front matter declares the topic", usage:"bb lane-pilot explain <verb or topic>" },
      { name:"planning", summary:"The planning verdicts inventory: every spike and sketch under .agents/planning with its question and verdict (open when none)", usage:"bb lane-pilot planning verdicts <projectId>" },
      { name:"rules", summary:"The rules by form (always | skill | check | hook | memory) and the mechanism that enforces each; classify them, generate mechanism tasks for the recurring check rules, retire the text a mechanism now holds", usage:RULES_USAGE },
      { name:"workflow-trigger", summary:"Start a workflow in a project as its schedule trigger does (the automation of a schedule calls this); exit 1 with the reason when it cannot start", usage:"bb lane-pilot workflow-trigger <project-id> <workflow-id> [inputs-json] [key]" },
      { name:"workflow-answer", summary:"Answer the question a workflow run in a project without a PM chat put on the owner's list (the option, or words that name one, or a free answer)", usage:"bb lane-pilot workflow-answer <run-id> <step-key> <option or words>" },
      { name:"workflow-cancel", summary:"Stop a running or waiting workflow run and its child runs: open steps end canceled, helper threads are stopped; exit 1 when the run is not found or already over. A writer attempt it started goes on: stop it with `cancel <attempt-id>`", usage:"bb lane-pilot workflow-cancel <run-id> [reason]" },
      { name:"defer", summary:"Put a mandatory check off: write it in the register with the reason. It is born with no term (only a date in a message of the owner sets one, --owner-msg) and counts as unproven in its project's phase acceptance until closed with evidence", usage:"bb lane-pilot defer <what> --kind drill_scenario|skipped_test|gate|plan_decision --reason \"…\" [--area A] [--project P]" },
      { name:"defer-close", summary:"Close a deferral with the evidence that settles it", usage:"bb lane-pilot defer-close <dfr_id> --evidence <text>" },
      { name:"deferrals", summary:"The register of deferrals: overdue and open, with their terms", usage:"bb lane-pilot deferrals [--project P] [--state open|overdue|closed]" },
      { name:"owner-presence", summary:"Where the owner typed in a session of his own in the last minutes: Lane Pilot's writers keep off that provider meanwhile", usage:"bb lane-pilot owner-presence [--journal]" },
      { name:"hypothesis", summary:"Ideas to make the system better (from outside or inside) as the settings that carry them, checked on the bench set: two arms, the verdict, adoption through the night policy", usage:"bb lane-pilot hypothesis list|add|test|verdict|revert" },
      { name:"memory-tiers", summary:"The memory's cold tier (notes unused for 90 days, kept out of briefs) and how many of it a PM needed again, plus the PM queries that found nothing (candidates for memory-eval's golden set)", usage:"bb lane-pilot memory-tiers [--project P]" },
      { name:"backlog", summary:"A project's ready todos sorted for issue: issuable in queue order (estimate at most 13, dependencies done), to estimate, to split, blocked; --scan hands the next ones to the PMs now", usage:BACKLOG_USAGE },
      { name:"failures", summary:"Every failed task of every project, one line per task (the latest attempt in a failed state): the unified failure journal", usage:"bb lane-pilot failures [--since <days>]" },
      { name:"conveyor", summary:"The conveyor switch: off, no new work is issued anywhere (writers wait, parked tasks stay, the night queues nothing) while running stages finish and checks go on", usage:"bb lane-pilot conveyor on|off [reason]|status" },
      { name:"outages", summary:"The gaps of more than 5 minutes when Lane Pilot was not running", usage:OUTAGE_USAGE },
      { name:"capabilities", summary:"Per provider in use: the adapter (BB plugin) version installed and whether it is proven to answer; --probe tries the unproven ones now", usage:CAPABILITY_USAGE },
      { name:"run-goal", summary:"Every accepted task's checks of a run together on the final main (two tasks green alone can break each other): check one run, sweep the finished ones, or read a verdict", usage:RUN_GOAL_USAGE },
      { name:"forecast", summary:"The PM's forecasts (contract `forecast`) against the facts of accepted tasks: files, first try, tokens and minutes, per area", usage:FORECAST_USAGE },
      { name:"breaker", summary:"Tripped rules of the loop breaker; rearm <id> --why <text> re-arms one after review", usage:"bb lane-pilot breaker [project-id] | bb lane-pilot breaker rearm <id> --why <text>" },
      { name:"nearmiss", summary:"Near misses helpers reported — a channel outside scoring", usage:"bb lane-pilot nearmiss [--project P] [--days N]" },
      { name:"subagent-receipts", summary:"Receipt coverage, phantoms and subagent pack size of writer attempts", usage:"bb lane-pilot subagent-receipts [--project P] [--days N]" },
      { name:"regress", summary:"Regression after acceptance: the last accepted tasks' cheap checks on current main, a bisect to the first bad commit for the ones gone red; --plan only picks, --dry-run writes nothing, nothing is reverted", usage:BASELINE_USAGE },
      { name:"regressions", summary:"The regression findings still open (--all for settled ones too)", usage:"bb lane-pilot regressions [project-id] [--all]" },
      { name:"regress-close", summary:"Settle a regression finding by hand", usage:"bb lane-pilot regress-close <id> <reason...>" },
      { name:"baseline", summary:"The checks already green or red on the base a task started from, and what turned red after its merge", usage:"bb lane-pilot baseline <task-id>" },
      { name:"timeline", summary:"One task's record in time order, as written while it ran: attempts, every state move with its reason, stage and gate events, the baseline; the post-mortem view", usage:"bb lane-pilot timeline <task-id> [--run <run-id>] [--json]" },
      { name:"return", summary:"Send a task back to discussion, planning or the writer with a note: recorded, the stale receipts reset, the running attempt stopped with the exit confirmed, the work restarted from that stage with the note in its input", usage:"bb lane-pilot return <task-id> --to discussion|planning|writer --note \"…\"" },
      { name:"returns", summary:"The returns on record for a task: the note, the stale and kept stages, how far each got", usage:"bb lane-pilot returns <task-id>" },
      { name:"bench", summary:"LP-Bench: a fixed set of real past tasks replayed on an arm (writer, harness tree, setting) and compared in pairs: stages passed, cost, time", usage:BENCH_USAGE },
      { name:"wall", summary:"The wall journal and the night loop: failures grouped by class, the 3/10-5/100-6/500 recurrence, the night's repairs, hunters and the backlog, re-runs on the new head", usage:WALL_USAGE },
      { name:"checkers", summary:"Checking the checkers: plant known defects in accepted candidates, run every checker on them and print the checker scorecard (score, scorecard, drill, defects)", usage:CHECKERS_USAGE },
      { name:"schedule", summary:"The schedule board: scheduled workflows, errands and scripts (list, show, history, preview, create, update, pause, resume, run-now, delete)", usage:SCHEDULE_USAGE },
      { name:"agents", summary:"The agents the owner can pick: list and show the bundled ones, create, update and delete his own (a JSON or a markdown file with frontmatter)", usage:AGENTS_USAGE },
      { name:"memory", summary:"The project memory on the hub: search it with a question, write one fact; inside a BB thread the project is the thread's own", usage:MEMORY_CLI_USAGE },
      { name:"jev", summary:"Jev judgments: calibration, labels by source, watch", usage:JEV_USAGE },
      { name:"pm-skill-use", summary:"Record that a PM session opened a skill", usage:"bb lane-pilot pm-skill-use <skill> --thread <thread-id> [--project <project-id>]" },
      { name:"skill-lint", summary:"Lint a local skill folder against the skill standard (SKILL.md, references/, scripts/): errors and warnings, exit 1 on errors", usage:"bb lane-pilot skill-lint <dir>" },
      { name:"errands", summary:"Errands: backfill episode rows for past runs (repeated processes first); the process-key eval over the gold set", usage:`${EPISODES_USAGE}
${ERRANDS_USAGE}` },
  ];
  // The help is the hand list above plus every registered command it does not name: regress, regressions, regress-close and
  // timeline were missing from it, and a PM told the owner a quarantine could not be lifted (2026-11-02).
  const usageText = [usage, ...commands.filter((c) => !new RegExp(`^bb lane-pilot ${c.name}(\\s|$)`, "m").test(usage))
    .map((c) => `${c.usage.split("\n")[0]}   (${c.summary})`)].join("\n");

  bb.cli.register({
    name:"lane-pilot",
    summary:"Lane Pilot stage-0 prototype controls",
    commands,
    async run(argv, invocation) {
      try {
        const [command, ...args] = argv;
        // The same door as the tools: a PM's shell does not start work (a schedule, a dispatch, a workflow, a council) for a request
        // the machine took. Automations and drills call the CLI without a thread and are not touched.
        const launches = command === "schedule" ? ["create", "update", "run-now"].includes(args[0] ?? "") : ["dispatch-bb", "workflow-trigger", "council"].includes(command ?? "");
        const refusal = invocation?.threadId && launches ? await services.phaseIntake.launchRefusal(invocation.threadId) : null;
        if (refusal) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:refusal }) };
        if (command === "reverify" || command === "revert" || command === "changes") {
          return await runRollbackCli(services.rollback, command, args);
        }
        if (command === "evidence") {
          const [projectId] = args.filter((a) => !a.startsWith("--"));
          if (!projectId) return { exitCode:1, stderr:"usage: bb lane-pilot evidence <project-id> [--op permit|revert|janitor] [--days N]" };
          const op = args[args.indexOf("--op") + 1], days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : undefined;
          const rows = await listEvidence(bb.storage.kv as never, projectId, { op, days });
          return { exitCode:0, stdout:rows.map((row) => `${new Date(row.at).toISOString()} ${row.op} ${row.target}\n  why: ${row.why}\n  checks: ${row.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("; ")}\n  by: ${row.by}`).join("\n") || "no evidence records" };
        }
        if (command === "integrity") {
          const [projectId] = args.filter((a) => !a.startsWith("--"));
          const pid = projectId ?? args[0] ?? "";
          if (args.includes("--renew")) {
            const key = args[args.indexOf("--renew") + 1]!, days = Number(args[args.indexOf("--days") + 1] ?? 7), why = args[args.indexOf("--why") + 1] ?? "";
            const result = renewDisarm(db, pid, key, days, why);
            return "error" in result ? { exitCode:1, stderr:result.error } : { exitCode:0, stdout:JSON.stringify(result.record, null, 2) };
          }
          const settings = loadProjectSettings(db, pid);
          return { exitCode:0, stdout:JSON.stringify(integrityReport(db, settings, pid), null, 2) };
        }
        if (command === "airbag") {
          const [projectId] = args.filter((a) => !a.startsWith("--"));
          if (!projectId) return { exitCode:1, stderr:"usage: bb lane-pilot airbag <project-id> [--prune DAYS] [--probe]" };
          const config = loadPrototypeConfig(db, projectId);
          if (!config) return { exitCode:1, stderr:`project ${projectId} has no configured checkout` };
          const pruneDays = args.includes("--prune") ? Number(args[args.indexOf("--prune") + 1] ?? 14) : 0;
          const probe = args.includes("--probe");
          const script = [
            `git for-each-ref --format='%(refname) %(creatordate:unix) %(objectname)' refs/lane-airbag/`,
            pruneDays > 0 ? `git for-each-ref --format='%(refname) %(creatordate:unix)' refs/lane-airbag/ | awk -v cut=$(( $(date +%s) - ${Math.round(pruneDays) * 86400} )) '$2 < cut {print $1}' | xargs -r -n1 git update-ref -d` : ":",
            probe ? `for r in $(git for-each-ref --format='%(refname)' refs/lane-airbag/); do git cat-file -e "$r" && git cat-file -e "$r^{tree}" && echo "probe ok $r" || echo "probe broken $r"; done` : ":",
          ].join("\n");
          const ran = await host.call("runCommand", { requestedHostId: config.hostId, command: script, cwd: config.writerWorkspacePath, timeoutSec: 60 }, { hostId: config.hostId, timeoutMs: 65_000 });
          return { exitCode:ran.exitCode, stdout:ran.stdout, stderr:ran.stderr || undefined };
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
        if (command === "pm-replay") {
          const replay = services.pmReplay;
          return replay ? await runPmReplayCli(replay, (state) => listScenarios(db, state === "retired" ? { state: "retired" } : { state: "active" }), args) : { exitCode:1, stderr:"pm-replay is not mounted" };
        }
        if (command === "learning") {
          const learning = learningFor(ctx);
          return learning ? await runLearningCli(learning, args) : { exitCode:1, stderr:"learning is not mounted" };
        }
        if (command === "policy-exam" || command === "policy") {
          return await runPolicyCli({ db, kv:bb.storage.kv as never, ownerSweeps: [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)], reviewedObs: listReviewedObservations as never,
            mineMessages: (from, to) => collectOwnerMessages(sdkThreadsPort(bb as never), from, to).then((rows) => rows.map((row) => ({ id: row.id, at: row.at, text: row.text }))),
            // ponytail: a conservative judge — an explicit yes/no to a named change is a decision, anything else is
            // chatter (ceiling: decisions in other wording are missed; upgrade path: a System One judgment per message).
            mineJudge: async (message) => {
              const text = message.text.toLowerCase();
              const approve = /(^|\s)(да|давай|согласен|одобряю|делай|выкатывай|сливай|ok|yes|approved?)\b/u.test(text) && !/не |not |don't|нет/u.test(text);
              const refuse = /(^|\s)(нет|не надо|не делай|отмена|отказываюсь|no|don'?t|refuse|отклоняю)\b/u.test(text);
              if (!approve && !refuse) return null;
              return { decision: approve ? "approve" : "refuse", descriptor: { kind: "other", attrs: {} }, expected: "owner_only", why: `the owner ${approve ? "approved" : "refused"} a change in a message` };
            },
          }, command, args);
        }
        if (command === "coverage") {
          return runCoverageCli(args);
        }
        if (command === "frontmatter") {
          // frontmatter: document header (SMA k_t_frontmatter): read, set and merge a file's header without touching the
          // body. The write goes through a hash guard: a file changed between the read and the write is refused.
          const [projectId, rel, ...rest] = args;
          const config = projectId ? loadPrototypeConfig(db, projectId) : null;
          if (!config || !rel) return { exitCode:1, stderr:"usage: bb lane-pilot frontmatter <project-id> <path> [--set k=v]... [--merge k=a,b]..." };
          const clean = rel.replace(/^\.\//, "");
          if (rel.startsWith("/") || clean.split("/").includes("..")) return { exitCode:1, stderr:"frontmatter: a path outside the project checkout is refused" };
          const quoted = `'${clean.replace(/'/g, `'\\''`)}'`;
          const sets = rest.flatMap((value, index) => value === "--set" && rest[index + 1] ? [rest[index + 1]!] : []);
          const merges = rest.flatMap((value, index) => value === "--merge" && rest[index + 1] ? [rest[index + 1]!] : []);
          const read = await host.call("runCommand", { requestedHostId:config.hostId, command:`cat -- ${quoted}`, cwd:config.writerWorkspacePath, timeoutSec:30 }, { hostId:config.hostId, timeoutMs:35_000 });
          if (read.exitCode !== 0) return { exitCode:1, stderr:`frontmatter: cannot read ${clean}` };
          if (!sets.length && !merges.length) return { exitCode:0, stdout:JSON.stringify(parseFrontmatter(read.stdout)?.data ?? {}) };
          const patch: Record<string, string> = {};
          for (const pair of sets) { const at = pair.indexOf("="); if (at < 1) return { exitCode:1, stderr:`--set expects k=v, got '${pair}'` }; patch[pair.slice(0, at)] = pair.slice(at + 1); }
          const merge: Record<string, string[]> = {};
          for (const pair of merges) { const at = pair.indexOf("="); if (at < 1) return { exitCode:1, stderr:`--merge expects k=a,b, got '${pair}'` }; merge[pair.slice(0, at)] = pair.slice(at + 1).split(",").map((part) => part.trim()).filter(Boolean); }
          const set = setFrontmatter(read.stdout, patch);
          const edited = "refused" in set ? set : mergeFrontmatter(set.content, merge);
          if ("refused" in edited) return { exitCode:1, stderr:edited.refused };
          // the hash is of the text this edit was made from, so a change between the read and the write is caught
          const sha = createHash("sha256").update(read.stdout, "utf8").digest("hex");
          const hashOf = `(sha256sum -- ${quoted} 2>/dev/null || shasum -a 256 -- ${quoted}) | cut -d' ' -f1`;
          const b64 = Buffer.from(edited.content, "utf8").toString("base64");
          const write = await host.call("runCommand", { requestedHostId:config.hostId,
            command:`test ! -L ${quoted} && test "$( ${hashOf} )" = "${sha}" && echo '${b64}' | base64 -d > ${quoted}`,
            cwd:config.writerWorkspacePath, timeoutSec:30 }, { hostId:config.hostId, timeoutMs:35_000 });
          return write.exitCode === 0
            ? { exitCode:0, stdout:`frontmatter: ${clean} written` }
            : { exitCode:1, stderr:`frontmatter: ${clean} changed under the read or the write failed` };
        }
        if (command === "skills") {
          return await runSkillsCli(args);
        }
        if (command === "pm-skills") {
          return runPmSkillsCli(db, args);
        }
        if (command === "pm-skill-use") {
          return runPmSkillUseCli(db, args);
        }
        if (command === "attempt") {
          const result = args[0] ? attemptRecord(db, args[0]) : null;
          return result ? { exitCode:0, stdout:JSON.stringify(result, null, 2) } : { exitCode:1, stderr:"bb lane-pilot attempt <attempt-id>: no such attempt" };
        }
        if (command === "parity") {
          const attemptId = args[0];
          if (!attemptId) return { exitCode:1, stderr:"bb lane-pilot parity <attempt-id>" };
          const session = attemptSessionLayers(db, attemptId);
          const attempt = getAttempt(db, attemptId);
          if (!session || !attempt) return { exitCode:1, stderr:`bb lane-pilot parity ${attemptId}: no such attempt` };
          const projectId = getRun(db, attempt.run_id)?.project_id ?? "";
          const config = projectId ? loadPrototypeConfig(db, projectId) : null;
          let terminalSkills: string[] = [];
          try {
            const out = await spawnAsync(process.env.BB_CLI || "bb", ["tools", "skills-hub", "--json"], { timeout:30_000, maxBuffer:24_000_000 });
            if (out.status === 0) terminalSkills = parseSkillHub(out.stdout).skills.map((skill) => skill.name);
          } catch { /* a terminal without the hub still gets the other five lines */ }
          const terminal = terminalSessionLayers({ db, projectId, skills:terminalSkills, model:config ? `${config.writerProviderId}/${config.writerModel}` : "unknown" });
          const lines = terminalParity(session, terminal);
          if (args.includes("--json")) return { exitCode:0, stdout:JSON.stringify({ attemptId, lines }, null, 2) };
          return { exitCode:0, stdout:lines.map((line) => `${line.same === null ? "n/a " : line.same ? "same" : "DIFF"} ${line.layer}: ${line.detail}`).join("\n") };
        }
        if (command === "stats") {
          // A missing or non-numeric --days is a usage error, not NaN days and an empty report.
          const daysAt = args.indexOf("--days");
          const days = daysAt < 0 ? 30 : /^\d+$/.test(args[daysAt + 1] ?? "") ? Number(args[daysAt + 1]) : NaN;
          if (!Number.isInteger(days) || days < 1) return { exitCode:1, stderr:"bb lane-pilot stats [project] [--days N]: --days takes a whole number of days, 1 or more" };
          const stats = projectStats(db as never, args[0] && !args[0].startsWith("--") ? args[0] : "", days);
          return { exitCode:0, stdout:JSON.stringify(stats, null, 2) };
        }
        if (command === "passport") {
          // --calibration: the badge of the current PM model's forecasts (SMA k_v_passport); it resets when the model changes.
          if (args[0] === "--calibration") {
            const at = args.indexOf("--project");
            if (at < 0 || !args[at + 1]) return { exitCode:1, stderr:"bb lane-pilot passport --calibration --project <id>" };
            return { exitCode:0, stdout:JSON.stringify(calibrationPassport(db, args[at + 1]!), null, 2) };
          }
          const result = args[0] ? passport(db, args[0]) : null;
          return result ? { exitCode:0, stdout:JSON.stringify(result, null, 2) } : { exitCode:1, stderr:"bb lane-pilot passport <attempt-id>: no such attempt" };
        }
        if (command === "manifest") return { exitCode:0, stdout:JSON.stringify(manifest(db), null, 2) };
        if (command === "intel" && args[0]) {
          // A thread is an agent: it reads and refreshes only its own project, and only a PM thread starts the half-hour indexer; the owner at a terminal is unrestricted.
          if (invocation?.threadId) {
            const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
            if (!caller || typeof caller.projectId !== "string" || caller.projectId !== args[0]) return { exitCode:1, stderr:`refused: intel from a thread reaches only that thread's own project (${typeof caller?.projectId === "string" ? caller.projectId : "unknown"}), not ${args[0]}` };
            if (args.includes("--refresh")) {
              const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
              if (metadata?.role !== "pm") return { exitCode:1, stderr:`refused: intel --refresh is not for a ${typeof metadata?.role === "string" ? `${metadata.role} thread` : "thread whose role is unknown"}; ask the PM or the owner` };
            }
          }
          const config = loadPrototypeConfig(db, args[0]);
          const cwd = config?.writerWorkspacePath ?? config?.pmWorkspacePath;
          if (!config?.hostId || !cwd) return { exitCode:1, stderr:`project ${args[0]} has no checkout bound in Lane Pilot` };
          const facts = await codeFactsOnHost(host, config.hostId, cwd);
          // --refresh re-analyzes on the project's own machine; a hand-called verb, no setting needed.
          const refresh = args.includes("--refresh")
            ? await runOnHost(host, { hostId:config.hostId, cwd, command:CODE_FACTS_REFRESH, timeoutSec:1800, timeoutMs:1_900_000 }).catch((cause: unknown) => ({ error:cause instanceof Error?cause.message:String(cause) }))
            : null;
          return { exitCode:0, stdout:JSON.stringify({ projectId:args[0], hostId:config.hostId, ...facts, ...(refresh ? { refresh } : {}) }, null, 2) };
        }
        if (command === "receipt-chain" && args[0] && args[1]) {
          if (args[2] === "--verify" && args[3]) { const ok = verifyChain(db, args[0], args[1], args[3]); return { exitCode:ok ? 0 : 1, stdout:ok ? "intact" : "the receipts changed since that tip" }; }
          return { exitCode:0, stdout:JSON.stringify(receiptChain(db, args[0], args[1]), null, 2) };
        }
        if (command === "preship") {
          const result = preship(db, args[0] === "--project" ? args[1] : undefined);
          return { exitCode:result.clear ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
        }
        if (command === "pr-passport" && args[0] && args[1]) return { exitCode:0, stdout:prPassport(db, args[0], args[1]) };
        if (command === "curriculum") {
          if (args[0] === "--brief") {
            const brief = await (bb.storage.kv as { get(key: string): Promise<unknown> }).get("lp.curriculum.latest").catch(() => null);
            return { exitCode:0, stdout: typeof brief === "string" ? brief : JSON.stringify(brief ?? { lines: [] }, null, 2) };
          }
          return { exitCode:0, stdout:JSON.stringify(missCurriculum(db, args[0] === "--days" ? Number(args[1]) || 30 : 30), null, 2) };
        }
        if (command === "planning") {
          // The planning folder lives in the project's checkout on its own machine: the hub asks that machine, it never opens the path itself.
          const config = args[0] === "verdicts" && args[1] ? loadPrototypeConfig(db, args[1]) : null;
          if (args[0] !== "verdicts" || !args[1]) return { exitCode:1, stderr:"usage: bb lane-pilot planning verdicts <projectId>" };
          if (!config?.hostId || !config.pmWorkspacePath) return { exitCode:1, stderr:`project ${args[1]} has no checkout bound in Lane Pilot` };
          const listed = await host.call("runCommand", { requestedHostId:config.hostId, command:VERDICT_LIST_COMMAND, cwd:config.pmWorkspacePath, timeoutSec:30 }, { hostId:config.hostId, timeoutMs:35_000 });
          if (listed.exitCode !== 0) return { exitCode:1, stderr:`the project's machine did not list .agents/planning: ${(listed.stderr || `exit ${listed.exitCode}`).trim().slice(0, 300)}` };
          return { exitCode:0, stdout:renderVerdicts(verdictInventory(verdictFiles(listed.stdout))) };
        }
        if (command === "explain") {
          const word = args[0];
          // The guide is the plugin's own docs folder, wherever the hub process happens to stand.
          const docs = guideDocs(pluginRootFromModule(import.meta.url));
          if (!word) return { exitCode:1, stderr: `usage: bb lane-pilot explain <verb or topic>\n${explainCatalog(commands, docs).join("  ")}` };
          const hit = explainWord(word, commands, docs);
          if (!hit) return { exitCode:0, stdout:`no explainer for «${word}». Try:\n${explainCatalog(commands, docs).join("\n")}` };
          return { exitCode:0, stdout:`${hit.title} — ${hit.kind}\n\n${hit.text}${hit.source ? `\n\ndoc: ${hit.source}` : ""}` };
        }
        if (command === "cost") return { exitCode:0, stdout:JSON.stringify(costPerVerified(db, args[0] === "--days" ? Number(args[1]) || 30 : 30), null, 2) };
        if (command === "approvals-suggest") {
          const live = await bestEffort(bb.log, "approvals-suggest live exam", loadLiveExam(bb.storage.kv as never), null);
          return { exitCode:0, stdout:JSON.stringify(approvalSuggestions(live?.items ?? []), null, 2) };
        }
        if (command === "excavate" && args[0]) {
          const run = getRun(db, args[0]);
          const hostId = run && getRunWriterHost(db, run.id);
          if (!run?.writer_workspace_path || !hostId) return { exitCode:1, stderr:"the run has no checkout on a machine" };
          const cwd = args[1] ? `${run.writer_workspace_path}/${args[1].replace(/^\.?\//, "")}` : run.writer_workspace_path;
          const out = await host.call("runCommand", { requestedHostId:hostId, command:`git ${EXCAVATE_LOG_ARGS.map((arg) => `'${arg}'`).join(" ")}`, cwd, timeoutSec:60 }, { hostId, timeoutMs:90_000 }) as { stdout?: string };
          return { exitCode:0, stdout:JSON.stringify(excavate(out.stdout ?? ""), null, 2) };
        }
        if (command === "report") {
          await services.ownerPresence.sweep().catch(() => []);
          const rows = smaRows();
          const regions = [...new Set(rows.map((row) => row.region))].map((region) => { const part = rows.filter((row) => row.region === region); return { region, checked: `${smaCheckedPercent(part)}%`, mapped: `${smaDonePercent(part)}%`, ...smaCounts(part) }; });
          return { exitCode:0, stdout:htmlReport({ title:`Lane Pilot report ${new Date().toISOString().slice(0, 10)}`, sections:[
            { heading:`SMA map: checked by contract tests ${smaCheckedPercent(rows)}%, mapped by proof links ${smaDonePercent(rows)}%`, rows:regions },
            { heading:"Money", rows:[services.money.status() as never] },
            { heading:"Cost per verified result (30 days)", rows:costPerVerified(db) as never },
            // The last number (SMA m_sp_tjournal_report): how much of the week was worked in the owner's own threads.
            { heading:"Work outside the daemon (7 days)", rows:[outsideWorkSummary(services.ownerPresence.journal(), Date.now(), attemptStateCounts(db, Date.now() - 7 * 86_400_000).reduce((total, row) => total + row.n, 0)) as never] },
          ] }) };
        }
        if (command === "money") {
          return { exitCode:0, stdout:JSON.stringify(services.money.status(), null, 2) };
        }
        if (command === "unknown-codes") {
          const days = args[0] === "--days" && Number(args[1]) > 0 ? Number(args[1]) : 14;
          const rows = listAttemptReasonsSince(db, Date.now() - days * 86_400_000);
          return { exitCode:0, stdout:JSON.stringify(unknownReasons(rows).slice(0, 50), null, 2) };
        }
        if (command === "phase") {
          return await runPhaseCli(services.phases, args, invocation?.threadId);
        }
        if (command === "gates" && args[0] === "ack" && /^\d+$/.test(args[1] ?? "")) {
          // A firing a person marks as a false alarm stops counting against the gate (SMA k_v_gates).
          const whyAt = args.indexOf("--why");
          const why = whyAt >= 0 ? args.slice(whyAt + 1).join(" ").trim() : "";
          if (!why) return { exitCode:1, stderr:"bb lane-pilot gates ack <event-id> --why \"<reason>\"" };
          const kv = bb.storage.kv as { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
          const all = ((await kv.get("gates:acks").catch(() => null)) ?? {}) as Record<string, unknown>;
          all[args[1]!] = { eventId: Number(args[1]), why: why.slice(0, 300), by: "owner", at: Date.now() };
          await kv.set("gates:acks", all);
          return { exitCode:0, stdout:JSON.stringify({ acked: Number(args[1]), why }) };
        }
        if (command === "design-metrics") {
          const all = await designJournalLines(ctx.bb.storage.kv);
          const project = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
          const lines = project ? all.filter((line) => line.projectId === project) : all;
          // Series assignment: which role-lines state each drawing was made under; the baseline is the first series, shown beside the latest.
          const seriesOrder = [...new Set(lines.map((line) => line.series ?? "base"))];
          const series = Object.fromEntries(seriesOrder.map((id) => [id, trainingRatios(lines.filter((line) => (line.series ?? "base") === id))]));
          const report = { ratios:trainingRatios(lines), series, baseline:seriesOrder[0] ?? null, latest:seriesOrder.at(-1) ?? null, conditions:trainedConditions(lines), readiness:readinessWords(lines) };
          return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(report, null, 2) : `${report.readiness}\n\n${JSON.stringify(report.ratios)}\n${report.conditions.map((row) => `${row.ok ? "✓" : "✗"} ${row.id}: ${row.detail}`).join("\n")}` };
        }
        if (command === "design-pair" || command === "design-pair-answer") {
          // Paired design judgement (SMA k_lib_djudgement): the model and the person see one basis and one order; the pair lands in the journal.
          // The plugin's own scripts/ folder, not the shell's cwd; the caller rules and the URL table live in design-eval/server.
          const script = join(pluginRootFromModule(import.meta.url), "scripts", "lp-design-eval.ts");
          const portOf = (value: string | undefined): number[] => { try { const url = new URL(value ?? ""); return [Number(url.port || (url.protocol === "https:" ? 443 : 80))]; } catch { return []; } };
          const hubPorts = [...portOf(process.env.BB_SERVER_URL), Number(process.env.BB_HOST_DAEMON_PORT), Number(process.env.PORT)].filter((n) => Number.isInteger(n) && n > 0);
          return await runDesignPairCli({
            kv: ctx.bb.storage.kv, threadId: invocation?.threadId ?? null, script, hubPorts,
            thread: async (threadId) => {
              const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound) as { projectId?: unknown } | null;
              if (!thread) return null;
              const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound) as { role?: unknown } | null;
              return { projectId: typeof thread.projectId === "string" ? thread.projectId : null, role: typeof metadata?.role === "string" ? metadata.role : null };
            },
            phaseProject: (phaseId) => getPhase(db as never, phaseId)?.projectId ?? null,
            jev: () => jev(),
            // The judge is a paid call on the API lane: the same money cap the writers wait on (no cap set = no hold).
            moneyHold: async () => services.money.holds("api", "", ""),
            measure: async (file, scriptArgs) => {
              const ran = await spawnAsync("npx", ["tsx", file, ...scriptArgs], { cwd: dirname(dirname(file)), timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
              if (ran.error || ran.status !== 0) throw ran.error ?? new Error(`${file} ended with ${ran.status ?? ran.signal}: ${(ran.stderr ?? "").trim().slice(-400)}`);
              return ran.stdout ?? "";
            },
            ownerItem: {
              post: (item) => { postOwnerItem(db, { key: item.key, source: "design-eval", kind: "design-pair", wake: false, ...(item.projectId ? { projectId: item.projectId } : {}), what: item.what, why: item.why, evidence: [{ kind: "text", ref: item.basis }] }); },
              close: (key, by) => { closeOwnerItem(db, key, by); },
            },
          }, command, args);
        }
        if (command === "sma-map") {
          return args.includes("--live") ? runSmaLiveCli(db as never, args) : runSmaMapCli(args);
        }
        if (command === "waiting") {
          return runWaitingCli(db, args, Date.now(), [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)], services.ownerLearningItems);
        }
        if (command === "lead") return await runLeadCli({ db, kv: bb.storage.kv as never, lead: services.lead }, args);
        if (command === "jev") return runJevCli({ db, saveProjectSetting: (p, k, v) => saveProjectSetting(db, p, k, v), settings: async (p) => (await effectiveProjectSettings(p)).values as Record<string, unknown> }, args);
        if (command === "errands" && args[0] === "process-key-eval") return runErrandsCli(args);
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
        if (command === "workflow-answer" && args.length >= 3) {
          const words = args.slice(2).join(" ");
          const result = await answerWorkflowQuestion(ctx, services, { runId:args[0]!, stepKey:args[1]!, choice:words });
          return { exitCode:result.ok ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
        }
        // Before 0.1.430 nothing outside the engine could stop a workflow run: the magicseo replays were stopped by hand in the database.
        if (command === "workflow-cancel" && args.length >= 1) {
          const reason = args.slice(1).join(" ") || "canceled_by_owner";
          const ok = services.workflowEngine?.cancel(args[0]!, reason) ?? false;
          return { exitCode:ok ? 0 : 1, stdout:JSON.stringify(ok ? { ok, runId:args[0], reason } : { ok, runId:args[0], why:"no running or waiting run with this id" }, null, 2) };
        }
        if (command === "defer" || command === "defer-close" || command === "deferrals") {
          return await runDeferralCli(services.deferrals, command, args);
        }
        if (command === "regress" || command === "regressions" || command === "regress-close" || command === "baseline") {
          return await runBaselineCli(services, command, args);
        }
        if (command === "forecast") return runForecastCli(db, args);
        // sma breaker (SMA k_v_breaker): the tripped rules of the loop breaker, re-armed only by a person with a reason.
        if (command === "breaker") {
          const kv = bb.storage.kv as never;
          if (args[0] === "rearm") {
            const whyAt = args.indexOf("--why");
            const why = whyAt >= 0 ? args[whyAt + 1] : undefined;
            if (!args[1] || !why?.trim()) return { exitCode:1, stderr:"bb lane-pilot breaker rearm <id> --why <text>: a reason is required" };
            const row = await rearmBreaker(kv, args[1], { why });
            return row ? { exitCode:0, stdout:JSON.stringify({ rearmed:args[1], by:row.by, why:row.reason }, null, 2) }
                       : { exitCode:1, stderr:`breaker: no tripped row ${args[1]}` };
          }
          const rows = await listTripped(kv, args[0] && !args[0].startsWith("--") ? args[0] : undefined);
          return { exitCode:0, stdout:JSON.stringify(rows.map((row) => ({ id: breakerRowId(row.project, row.ruleHash, row.target), rule: row.ruleHash, target: row.target, count: row.count, firstAt: row.firstAt, lastAt: row.lastAt })), null, 2) };
        }
        // The near-miss channel (SMA k_v_skeptic): reports agents flagged, listed under «not scored» — never counted.
        if (command === "nearmiss") {
          const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 30;
          const projectId = args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined;
          const since = Date.now() - (Number.isInteger(days) && days > 0 ? days : 30) * 86_400_000;
          const rows = listNearMissReceipts(db, since, projectId);
          const out = rows.flatMap((row) => { try { const misses = (JSON.parse(row.result_json) as { near_misses?: unknown }).near_misses; return (Array.isArray(misses) ? misses : []).filter((m): m is string => typeof m === "string").map((miss) => ({ taskId: row.task_id, miss, at: row.updated_at, scored: "not scored" })); } catch { return []; } });
          return { exitCode:0, stdout:JSON.stringify({ notScored: true, nearMisses: out }, null, 2) };
        }
        if (command === "subagent-receipts") {
          const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : undefined;
          const projectId = args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined;
          return { exitCode:0, stdout:JSON.stringify(subagentReceipts(db, { projectId, days }), null, 2) };
        }
        if (command === "run-goal") return await runRunGoalCli(services.runGoal, args);
        if (command === "capabilities") return await runCapabilityCli(services.capabilities, args, (user) => workerSecretReach(user), Boolean(invocation?.threadId));
        if (command === "outages") return runOutageCli(ctx, args);
        if (command === "failures") {
          const days = args[0] === "--since" ? Number(args[1]) : undefined;
          if (args.length && (args[0] !== "--since" || !Number.isFinite(days))) return { exitCode:1, stderr:"usage: bb lane-pilot failures [--since <days>]" };
          return { exitCode:0, stdout:JSON.stringify(failedTasksAllProjects(db, days === undefined ? 0 : Date.now() - days * 86_400_000), null, 2) };
        }
        if (command === "backlog") return await runBacklogCli(services.backlog, args);
        if (command === "hypothesis") return await runHypothesisCli(services.hypotheses, args);
        if (command === "owner-presence") {
          const now = Date.now(), presence = await services.ownerPresence.sweep();
          // Without --journal the output is main's: the bare array of marks.
          if (args.includes("--journal")) return { exitCode:0, stdout:JSON.stringify(services.ownerPresence.journal(), null, 2) };
          return { exitCode:0, stdout:JSON.stringify(presence.map((row) => ({ ...row, minutesAgo:Math.round((now - row.at) / 60_000), holdsWriters:services.ownerPresence.holds(row.providerId, now) !== null })), null, 2) };
        }
        if (command === "task") {
          const { taskId, runId } = timelineArgs(args.filter((arg) => arg !== "--plan"));
          const found = taskId ? taskRecord(db, taskId, runId) : null;
          if (!found) return { exitCode:1, stderr:taskId ? `no task ${taskId} on record` : `usage: ${TASK_RECORD_USAGE}` };
          const record = readsBlind(found, invocation?.threadId) ? blindRecord(found) : found;
          return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(record, null, 2) : renderTaskRecord(record, { fullPlan: args.includes("--plan") }) };
        }
        if (command === "timeline") {
          const { taskId, runId } = timelineArgs(args);
          if (!taskId) return { exitCode:1, stderr:"usage: bb lane-pilot timeline <task-id> [--run <run-id>] [--json]" };
          const timeline = taskTimeline(db, taskId, runId, taskBaselineEntries);
          if (!timeline.runId) return { exitCode:1, stderr:renderTimeline(timeline) };
          return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(timeline, null, 2) : renderTimeline(timeline) };
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
          // The arena is up to four series of real model runs: from a thread only the PM chat starts it. `bench run` keeps main's rule.
          if (args[0] === "arena" && invocation?.threadId) {
            const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
            if (metadata?.role !== "pm") return { exitCode:1, stderr:"refused: bench arena starts up to four series of real model runs; from a thread only the PM chat starts it. Ask the PM or the owner" };
          }
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
          return await runAgentsCli({ list: () => services.listedAgentProfiles(), registry: agentRegistry(ctx, services.scheduleAgents) }, args);
        }
        if (command === "memory" || command === "memory-index" || command === "memory-lint") {
          const sub = command === "memory" ? args[0] : command.slice("memory-".length);
          const flag = args.indexOf("--project");
          const explicit = flag >= 0 ? args[flag + 1] : undefined;
          const thread = !explicit && invocation?.threadId ? await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) : null;
          const projectId = explicit ?? ((thread as { projectId?: unknown } | null)?.projectId as string | undefined);
          const value = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
          if (sub === "index") {
            if (args.includes("--rebuild") || command === "memory-index" && !args.includes("--check")) {
              if (!projectId && !args.includes("--all")) { const done = rebuildMemoryIndexes(db, undefined, { check: args.includes("--check") }); return { exitCode:0, stdout:JSON.stringify(done) }; }
              const done = rebuildMemoryIndexes(db, projectId, { check: args.includes("--check") });
              return { exitCode:0, stdout:`rebuilt memory indexes: ${done.active} active, ${done.added} added, ${done.stale} stale\n` };
            }
            const status = memoryIndexStatus(db, projectId);
            return { exitCode:0, stdout:JSON.stringify(status, null, 2) };
          }
          if (sub === "lint") {
            if (!projectId) return { exitCode:1, stderr:"no project: pass --project <id> outside a BB thread" };
            const budgets = memorySettingsFor(loadProjectSettings(db, projectId));
            const findings = lintMemory(db, projectId, { budgets });
            if (args.includes("--json")) return { exitCode: findings.some((f) => f.tier === "error") ? 1 : 0, stdout:JSON.stringify(findings, null, 2) };
            const lines = findings.map((f) => `[${f.tier}] ${f.check}${f.recordId ? ` ${f.recordId.slice(0, 12)}` : ""} ${f.detail}`);
            return { exitCode: findings.some((f) => f.tier === "error") ? 1 : 0, stdout:`${lines.length ? lines.join("\n") : "memory lint: no findings"}\n` };
          }
          if (sub === "review") {
            if (!projectId) return { exitCode:1, stderr:"no project: pass --project <id> outside a BB thread" };
            const proposals = reviewMemory(db, projectId);
            return { exitCode:0, stdout: proposals.length ? `${proposals.map((p) => `${p.action} ${p.id}${p.by ? ` <- ${p.by}` : ""}${p.reason ? ` (${p.reason})` : ""}`).join("\n")}\n` : "memory review: no proposals\n" };
          }
          if (sub === "stats") {
            if (!projectId) return { exitCode:1, stderr:"no project: pass --project <id> outside a BB thread" };
            const stats = memoryTokenStats(db, projectId, memorySettingsFor(loadProjectSettings(db, projectId)));
            return { exitCode:0, stdout: args.includes("--json") ? JSON.stringify(stats, null, 2) : `core ${stats.coreTokens}/${stats.budgets.coreBudget} tokens, notes ${stats.noteTokens}/${stats.budgets.noteBudget}, index ${stats.indexTokens}/${stats.budgets.indexBudget}; ${stats.records.active} active, hidden ${JSON.stringify(stats.records.hidden)}\n` };
          }
          if (sub === "miss") {
            const noteId = value("--note");
            const question = args.slice(1).filter((arg, i) => !arg.startsWith("--") && (flag < 0 || (i + 1 !== flag && i + 1 !== flag + 1)) && args.indexOf(arg) !== args.indexOf("--note") + 1).join(" ").trim();
            if (!projectId || !question || !noteId) return { exitCode:1, stderr:'usage: bb lane-pilot memory miss "<question>" --note <id> [--project P]' };
            if (!memoryRecordExists(db, projectId, noteId)) return { exitCode:1, stderr:`no memory record ${noteId} in project ${projectId}` };
            recordMemoryMiss(db, projectId, question, Date.now(), "reminded", noteId);
            return { exitCode:0, stdout:`recorded a reminded miss for ${noteId}\n` };
          }
          if (sub === "forget") {
            const id = args[1];
            if (!projectId || !id || id.startsWith("--")) return { exitCode:1, stderr:"usage: bb lane-pilot memory forget <id> [--project P] (--revoke|--expire|--archive|--replace <newId>) [--erase --yes]" };
            // The CLI is a door any agent thread can reach and `--yes` is a flag an agent can pass: who is calling decides what is allowed.
            // No thread = the owner at a terminal (or an automation). A thread is an agent: only the owner's PM chat may hide a record,
            // and only in its own project (a revoked fact never comes back by itself, so a writer or helper must not withdraw one);
            // `--erase` is irreversible and is never an agent's: the owner erases from the cockpit or a terminal.
            if (invocation?.threadId) {
              const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
              if (!caller || typeof caller.projectId !== "string" || caller.projectId !== projectId) return { exitCode:1, stderr:`refused: memory forget from a thread reaches only that thread's own project (${typeof caller?.projectId === "string" ? caller.projectId : "unknown"}), not ${projectId}` }
              if (args.includes("--erase")) return { exitCode:1, stderr:"refused: --erase is irreversible and not for an agent thread; the owner erases from the cockpit or a terminal" };
              const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
              if (metadata?.role !== "pm") return { exitCode:1, stderr:`refused: memory forget is not for a ${typeof metadata?.role === "string" ? `${metadata.role} thread` : "thread whose role is unknown"}; ask the PM or the owner` };
            }
            const conceptsJson = memoryConceptsJson(db as never, projectId, id);
            if (conceptsJson === null) return { exitCode:1, stderr:`no memory record ${id} in project ${projectId}` };
            if (conceptsJson.includes('"rule"')) return { exitCode:1, stderr:"a rule record is removed with its rule: revoke the rule, not the record" };
            const unindex = (p: string, r: string) => dropMemoryIndexes(db as never, p, r);
            if (args.includes("--erase")) {
              if (!args.includes("--yes")) return { exitCode:1, stderr:"--erase deletes the record's bytes everywhere; pass --yes to confirm" };
              const left = services.memoryConflicts.eraseRecord(projectId, id);
              return { exitCode: left.length ? 1 : 0, stdout: left.length ? `leftovers: ${left.join(",")}\n` : `erased ${id}; nothing remains\n` };
            }
            const replaceAt = args.indexOf("--replace");
            if (replaceAt >= 0) {
              const by = args[replaceAt + 1];
              if (!by || !memoryRecordExists(db, projectId, by)) return { exitCode:1, stderr:`--replace needs an existing record id` };
              hideRecord(db, projectId, id, "superseded", by, unindex);
              return { exitCode:0, stdout:`${id} superseded by ${by}\n` };
            }
            const reason = args.includes("--revoke") ? "revoked" : args.includes("--archive") ? "archived" : args.includes("--expire") ? "dated" : null;
            if (!reason) return { exitCode:1, stderr:"pick one: --revoke, --expire, --archive, --replace <newId>, or --erase --yes" };
            if (!hideRecord(db, projectId, id, "expired", null, unindex, reason)) return { exitCode:1, stderr:`record ${id} is not active` };
            return { exitCode:0, stdout:`${id} ${reason === "dated" ? "expired" : reason}\n` };
          }
          if (sub === "load") {
            const tags = (value("--tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
            if (!projectId || !tags.length) return { exitCode:1, stderr:"usage: bb lane-pilot memory load --tags a,b [--project P]" };
            const scoped = { allSections: true as const };
            const core = listMemory(db, projectId, { kind: "core" }, 20, "subagent", "", scoped);
            const notes = listMemory(db, projectId, { concepts: tags }, 20, "subagent", "", scoped);
            const lines = [...core.map((record) => `- [core ${record.id.slice(0, 12)}] ${record.content}`), ...notes.map((record) => `- [${record.id.slice(0, 12)}] ${record.content}`)];
            return { exitCode:0, stdout:`${lines.join("\n") || "nothing found"}\n` };
          }
          if (sub === "search" || sub === "write") {
          // M2's door for any thread or shell: the project is --project or the calling thread's own.
          const rest = args.slice(1);
          const at = rest.indexOf("--project");
          const text = rest.filter((_, index) => at < 0 || (index !== at && index !== at + 1)).join(" ").trim();
          if (!text || !projectId) return { exitCode:1, stderr:`${MEMORY_CLI_USAGE}\n${projectId ? "" : "no project: pass --project <id> outside a BB thread"}` };
          const rpc = sessionMemoryRpc(ctx, services);
          if (sub === "search") {
            const found = await rpc.session_memory_search({ projectId, query: text });
            return { exitCode:0, stdout: found.records.length ? `${found.records.map((record) => `- [${record.id}] ${record.content}`).join("\n")}\n` : `${found.message ?? "nothing relevant"}\n` };
          }
          const written = await rpc.session_memory_write({ projectId, kind: "note", content: text, concepts: [], source: `cli:${invocation?.threadId ?? "shell"}` });
          return { exitCode: written.id ? 0 : 1, stdout: `${JSON.stringify(written)}\n` };
          }
          return { exitCode:1, stderr:MEMORY_CLI_USAGE };
        }
        if (command === "skill-lint") {
          return runSkillLintCli(args);
        }
        if (command === "errands") {
          return await runEpisodesCli({
            db, readEvents: (threadId) => services.harness.threadEvents(threadId, ERRAND_EPISODE_TRACE_EVENTS),
            log: (message) => ctx.log(message), warn: (message) => ctx.log(message), catalog: services.workflowCatalog,
            sweepDeps: () => episodeSweepDeps(ctx, services, () => ctx.isDisposed()),
          }, args[0] ?? "", args.slice(1));
        }
        if (command === "configure" && args.length === 1) {
          const config = prototypeConfigSchema.parse(JSON.parse(args[0]!));
          savePrototypeConfig(db, config);
          return { exitCode:0, stdout:JSON.stringify({ ok:true, projectId:config.projectId }) };
        }
        if (command === "activate" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await services.activate(args[0]!, args[1]!, args[2] === "cli" ? "cli" : "bb")) };
        }
        if (command === "setting") {
          const [scope, ...pairs] = args;
          const where = scope === "global" ? GLOBAL_SETTINGS_PROJECT_ID : scope;
          if (!where) return { exitCode:0, stdout:Object.entries(UNLISTED_SWITCHES).map(([key, [level, values, what]]) => `${key} (${level}; ${values}): ${what}`).join("\n") };
          const own = () => Object.fromEntries(listSettingRows(db, where).filter((row) => row.key in UNLISTED_SWITCHES).map((row) => [row.key, row.value]));
          if (!pairs.length) return { exitCode:0, stdout:JSON.stringify({ scope:scope!, set:own() }, null, 2) };
          // A switch changes what the machine does by itself, some of them spend money: an agent's shell never flips one.
          if (invocation?.threadId) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:"a setting is set by the owner at a terminal, not from a chat: ask them to run this command" }) };
          const changes: Array<{ key:string; value:unknown }> = [];
          for (const pair of pairs) {
            const at = pair.indexOf("=");
            const key = at < 0 ? pair : pair.slice(0, at);
            const known = UNLISTED_SWITCHES[key];
            if (at < 0 || !known) throw new Error(known ? `write ${key}=<value>` : `${key} is not on the list; \`bb lane-pilot setting\` prints it (a setting with a row in the settings window is set there)`);
            if (known[0] === "global" && where !== GLOBAL_SETTINGS_PROJECT_ID) throw new Error(`${key} is read hub-wide only: bb lane-pilot setting global ${pair}`);
            if (known[0] === "project-only" && where === GLOBAL_SETTINGS_PROJECT_ID) throw new Error(`${key} is read from a project's own row only: name the project`);
            const text = pair.slice(at + 1);
            if (text === "") { changes.push({ key, value:undefined }); continue; }
            const parsed = switchValue(key, text);
            if ("problem" in parsed) throw new Error(parsed.problem);
            changes.push({ key, value:parsed.value });
          }
          const cleared = changes.filter((change) => change.value === undefined).map((change) => change.key);
          const kept = changes.filter((change) => change.value !== undefined);
          const versions = getSettingVersions(db, where, kept.map((change) => change.key));
          const saved = kept.length ? casUpsertSettings(db, { projectId:where, bindingId:"", changes:kept.map((change) => ({ ...change, expectedVersion:versions[change.key] ?? 0 })) }) : null;
          if (saved && !saved.ok) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:saved.validation ?? "the setting changed meanwhile: run the command again" }) };
          for (const key of cleared) deleteBoundSetting(db, where, key);
          return { exitCode:0, stdout:JSON.stringify({ ok:true, scope:scope!, set:own() }, null, 2) };
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
          const keys = PAIR_ROLE_SPECS.flatMap((spec) => [spec.keys[0], spec.keys[1]]);
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
          if (!wait) { void bestEffort(bb.log, "harness editor background run", run, undefined); return { exitCode:0, stdout:JSON.stringify({ status:"started", detail:"running in the background; bb lane-pilot harness <project-id> shows the trial when it lands" }, null, 2) }; }
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
        if (command === "state" && args.length >= 1 && args.length <= 5) {
          const opt = (name:string) => { const at = args.indexOf(name); return at > 0 ? args[at + 1] : undefined; };
          const attemptId = opt("--attempt");
          if (attemptId) {
            const reasonOffset = Number(opt("--reason-offset") ?? 0);
            if (!Number.isSafeInteger(reasonOffset) || reasonOffset < 0) throw new Error("--reason-offset must be a non-negative integer");
            const attempt = inspectAttempt(db, args[0]!, attemptId, reasonOffset);
            if (!attempt) throw new Error(`no attempt ${attemptId} in project ${args[0]}`);
            return { exitCode:0, stdout:JSON.stringify(attempt, null, 2) };
          }
          const number = (name:string, max:number) => { const raw = opt(name); if (raw === undefined) return undefined; const n = Number(raw); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}`); return n; };
          const limit = number("--limit", 100);
          const cursor = opt("--before")?.split(":");
          const before = cursor ? Number(cursor[0]) : undefined;
          if (cursor && (cursor.length > 2 || !Number.isSafeInteger(before) || before! < 1 || (cursor.length === 2 && !cursor[1]))) throw new Error("--before must be a timestamp or timestamp:id cursor from state.next");
          const beforeId = cursor?.[1] ? decodeURIComponent(cursor[1]) : undefined;
          return { exitCode:0, stdout:JSON.stringify(inspectState(db, args[0]!, { ...(limit ? { limit } : {}), ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}) }), null, 2) };
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
          // One road for every cancel (the PM's tool, the board's RPC, this command): a queued attempt at once, a running one once its
          // writer's stop is observed, a task that ended blocked by closing it.
          const result = await cancelAttemptById(ctx, args[0]!, services.rollback, "canceled from the CLI", "owner_cancel");
          return { exitCode:result.ok ? 0 : 1, stdout:JSON.stringify({ attemptId:args[0], ...result }) };
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
          const savedTask = getTask(db, attempt.task_id);
          if (!savedTask) throw new Error(`reconciled task missing: ${attempt.task_id}`);
          const recoveredTask = taskV2Schema.parse(savedTask.contract);
          const checked = await services.validateWriterResult({
            config, projectId:run.project_id, runId:attempt.run_id, taskId:attempt.task_id,
            attempt:attempt.attempt_no, task:recoveredTask, writerThreadId, attemptId:attempt.id,
            dirtBefore:attempt.dirt_before,
          });
          if (checked.status !== "accepted") {
            transitionAttempt(db, attempt.id, checked.status, { threadId:writerThreadId, reason:checked.reason ?? checked.status, ...failureFieldsOf(checked) });
            throw new Error(`reconciled writer validation failed: ${checked.reason ?? checked.status}`);
          }
          const receipt = await services.persistWriterAcceptance({
            config, task:recoveredTask, runId:attempt.run_id,
            taskId:attempt.task_id, attempt:attempt.attempt_no, attemptId:attempt.id,
            pmThreadId:run.pm_thread_id, writerThreadId, output:checked.output, verification:checked.verification,
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
          return await runMemoryEvalCommand(db, args, migrations, { northStar: () => costPerVerified(db) });
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
        if (command === "remove-claude-lane-leftovers" && args.length >= 1) {
          const hostId = args.find((arg) => !arg.startsWith("--"));
          if (!hostId) return { exitCode: 1, stderr: "bb lane-pilot remove-claude-lane-leftovers <host-id> [--apply]" };
          return { exitCode: 0, stdout: JSON.stringify(await host.call("removeClaudeLaneLeftovers", {
            requestedHostId: hostId,
            apply: args.includes("--apply"),
          }, { hostId, timeoutMs: 120_000 }), null, 2) };
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
        if (command === "resume") {
          return { exitCode:0, stdout:JSON.stringify(await services.resumeOrphans(args[0]), null, 2) };
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
            const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
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
        return { exitCode:1, stderr:usageText };
      } catch (cause) {
        return { exitCode:1, stderr:cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });
}
