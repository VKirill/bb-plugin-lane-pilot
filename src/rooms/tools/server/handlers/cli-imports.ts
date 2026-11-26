import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { prototypeConfigSchema, resolvePlanningHome, taskV2Schema } from "../../../contracts";
import { taskBaselineEntries } from "../../../baseline";
import { failureFieldsOf, getActivation, getAttempt, getRun, getRunWriterHost, getTask, inspectAttempt, inspectState, listAttemptReasonsSince, listRunsWithAttempts, loadProjectSettings, PROTECTIONS, loadPrototypeConfig, saveProjectSetting, savePrototypeConfig, transitionAttempt, failedTasksAllProjects, projectIdForWorkspacePath, projectLiveAttempts, attemptStateCounts, settingsScopesForWorkspacePath } from "../../../storage";
import { outsideWorkSummary } from "../../../owner-presence";
import { cancelAttemptById, conveyorState, finishRunSafely, pauseRun, setConveyor, taskTimeline } from "../../../runs/server";
import { renderTimeline, unknownReasons } from "../../../runs";

import { bestEffort, isNotFound, maskCredentials, orMiss, pluginRootFromModule, spawnAsync, stringAt, valueAt } from "@lane-pilot/kit";
import { switchOn } from "@lane-pilot/models";
import { listQaHosts, runSkillsCli, parseSkillHub, SKILLS_USAGE } from "../../../platform/server";
import { terminalParity } from "../../../native-agent";

import { THREAD_WATCH_EVENT_TYPES, decideThreadCompletion, eventsListQueryLabel, listThreadEventsRaw, waitThreadIdle } from "@lane-pilot/thread-observe";
import type { ScheduleAgentApi } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { RUN_BUDGET_SETTINGS, runHealth } from "../../../stability/server";

import { SCHEDULE_USAGE, runScheduleCli, scheduleFailureSweep } from "../../../schedule/server";
import { answerWorkflowQuestion } from "../../../workflow/server";
import { AGENTS_USAGE, agentRegistry, attemptSessionLayers, PM_SKILLS_USAGE, runAgentsCli, runPmSkillsCli, runPmSkillUseCli, terminalSessionLayers } from "../../../native-agent/server";
import { collectOwnerMessages, sdkThreadsPort } from "../../../contracts";
import { PROFILE_KEYS, profilePairProblem } from "../../../workflow";

import { attemptMetrics, renderAttemptMetrics } from "../../../usage/server";
import { usageSegment } from "../../../usage";
import type { ProviderUsage } from "../../../usage/server";
import { DEFERRAL_USAGE, runDeferralCli, type DeferralApi } from "../../../deferral/server";
import { MEMORY_EVAL_USAGE, runMemoryEvalCommand } from "../../../memory-eval/server";
import { memoryDedupeChanges, runMemoryDuplicatesCli, memoryMoveSectionChanges, runMemoryMoveSectionCli, writeMoveSectionBackup, MEMORY_COMPRESS_USAGE, MEMORY_CONFLICT_USAGE, memoryCompressChanges, runMemoryCompressCli, runMemoryConflictCli, confirmedWordHits, sessionMemoryRpc, memorySettingsFor } from "../../../memory/server";
import { dropMemoryIndexes, hideRecord, lintMemory, listMemory, memoryConceptsJson, memoryIndexStatus, memoryJudgeStats, memoryRecordExists, memoryTokenStats, rebuildMemoryIndexes, recordMemoryMiss, reviewMemory } from "@lane-pilot/memory-core";

import { runReturnCli } from "../../../stage-return/server";
import { FORECAST_USAGE, runForecastCli } from "../../../forecast/server";
import { calibrationPassport, weakAreas } from "../../../forecast/server";
import { sessionSummaryLine } from "../../../session-hooks";
import { MERGE_INTENT_PREFIX } from "../../../verification";


import { OUTAGE_USAGE, runOutageCli } from "../../../outage/server";
import { HISTORY_SOURCES, historySearch, tierReport } from "../../../memory-tiers/server";

import { WAITING_USAGE, runWaitingCli } from "../../../owner-waiting/server";

import { mergeFrontmatter, parseFrontmatter, setFrontmatter } from "../../../docs";
import { closeOwnerItem, postOwnerItem } from "../../../owner-waiting";
import { manifest, passport, preship } from "../services/receipts";

import { ROLLBACK_USAGE, runRollbackCli, type RollbackApi } from "../../../rollback/server";
import { casUpsertSettings, deleteBoundSetting, getSettingVersions, listEvidence, listSettingRows, planningHomeInputs } from "../../../storage";
import { UNLISTED_SWITCHES, switchValue } from "../../../settings";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { integrityReport, renewDisarm } from "../../../protections";
import { isCodeCriticDefault } from "../../../contracts/task-enums"
import { CODE_CRITIC_DEFAULTS } from "../../../contracts/task-enums";
import { runSkillLintCli } from "../../skill-lint";
import { EPISODES_USAGE, runEpisodesCli } from "../../../errands/server";
import type { BacklogApi } from "../../../backlog/server";
import type { CheckersApi } from "../../../checkers/server";
import type { DocsApi } from "../../../docs/server";
import type { MemoryProbeApi } from "../../../memory-probe/server";
import type { MemoryConflictsApi } from "../../../memory/server";
import type { MoneyApi } from "../../../money/server";
import type { ActivationApi } from "../../../contracts";
import type { OwnerPresenceApi } from "../../../owner-presence/server";
import type { PhaseIntake } from "../../../contracts/server";
import type { ReconcileApi } from "../../../stability/server";
import type { StageReturnApi } from "../../../stage-return/server";
import { writerQuestionSweep, budgetSpentSweep } from "../../../writer/server";
import type { WriterDispatchApi } from "../../../writer/server";
import type { WriterStateApi } from "../../../writer/server";
import type { WriterVerifyApi } from "../../../writer/server";
import type { BaselineApi } from "../../../baseline/server";
import type { ScheduleService } from "../../../schedule/server";
import type { RuleScanSurface } from "../../../contracts/server";
import type { WriterSpawnApi } from "../../../writer/server";
import type { WriterStartApi } from "../../../writer/server";
import type { CodeCriticDefault } from "../../../contracts/task-enums";
import type { WorkflowEngineApi, WorkflowTriggersApi, WriterHostApi } from "../../../platform/server";

export type { ActivationApi, BacklogApi, BaselineApi, CheckersApi, CodeCriticDefault, DeferralApi, DocsApi, MemoryConflictsApi, MemoryProbeApi, MoneyApi, OwnerPresenceApi, PhaseIntake, ProviderUsage, ReconcileApi, RollbackApi, RuleScanSurface, ScheduleAgentApi, ScheduleService, ServerCore, StageReturnApi, WorkflowEngineApi, WorkflowTriggersApi, WriterDispatchApi, WriterHostApi, WriterSpawnApi, WriterStartApi, WriterStateApi, WriterVerifyApi };
export { memoryMoveSectionChanges, runMemoryMoveSectionCli, writeMoveSectionBackup, AGENTS_USAGE, CODE_CRITIC_DEFAULTS, DEFERRAL_USAGE, EPISODES_USAGE, FORECAST_USAGE, GLOBAL_SETTINGS_PROJECT_ID, HISTORY_SOURCES, memoryDedupeChanges, runMemoryDuplicatesCli, MEMORY_COMPRESS_USAGE, MEMORY_CONFLICT_USAGE, MEMORY_EVAL_USAGE, MERGE_INTENT_PREFIX, OUTAGE_USAGE, PM_SKILLS_USAGE, PROFILE_KEYS, PROTECTIONS, ROLLBACK_USAGE, RUN_BUDGET_SETTINGS, SCHEDULE_USAGE, SKILLS_USAGE, THREAD_WATCH_EVENT_TYPES, UNLISTED_SWITCHES, WAITING_USAGE, agentRegistry, answerWorkflowQuestion, attemptMetrics, attemptSessionLayers, attemptStateCounts, bestEffort, budgetSpentSweep, calibrationPassport, cancelAttemptById, casUpsertSettings, closeOwnerItem, collectOwnerMessages, confirmedWordHits, conveyorState, createHash, decideThreadCompletion, deleteBoundSetting, dirname, dropMemoryIndexes, eventsListQueryLabel, failedTasksAllProjects, failureFieldsOf, finishRunSafely, getActivation, getAttempt, getRun, getRunWriterHost, getSettingVersions, getTask, hideRecord, historySearch, inspectAttempt, inspectState, integrityReport, isCodeCriticDefault, isNotFound, join, lintMemory, listAttemptReasonsSince, listEvidence, listMemory, listQaHosts, listRunsWithAttempts, listSettingRows, listThreadEventsRaw, loadProjectSettings, loadPrototypeConfig, manifest, maskCredentials, memoryCompressChanges, memoryConceptsJson, memoryIndexStatus, memoryJudgeStats, memoryRecordExists, memorySettingsFor, memoryTokenStats, mergeFrontmatter, orMiss, outsideWorkSummary, parseFrontmatter, parseSkillHub, passport, pauseRun, planningHomeInputs, pluginRootFromModule, postOwnerItem, preship, profilePairProblem, projectIdForWorkspacePath, projectLiveAttempts, prototypeConfigSchema, rebuildMemoryIndexes, recordMemoryMiss, renderAttemptMetrics, renderTimeline, renewDisarm, resolve, resolvePlanningHome, reviewMemory, runAgentsCli, runDeferralCli, runEpisodesCli, runForecastCli, runHealth, runMemoryCompressCli, runMemoryConflictCli, runMemoryEvalCommand, runOutageCli, runPmSkillUseCli, runPmSkillsCli, runReturnCli, runRollbackCli, runScheduleCli, runSkillLintCli, runSkillsCli, runWaitingCli, saveProjectSetting, savePrototypeConfig, scheduleFailureSweep, sdkThreadsPort, sep, sessionMemoryRpc, sessionSummaryLine, setConveyor, setFrontmatter, settingsScopesForWorkspacePath, spawnAsync, stringAt, switchOn, switchValue, taskBaselineEntries, taskTimeline, taskV2Schema, terminalParity, terminalSessionLayers, tierReport, transitionAttempt, unknownReasons, usageSegment, valueAt, waitThreadIdle, weakAreas, writerQuestionSweep };
