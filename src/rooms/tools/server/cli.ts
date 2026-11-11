import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { listReviewedObservations, pmRulesOf } from "../../learning";
import { prototypeConfigSchema, resolvePlanningHome, taskV2Schema } from "../../contracts";
import { taskBaselineEntries } from "../../baseline";
import { failureFieldsOf, getActivation, getAttempt, getRun, getRunWriterHost, getTask, importSettingsOnce, inspectAttempt, inspectState, listAttemptReasonsSince, listRunsWithAttempts, loadProjectSettings, PROTECTIONS, loadPrototypeConfig, saveProjectSetting, savePrototypeConfig, transitionAttempt, failedTasksAllProjects, listNearMissReceipts, projectIdForWorkspacePath, projectLiveAttempts, attemptStateCounts, settingsScopesForWorkspacePath } from "../../storage";
import { outsideWorkSummary } from "../../owner-presence";
import { cancelAttemptById, finishRunSafely, pauseRun } from "../../runs/server";
import { conveyorState, renderTimeline, setConveyor, taskTimeline, unknownReasons } from "../../runs";
import { TASK_RECORD_USAGE, blindRecord, readsBlind, renderTaskRecord, taskRecord } from "./task-record";
import {bestEffort, isNotFound, maskCredentials, orMiss, outputText, pluginRootFromModule, spawnAsync, stringAt, valueAt} from "@lane-pilot/kit";
import { PAIR_ROLE_SPECS, switchOn } from "@lane-pilot/models";
import {listQaHosts, runSkillsCli, parseSkillHub, SKILLS_USAGE} from "../../platform/server";
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

import { ANAMNESIS_USAGE, PROFILE_KEYS, anamnesisFor, collectOwnerMessages, profilePairProblem, sdkThreadsPort } from "../../anamnesis";
import { LEARNING_USAGE, learningFor, runLearningCli } from "../../learning";
import { PM_REPLAY_USAGE, runPmReplayCli, listScenarios } from "../../pm-replay";
import { attemptMetrics, renderAttemptMetrics } from "../../usage/server";
import { usageSegment } from "../../usage";
import type { ProviderUsage } from "../../usage/server";
import { DEFERRAL_USAGE, runDeferralCli } from "../../deferral/server";
import { MEMORY_EVAL_USAGE, runMemoryEvalCommand } from "../../memory-eval/server";
import { MEMORY_COMPRESS_USAGE, MEMORY_CONFLICT_USAGE, memoryCompressChanges, runMemoryCompressCli, runMemoryConflictCli, confirmedWordHits, sessionMemoryRpc, memorySettingsFor, type WallThreadReader } from "../../memory/server";
import { CATALOG_USAGE, runCatalogCli } from "../../file-cards";
import { dropMemoryIndexes, hideRecord, lintMemory, listMemory, memoryConceptsJson, memoryIndexStatus, memoryRecordExists, memoryTokenStats, rebuildMemoryIndexes, recordMemoryMiss, reviewMemory } from "@lane-pilot/memory-core";
import { BENCH_USAGE, runBenchCli } from "../../bench/server";
import { BASELINE_USAGE, runBaselineCli } from "../../baseline/server";
import { RETURN_USAGE, runReturnCli } from "../../stage-return/server";
import { FORECAST_USAGE, runForecastCli } from "../../forecast/server";
import { calibrationPassport, weakAreas } from "../../forecast/server";
import { sessionSummaryLine } from "../../session-hooks";
import { MERGE_INTENT_PREFIX } from "../../verification";
import { RUN_GOAL_USAGE, runGoalSweep, runRunGoalCli } from "../../run-goal/server";
import { CAPABILITY_USAGE, runCapabilityCli } from "../../capability/server";
import { runWindowCli, WINDOW_USAGE, workerSecretReach } from "../../verification";
import { explainCatalog, explainWord, guideDocs } from "./explain";
import { VERDICT_LIST_COMMAND, renderVerdicts, verdictFiles, verdictInventory } from "./verdicts";
import { OUTAGE_USAGE, runOutageCli } from "../../outage/server";
import { BACKLOG_USAGE, runBacklogCli } from "../../backlog/server";
import { runHypothesisCli } from "../../hypotheses/server";
import { HISTORY_SOURCES, historySearch, tierReport } from "../../memory-tiers/server";
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
import { casUpsertSettings, deleteBoundSetting, getSettingVersions, listEvidence, listSettingRows, planningHomeInputs } from "../../storage";
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

import { MEMORY_CLI_USAGE, cliCommands, cliUsageText } from "./cli-commands";
import type { Services } from "./cli-deps";
import { cliInspect } from "./cli-inspect";
import { cliPipeline, timelineArgs } from "./cli-pipeline";
import { cliProject } from "./cli-project";
import { cliHost } from "./cli-host";

export { timelineArgs };


export function registerCli(ctx: ServerCore, services: Services, migrations: readonly string[]) {
  const { bb, db, effectiveProjectSettings, host } = ctx;

  /**
   * The project a session-hook verb reaches (session-brief, subagent-pack, memory search --recall), the rule `memory forget` and `memory history`
   * use: when a thread calls, its own project is the only project, and a --project or a --cwd that names another one is refused with the reason.
   * With no thread (the owner at a terminal) both flags work.
   */
  const hookProject = async (verb: string, invocation: { threadId?: string | null } | undefined, asked: { project?: string; cwd?: string }): Promise<{ projectId: string | null; refused?: undefined } | { refused: string; projectId?: undefined }> => {
    const byCwd = asked.cwd ? projectIdForWorkspacePath(db, asked.cwd) : null;
    if (!invocation?.threadId) return { projectId: asked.project ?? byCwd };
    const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
    const own = typeof caller?.projectId === "string" ? caller.projectId : null;
    if (!own) return { refused: `refused: ${verb} from a thread reaches only that thread's own project, and the project of this thread is unknown` };
    const other = [asked.project, byCwd].find((id) => id && id !== own);
    if (other) return { refused: `refused: ${verb} from a thread reaches only that thread's own project (${own}), not ${other}` };
    return { projectId: own };
  };


  bb.cli.register({
    name:"lane-pilot",
    summary:"Lane Pilot stage-0 prototype controls",
    commands: cliCommands,
    async run(argv, invocation) {
      try {
        const [command, ...args] = argv;
        // The same door as the tools: a PM's shell does not start work (a schedule, a dispatch, a workflow, a council) for a request
        // the machine took. Automations and drills call the CLI without a thread and are not touched.
        const launches = command === "schedule" ? ["create", "update", "run-now"].includes(args[0] ?? "") : ["dispatch-bb", "workflow-trigger", "council"].includes(command ?? "");
        const refusal = invocation?.threadId && launches ? await services.phaseIntake.launchRefusal(invocation.threadId) : null;
        if (refusal) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:refusal }) };
        const routed = await cliInspect({ ctx, services, command, args, invocation, commands: cliCommands, migrations }) ?? await cliPipeline({ ctx, services, command, args, invocation, commands: cliCommands, migrations });
        if (routed) return routed;
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
              // `owner` on the superseded row is the tombstone: a re-import of the record's file never brings it back (SMA m_lifecycle).
              hideRecord(db, projectId, id, "superseded", by, unindex, "owner");
              return { exitCode:0, stdout:`${id} superseded by ${by}\n` };
            }
            // `--expire` is the owner's act too: the `owner` reason keeps it down on every path, unlike `dated` which a restatement revives.
            const reason = args.includes("--revoke") ? "revoked" : args.includes("--archive") ? "archived" : args.includes("--expire") ? "owner" : null;
            if (!reason) return { exitCode:1, stderr:"pick one: --revoke, --expire, --archive, --replace <newId>, or --erase --yes" };
            if (!hideRecord(db, projectId, id, "expired", null, unindex, reason)) return { exitCode:1, stderr:`record ${id} is not active` };
            return { exitCode:0, stdout:`${id} ${reason === "owner" ? "expired" : reason}\n` };
          }
          if (sub === "history") {
            if (!projectId) return { exitCode:1, stderr:"no project: pass --project <id> outside a BB thread" };
            // History reads transcripts and books: from a thread only the thread's own project (an explicit --project skips the lookup above, so check it here).
            if (invocation?.threadId) {
              const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
              if (!caller || typeof caller.projectId !== "string" || caller.projectId !== projectId) return { exitCode:1, stderr:`refused: memory history from a thread reaches only that thread's own project (${typeof caller?.projectId === "string" ? caller.projectId : "unknown"}), not ${projectId}` };
            }
            const source = value("--source");
            if (source && !HISTORY_SOURCES.includes(source as never)) return { exitCode:1, stderr:`--source is one of ${HISTORY_SOURCES.join("|")}` };
            const question = args.slice(1).filter((arg, i) => !arg.startsWith("--") && (flag < 0 || (i + 1 !== flag && i + 1 !== flag + 1)) && args.indexOf(arg) !== args.indexOf("--source") + 1).join(" ").trim();
            if (!question) return { exitCode:1, stderr:'usage: bb lane-pilot memory history "<question>" [--project P] [--source tasks|execution|transcripts|lessons|books]' };
            const hits = historySearch(db as never, projectId, question, { sources: source ? [source as never] : undefined });
            const lines = hits.map((hit) => `${hit.source} ${hit.id} ${new Date(hit.at).toISOString().slice(0, 10)}: ${hit.excerpt}`);
            return { exitCode:0, stdout:`${lines.join("\n") || "nothing found"}\n` };
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
          if (sub === "search" && args.includes("--recall")) {
            // The prompt recall of the session hook (SMA k_h_prompt_recall): read-only and local. The word index only (no embedding, no rerank, no model or
            // network call), confirmed notes of the caller's own project, no miss recorded, and the text masked and on one line per record. The query is the
            // value of --query, so a prompt that starts with a dash is never read as an option. `hook.prompt_recall=off` silences it.
            const queryAt = args.indexOf("--query");
            if (queryAt < 0 || !args[queryAt + 1]) return { exitCode:1, stderr:'usage: bb lane-pilot memory search --recall --query "<words>" [--cwd <path>] [--project P]' };
            const rest = args.filter((_, index) => index !== queryAt && index !== queryAt + 1);
            const flagValue = (name: string) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
            const bound = await hookProject("memory search --recall", invocation, { project: flagValue("--project"), cwd: flagValue("--cwd") });
            if (bound.refused) return { exitCode:1, stderr:bound.refused };
            if (!bound.projectId) return { exitCode:1, stderr:"no project: pass --project <id> or --cwd <checkout> outside a BB thread" };
            const chain = flagValue("--cwd") ? settingsScopesForWorkspacePath(db, flagValue("--cwd")!) : [];
            if (!switchOn(loadProjectSettings(db, bound.projectId, chain), "hook.prompt_recall")) return { exitCode:0, stdout:"" };
            const hits = confirmedWordHits(db, bound.projectId, args[queryAt + 1]!, { chain, limit: 3 });
            const oneLine = (text: string) => maskCredentials(text.replace(/\s+/g, " ").trim()).text;
            return { exitCode:0, stdout: hits.length ? `${hits.map((record) => `- [${record.id}] ${oneLine(record.content).slice(0, 400)}`).join("\n")}\n` : "" };
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
        if (command === "session-brief") {
          // The session hook's coordination brief (SMA k_hss_summary, k_hss_digest): live and stale attempts of
          // the checkout's project, a merge in flight, other windows' claims and the weakly calibrated areas.
          const val = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
          const cwd = val("--cwd") || process.cwd();
          const bound = await hookProject("session-brief", invocation, { project: val("--project"), cwd });
          if (bound.refused) return { exitCode:1, stderr:bound.refused };
          const projectId = bound.projectId;
          const cutoff = Date.now() - 180_000;
          const live = projectId ? projectLiveAttempts(db, projectId) : [];
          const counts = { live: live.filter((row) => row.updated_at >= cutoff).length, stale: live.filter((row) => row.updated_at < cutoff).length };
          let merge = false;
          if (projectId) {
            const kv = bb.storage.kv as unknown as { list(prefix?: string): Promise<string[]>; get(key: string): Promise<unknown> };
            for (const key of await kv.list(MERGE_INTENT_PREFIX)) {
              try {
                const intent = await kv.get(key) as { projectId?: string } | null;
                if (intent?.projectId === projectId) { merge = true; break; }
              } catch { /* an unreadable intent decides nothing */ }
            }
          }
          // Other windows' claims: attempts that moved inside the same 3 minutes the summary counts as live, and never the starting session's own attempt (its workspace is the cwd or holds it).
          const here = resolve(cwd);
          const ownWorkspace = (workspace: string | null) => { if (!workspace) return false; const root = resolve(workspace); return here === root || here.startsWith(`${root}${sep}`); };
          const foreign = live.filter((row) => row.updated_at >= cutoff && !ownWorkspace(row.workspace_path)).slice(0, 5).map((row) => ({
            taskId: row.task_id,
            paths: (() => { try { return (JSON.parse(row.owns_paths ?? "[]") as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 10); } catch { return []; } })(),
          })).filter((row) => row.paths.length);
          const weak = projectId ? weakAreas(db, projectId) : [];
          const summary = sessionSummaryLine({ ...counts, merge });
          if (args.includes("--json")) return { exitCode:0, stdout:JSON.stringify({ project: projectId, ...counts, merge, foreign, weak, summary }, null, 2) };
          return { exitCode:0, stdout:`${summary || "nothing at work in this project"}\n` };
        }
        if (command === "subagent-pack") {
          // The layers a Task spawn is born with (SMA k_h_pretask): accepted always-rules and confirmed memory
          // lessons. Memory text enters a subagent's prompt only where the project switched hook.subagent_pack on.
          const val = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
          const cwd = val("--cwd");
          const bound = await hookProject("subagent-pack", invocation, { project: val("--project"), cwd });
          if (bound.refused) return { exitCode:1, stderr:bound.refused };
          const projectId = bound.projectId;
          if (!projectId) return { exitCode:1, stderr:"no project: pass --project <id> or --cwd <checkout> outside a BB thread" };
          // The caller's sections: the rules of a sibling section of an umbrella project stay out of the pack.
          const chain = cwd ? settingsScopesForWorkspacePath(db, cwd) : [];
          const settings = loadProjectSettings(db, projectId, chain);
          if (!switchOn(settings, "hook.subagent_pack") || !memorySettingsFor(settings).enabled) return { exitCode:0, stdout:JSON.stringify({ rules: [], lessons: [] }) };
          const prompt = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--cwd" && args[i - 1] !== "--project").join(" ").slice(0, 300);
          const oneLine = (text: string, max: number) => maskCredentials(text.replace(/\s+/g, " ").trim()).text.slice(0, max);
          const rules = pmRulesOf(db, projectId, chain).filter((rule) => rule.always).map((rule) => oneLine(rule.rule, 200)).slice(0, 8);
          // An accepted rule is also a core record: it is said once, in the rules layer, not again as a lesson.
          const lessons = confirmedWordHits(db, projectId, prompt || "task", { chain, limit: 8 }).filter((record) => !record.concepts.includes("rule")).slice(0, 5).map((record) => oneLine(record.content, 200));
          return { exitCode:0, stdout:JSON.stringify({ rules, lessons }) };
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
        const routed2 = await cliProject({ ctx, services, command, args, invocation, commands: cliCommands, migrations }) ?? await cliHost({ ctx, services, command, args, invocation, commands: cliCommands, migrations });
        if (routed2) return routed2;
        return { exitCode:1, stderr:cliUsageText };
      } catch (cause) {
        return { exitCode:1, stderr:cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });
}
