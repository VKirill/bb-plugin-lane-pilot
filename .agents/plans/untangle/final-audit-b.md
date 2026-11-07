---
title: Final audit B — why the 64-room SCC holds
date: 2026-11-07
commit: 3b87083f (detached worktree wt/audit)
method: scripted, read-only; scripts in .bb/chats/thr_3rx8u95vyd/tmp/
---

# Final audit B — the room cycle

`node scripts/room-graph.mjs` at this commit: **88 rooms, largest SCC 64, mutual
pairs 94, room edges 684**. Progress vs the c6b443cb baseline (81/65/123/671):
the F2 merge already pulled `storage` out of the SCC (out 27→4, fan-in 55 —
it is now a true leaf) and mutual pairs dropped 123→94.

## Why the SCC holds

Three braided causes, all visible in the edge data:

1. **43 rooms import the composition root.** `core/server/index.ts` is a pure
   barrel re-exporting ~20 mixed modules (Services type, `scheduleIsolated`,
   spawn/model-catalog, `registerObservedTool`, git RPC, PM spawn, thread
   keys). `core` imports 54 rooms to wire them. That alone is 37 of the 94
   mutual pairs.
2. **Shared surfaces are consumed both ways.** `ui-shell` is imported by 12
   domain UIs but its tab-* pages import 18 rooms back; `settings` is imported
   by 8 rooms and imports 17; `contracts` (fan-in 58) still reaches into
   `anamnesis` and `schedule`; `writer`/`workflow` export engine surfaces
   (executors, fallbacks, constants) to their callers.
3. **A genuine domain mesh underneath.** 24 of the 94 mutual pairs involve no
   hub at all — `runs`, `qa`, `tasks`, `critique`, `stability`,
   `native-agent`, `lead`, `verification`, `self-repair`, `improvement`,
   `schedule`, `memory`, `learning`, `wall` call each other's server
   functions directly. `@migrations.ts` (a loose file) imports 22 rooms for
   their migration slices and is imported back by `memory-eval`.

## 1. Feedback arc set

Method: Eades–Lin–Smyth greedy ordering on the induced 64-room subgraph, then
an insertion-move local search to fixpoint; a 25 s simulated-annealing check
reached the same ~110. **Heuristic, not a proven minimum** — but two
independent methods agree, so ~110 of ~600 intra-SCC edges is the honest
scale: the cycle is held by *many* edges, not a few cut points. Removing the
110 edges below makes the subgraph a verified DAG of **27 topological
layers**.

- **61 of 110 edges point the wrong way** by the volatility rule (importer
  changed less often than importee over `git log --since=60.days`, commits
  per room; writer 231, workflow 171, native-agent 139, tools 119, runs 112,
  core 111 are the most volatile).
- **12 edges are carried only by `import type`** — cheapest cuts: move the
  type to `contracts` and the edge is gone with zero runtime change.
- `kept` = the greedy cut chose this edge, but the real fix removes the
  *partner* direction (see §2); the edge itself stays legal.
- The FAS is one valid cut, not a unique answer: a different heuristic picks
  different edges on the same cycles. The redesign groups in §2 are what
  actually gets deleted.

| edge | sites | imported symbols | churn a→b | wrong-way | group |
|---|---|---|---|---|---|
| `anamnesis → workflow` | 2 | NodeExecutor, WorkflowEngine, ChainRuntime | 17→171 | **stable→volatile** ·type-only | G5 |
| `anamnesis → qa` | 1 | mapListedQaHosts | 17→37 | **stable→volatile** | G7 |
| `anamnesis → core` | 1 | scheduleIsolated | 17→111 | **stable→volatile** | G1 |
| `backlog → core` | 1 | scheduleIsolated | 8→111 | **stable→volatile** | G1 |
| `baseline → core` | 4 | Services, scheduleIsolated, callerPluginMetadata, registerObservedTool | 27→111 | **stable→volatile** | G1 |
| `bench → core` | 3 | fullAccessSpawn, Services, scheduleIsolated, SCHEDULE_TIMEOUT_CAP_MS | 62→111 | **stable→volatile** | G1 |
| `bench → improvement` | 1 | hubFields, writeHubFields | 62→4 | ok | G7 |
| `capability → core` | 1 | scheduleIsolated, Services | 8→111 | **stable→volatile** | G1 |
| `cockpit → core` | 1 | Services | 9→111 | **stable→volatile** ·type-only | G1 |
| `contracts → anamnesis` | 2 | anamnesisHostMethods, anamnesisRpcMethods | 108→17 | ok | G4 |
| `contracts → schedule` | 1 | scheduleRpcContract | 108→34 | ok | G4 |
| `core → settings` | 3 | preferencesRpc, settingsRpc, selectionsRpc, roleModelsRpc | 111→80 | ok | —kept |
| `core → wall` | 2 | wallRpc, WallApi | 111→55 | ok | —kept |
| `core → tools` | 1 | boundPresentation | 111→119 | **stable→volatile** | G2 |
| `council → core` | 4 | fullAccessSpawn, graphStepMetadata, findThreadsByMetadata, keyedSpawnSupported, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, Services (+3) | 57→111 | **stable→volatile** | G1 |
| `critique → tasks` | 5 | taskStem, unownedExpectedOutputs, sha256, buildExecutionPacket, renderPacketExcerpts, TRUSTED_TOOLING_PATTERNS, verificationScriptPaths | 85→76 | ok | G7 |
| `critique → qa` | 1 | qaSpawnClaimed | 85→37 | ok | G7 |
| `critique → stability` | 1 | reconcileCritic | 85→49 | ok | G7 |
| `critique → writer` | 3 | resolveStageWriterSelection, dependsOnTask, outputText | 85→231 | **stable→volatile** | G5 |
| `critique → core` | 8 | GIT_PLUGIN_ID, gitCallRpc, gitFilesReplySchema, gitPatchKey, gitPatchesReplySchema, spawnUsageOf, stageHelperSettings, warmSpawnUsage, zcodeBusyPeek (+8) | 85→111 | **stable→volatile** | G1 |
| `critique → memory` | 1 | reviewerMemoryFor | 85→71 | ok | G7 |
| `critique → native-agent` | 4 | recordRoleLine, roleLinesKey, MAIN_AGENT_ID, isCustomAgentId, EMPLOYEES | 85→139 | **stable→volatile** | G7 |
| `critique → workflow` | 3 | builtinWorkflow, ChainRuntime, StepContext, WorkflowEngine | 85→171 | **stable→volatile** | G5 |
| `docs → core` | 7 | graphStepMetadata, modelCatalogOf, resolveSpawnModel, spawnUsageOf, fullAccessSpawn, abortable, scheduleIsolated, Services, warmSpawnUsage (+1) | 38→111 | **stable→volatile** | G1 |
| `errands → core` | 1 | Services | 18→111 | **stable→volatile** ·type-only | G1 |
| `errands → ui-shell` | 1 | Pill, useOpenThreadPanel | 18→51 | **stable→volatile** | —kept |
| `front → core` | 1 | scheduleIsolated | 5→111 | **stable→volatile** | G1 |
| `harness → core` | 1 | fullAccessSpawn, scheduleIsolated, Services | 30→111 | **stable→volatile** | G1 |
| `harness → ui-shell` | 1 | useLpRealtime | 30→51 | **stable→volatile** | —kept |
| `hypotheses → core` | 1 | Services | 4→111 | **stable→volatile** ·type-only | G1 |
| `improvement → wall` | 1 | WallApi | 4→55 | **stable→volatile** ·type-only | G7 |
| `improvement → settings` | 1 | InheritanceContext, SettingField, SettingsGroup | 4→80 | **stable→volatile** | G6 |
| `lead → core` | 6 | Services, fullAccessSpawn, modelCatalogOf, resolveSpawnModel, scheduleIsolated, spawnUsageOf, warmSpawnUsage, registerObservedTool | 29→111 | **stable→volatile** | G1 |
| `lead → memory-eval` | 1 | loadEvalData, runMemoryEval | 29→8 | ok | G7 |
| `lead → self-repair` | 1 | lanePilotProjectOrNotice | 29→70 | **stable→volatile** | G7 |
| `learning → self-repair` | 2 | adoptRuleProposal, deleteMemoryRecord, memorySettingsFor, rejectRuleProposal, retireAdoptedRule | 27→70 | **stable→volatile** | G7 |
| `learning → core` | 3 | scheduleIsolated, registerObservedTool, Services | 27→111 | **stable→volatile** | G1 |
| `memory → core` | 5 | scheduleIsolated, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stageHelperSettings, fullAccessSpawn, graphStepMetadata, Services | 71→111 | **stable→volatile** | G1 |
| `memory → writer` | 1 | memoryLine, reviewerMemoryPicks, writerMemory, writerMemoryPicks | 71→231 | **stable→volatile** | G5 |
| `memory → self-repair` | 2 | adoptRuleProposal, memorySettingsFor | 71→70 | ok | G7 |
| `memory-probe → core` | 1 | Services | 8→111 | **stable→volatile** ·type-only | G1 |
| `native-agent → workflow` | 3 | WORKFLOW_ARCHITECT_ID, WORKFLOW_ARCHITECT_NAME, WORKFLOW_ARCHITECT_TOOLS, WORKFLOW_ARCHITECT_SESSION, WORKFLOW_ARCHITECT_SUMMARY, takeArchitectLaunch | 139→171 | **stable→volatile** | G5 |
| `native-agent → lead` | 2 | LEAD_ID, LEAD_NAME, LEAD_TOOLS, LEAD_SESSION, LEAD_SUMMARY | 139→29 | ok | G7 |
| `native-agent → tools` | 1 | rewriteFoldedToolNames | 139→119 | ok | G2 |
| `native-agent → writer` | 4 | LIVE_FOLDER_FILE_CAP, STICKY_WINDOW_MS, noteCheckoutGuest, WRITER_FALLBACK_DEFAULTS, WRITER_FALLBACK_SLOTS, writerFallbackKeys, writerFallbackSeed, writerFallbackSlots, WriterFallbackSlot | 139→231 | **stable→volatile** | G5 |
| `native-agent → native-install` | 2 | NATIVE_OPENCODE_SOURCES, atomicText, NATIVE_HOOK_SOURCES, SESSION_HOOK_SOURCE | 139→45 | ok | G7 |
| `native-agent → core` | 4 | fullAccessSpawn, pmHasGuard, pmPrompt, Services, scheduleIsolated | 139→111 | ok | G1 |
| `native-agent → schedule` | 1 | createScheduleStore, taskOf | 139→34 | ok | G7 |
| `native-agent → ui-shell` | 3 | useLpRealtime, useLpRpcQuery, useOpenThreadPanel, asBoolean, COUNCIL_SEATS, LpPage | 139→51 | ok | —kept |
| `native-agent → qa` | 1 | QA_HOST_KEY, QA_WORKSPACE_KEY | 139→37 | ok | G7 |
| `native-agent → settings` | 3 | AdvancedRows, CatalogField, SelectionId | 139→80 | ok | G6 |
| `native-install → settings` | 1 | readImportConfig | 45→80 | **stable→volatile** | G6 |
| `night → core` | 1 | GIT_PLUGIN_ID, gitCallRpc | 13→111 | **stable→volatile** | G1 |
| `owner-waiting → improvement` | 1 | hubFields, writeHubFields | 18→4 | ok | G7 |
| `owner-waiting → ui-shell` | 1 | useLpRpcQuery | 18→51 | **stable→volatile** | —kept |
| `phase → workflow` | 3 | builtinWorkflow, issueQuickWorkflowId, architectStarter, createWorkflowLibrary | 104→171 | **stable→volatile** | G5 |
| `phase → core` | 4 | Services, scheduleIsolated, registerObservedTool | 104→111 | **stable→volatile** | G1 |
| `phase → writer` | 1 | recheckPlanFact | 104→231 | **stable→volatile** | G5 |
| `pm-replay → core` | 2 | registeredTools, scheduleIsolated, Services, flatParameters, unionMembers, withSignatures | 9→111 | **stable→volatile** | G1 |
| `project-life → core` | 3 | modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stageHelperSettings, fullAccessSpawn, graphStepMetadata, Services | 17→111 | **stable→volatile** | G1 |
| `qa → core` | 13 | fenceOutside, Services, clearSpawnMarker, findThreadsByMetadata, keyedSpawnSupported, registerObservedTool, spawnTextId, modelCatalogOf, resolveSpawnModel (+7) | 37→111 | **stable→volatile** | G1 |
| `relay → native-agent` | 2 | bundledAgents, BB_AGENT_SUMMARIES | 30→139 | **stable→volatile** | G7 |
| `relay → core` | 5 | requirePmRun, ServerContext, registerObservedTool, scheduleIsolated | 30→111 | **stable→volatile** | G1 |
| `rollback → core` | 1 | Services | 6→111 | **stable→volatile** ·type-only | G1 |
| `rule-forms → core` | 2 | scheduleIsolated, Services | 11→111 | **stable→volatile** | G1 |
| `run-goal → core` | 1 | scheduleIsolated, Services | 14→111 | **stable→volatile** | G1 |
| `runs → docs` | 1 | DocsPage | 112→38 | ok ·type-only | G7 |
| `runs → memory` | 1 | MemorySettings | 112→71 | ok ·type-only | G7 |
| `runs → project-life` | 1 | ProjectLifeTaskSummary | 112→17 | ok ·type-only | G7 |
| `runs → stability` | 1 | PARKED_KEY | 112→49 | ok | G7 |
| `runs → native-agent` | 12 | agentPickerLabel, employeeView, pickableAgent, placeEmployeeOn, compileEffectiveMainAgent, detectCompiledMainAgentCapability, detectRequiredSessionPolicyCapability, storeNativeSelection, DEFAULT_NATIVE_AGENT (+15) | 112→139 | **stable→volatile** | G7 |
| `runs → usage` | 1 | queueWaitPercentiles, runQueueWaits | 112→22 | ok | G7 |
| `runs → core` | 4 | folderEnvironment, projectSources, Services, findThreadsByMetadata | 112→111 | ok | G1 |
| `runs → writer` | 1 | STICKY_WINDOW_MS | 112→231 | **stable→volatile** | G5 |
| `runs → tasks` | 2 | sha256, stageTransition, validateStageReceipt, StageId, StageState | 112→76 | ok | G7 |
| `runs → verification` | 1 | createMergeIntentRecovery | 112→64 | ok | G7 |
| `runs → work-graph` | 3 | workGraphStrips, StageModelStats, StageStrip, WorkBreakdown, useStageStrips, StageSteps, Strip | 112→5 | ok | G7 |
| `runs → ui-shell` | 6 | useOpenThreadPanel, StageSummary, runTone, stageTitle, CARD_BODY, CARD_HEAD, COEXISTENCE_MANAGER_KEYS, COEXISTENCE_VALUE_KEYS, compatibilityAliasRows (+4) | 112→51 | ok | —kept |
| `runs → settings` | 2 | settingLabel, FieldControl, StatusBadge, StatusRow | 112→80 | ok | G6 |
| `runs → acceptance` | 1 | AcceptanceCard | 112→5 | ok | G7 |
| `schedule → core` | 8 | Services, registerObservedTool | 34→111 | **stable→volatile** | G1 |
| `schedule → qa` | 1 | QA_HOST_KEY, mapListedQaHosts | 34→37 | **stable→volatile** | G7 |
| `schedule → ui-shell` | 4 | useLpPoll, useLpRealtime, Pill, useOpenThreadPanel | 34→51 | **stable→volatile** | —kept |
| `secrets → verification` | 1 | SANDBOX_OWN_ENV | 11→64 | **stable→volatile** | G7 |
| `self-repair → ui-shell` | 1 | useLpPoll, useLpRealtime | 70→51 | ok | —kept |
| `stability → core` | 13 | scheduleIsolated, requirePmRun, ServerContext, registerObservedTool, Services, bindRunChildBudget, fullAccessSpawn, holderSpawnKey, findThreadsByMetadata | 49→111 | **stable→volatile** | G1 |
| `stability → qa` | 1 | mapListedQaHosts | 49→37 | ok | G7 |
| `stability → writer` | 1 | STICKY_WINDOW_MS | 49→231 | **stable→volatile** | G5 |
| `stage-return → writer` | 1 | createAttemptReopen, createWriterReassign | 6→231 | **stable→volatile** | G5 |
| `stage-return → core` | 1 | Services | 6→111 | **stable→volatile** ·type-only | G1 |
| `tasks → baseline` | 2 | EXISTENCE_ONLY_WORDS, NO_RED_KINDS | 76→27 | ok | G7 |
| `tasks → native-install` | 1 | parseExecutionLineWindows, PathWindows | 76→45 | ok | G7 |
| `tasks → verification` | 7 | SANDBOX_OWN_ENV, gluedCheckCommand, safeRelative, validateOwnershipContract, gateResolverFor, parseIntegrationGateSettings, FlakyEvidence, dropSatellites | 76→64 | ok | G7 |
| `tasks → core` | 3 | callerPluginMetadata, registerObservedTool, Services | 76→111 | **stable→volatile** | G1 |
| `tasks → lead` | 1 | answerTaskWord | 76→29 | ok | G7 |
| `ui-shell → settings` | 13 | settingUnitKey, OwnedSettings, InheritanceContext, CatalogField, SettingsGroup, CatalogFields, AdvancedRows, LocaleControls, OverviewLoading (+19) | 51→80 | **stable→volatile** | G3 |
| `usage → core` | 1 | scheduleIsolated | 22→111 | **stable→volatile** | G1 |
| `verification → core` | 2 | Services | 64→111 | **stable→volatile** ·type-only | G1 |
| `verification → lead` | 1 | addRoad, getRoad, listRoad | 64→29 | ok | G7 |
| `workflow → core` | 26 | Services, fullAccessSpawn, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, findThreadsByMetadata, graphStepMetadata, keyedSpawnSupported (+18) | 171→111 | ok | G1 |
| `workflow → self-repair` | 1 | lanePilotProjectOrNotice | 171→70 | ok | G7 |
| `workflow → writer` | 9 | outputText, providerLimitNotice, lpTaskPipelineExecutor, taskUsage, DispatchRuntime, (dynamic), resolveStageWriterSelection, writerFallbackChain, writerFallbacks (+1) | 171→231 | **stable→volatile** | G5 |
| `workflow → lead` | 2 | doneRoad, reopenRoad, LEAD_ID | 171→29 | ok | G7 |
| `workflow → qa` | 1 | QA_HOST_KEY, mapListedQaHosts | 171→37 | ok | G7 |
| `workflow → errands` | 1 | ERRAND_EPISODE_TRACE_EVENTS, recordErrandEpisode | 171→18 | ok | G7 |
| `workflow → ui-shell` | 5 | useLpPoll, useLpRealtime, useOpenThreadPanel | 171→51 | ok | —kept |
| `writer → settings` | 1 | validateSettingsObject, validationErrorText | 231→80 | ok | G6 |
| `writer → core` | 29 | Services, findThreadsByMetadata, fullAccessSpawn, graphStepMetadata, sendPmNotice, stageHelperSettings, holderSpawnKey, CATALOG_WAIT_MS, modelCatalogOf (+7) | 231→111 | ok | G1 |
| `writer → lead` | 1 | askTaskWord, taskWordItemPrefix | 231→29 | ok | G7 |
| `writer → qa` | 1 | mapListedQaHosts | 231→37 | ok | G7 |

<details>
<summary>Per-edge import sites (file:line, clause)</summary>

**`anamnesis → workflow`**
- `src/rooms/anamnesis/chain-actions.ts:1` — `import type { NodeExecutor, WorkflowEngine } from "../workflow"` (type-only)
- `src/rooms/anamnesis/chain-actions.ts:3` — `import type { ChainRuntime } from "../workflow/server"` (type-only)

**`anamnesis → qa`**
- `src/rooms/anamnesis/wiring.ts:4` — `import { mapListedQaHosts } from "../qa"`

**`anamnesis → core`**
- `src/rooms/anamnesis/wiring.ts:17` — `import { scheduleIsolated } from "../core/server"`

**`backlog → core`**
- `src/rooms/backlog/server/scanner.ts:2` — `import { scheduleIsolated } from "../../core/server"`

**`baseline → core`**
- `src/rooms/baseline/server/baseline.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/baseline/server/index.ts:2` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/baseline/server/regress.ts:4` — `import { scheduleIsolated, type Services } from "../../core/server"`
- `src/rooms/baseline/server/regression-tools.ts:2` — `import { callerPluginMetadata, registerObservedTool, type Services } from "../../core/server"`

**`bench → core`**
- `src/rooms/bench/server/plugin-ports.ts:4` — `import { fullAccessSpawn, type Services } from "../../core/server"`
- `src/rooms/bench/server/service-pin.ts:1` — `import { scheduleIsolated, SCHEDULE_TIMEOUT_CAP_MS } from "../../core/server"`
- `src/rooms/bench/server/weekly.ts:2` — `import { scheduleIsolated, SCHEDULE_TIMEOUT_CAP_MS } from "../../core/server"`

**`bench → improvement`**
- `src/rooms/bench/service.ts:1` — `import { hubFields, writeHubFields } from "../improvement"`

**`capability → core`**
- `src/rooms/capability/server/capability.ts:3` — `import { scheduleIsolated, type Services } from "../../core/server"`

**`cockpit → core`**
- `src/rooms/cockpit/server.ts:2` — `import type { Services } from "../core/server"` (type-only)

**`contracts → anamnesis`**
- `src/rooms/contracts/host.ts:2` — `import { anamnesisHostMethods } from "../anamnesis"`
- `src/rooms/contracts/rpc-knowledge.ts:2` — `import { anamnesisRpcMethods } from "../anamnesis"`

**`contracts → schedule`**
- `src/rooms/contracts/rpc-shell.ts:2` — `import { scheduleRpcContract } from "../schedule"`

**`core → settings`**
- `src/rooms/core/server/rpc.ts:4` — `import { preferencesRpc } from "../../settings/server"`
- `src/rooms/core/server/rpc.ts:6` — `import { settingsRpc } from "../../settings/server"`
- `src/rooms/core/server/rpc.ts:7` — `import { selectionsRpc, roleModelsRpc } from "../../settings/server"`

**`core → wall`**
- `src/rooms/core/server/rpc.ts:43` — `import { wallRpc } from "../../wall/server"`
- `src/rooms/core/server/services.ts:19` — `import type { WallApi } from "../../wall/server"` (type-only)

**`core → tools`**
- `src/rooms/core/server/tool-result.ts:5` — `import { boundPresentation } from "../../tools/server"`

**`council → core`**
- `src/rooms/council/server/council-graph.ts:18` — `import { fullAccessSpawn, graphStepMetadata, findThreadsByMetadata, keyedSpawnSupported, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../core/server"`
- `src/rooms/council/server/council-graph.ts:21` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/council/server/council.ts:18` — `import { requirePmRun } from "../../core/server"`
- `src/rooms/council/server/council.ts:23` — `import { fenceOutside, registerObservedTool } from "../../core/server"`

**`critique → tasks`**
- `src/rooms/critique/critic-stats.ts:3` — `import { taskStem } from "../tasks"`
- `src/rooms/critique/server/critique-runs.ts:1` — `import { unownedExpectedOutputs } from "../../tasks"`
- `src/rooms/critique/server/critique-runs.ts:15` — `import { sha256 } from "../../tasks"`
- `src/rooms/critique/server/critique-runs.ts:19` — `import { buildExecutionPacket, renderPacketExcerpts } from "../../tasks/execution-packet"`
- `src/rooms/critique/task-brief.ts:1` — `import { TRUSTED_TOOLING_PATTERNS, verificationScriptPaths } from "../tasks"`

**`critique → qa`**
- `src/rooms/critique/server/critique-runs.ts:8` — `import { qaSpawnClaimed } from "../../qa"`

**`critique → stability`**
- `src/rooms/critique/server/critique-runs.ts:9` — `import { reconcileCritic } from "../../stability"`

**`critique → writer`**
- `src/rooms/critique/server/critique-runs.ts:10` — `import { resolveStageWriterSelection } from "../../writer"`
- `src/rooms/critique/server/critique-runs.ts:39` — `import { dependsOnTask } from "../../writer/server/start"`
- `src/rooms/critique/server/specialists.ts:8` — `import { outputText } from "../../writer/server/writer-task"`

**`critique → core`**
- `src/rooms/critique/server/critique-runs.ts:30` — `import { GIT_PLUGIN_ID, gitCallRpc, gitFilesReplySchema, gitPatchKey, gitPatchesReplySchema, spawnUsageOf, stageHelperSettings, warmSpawnUsage, zcodeBusyPeek } from "../../core/server"`
- `src/rooms/critique/server/critique-runs.ts:32` — `import type { PluginCallRpc } from "../../core/server"` (type-only)
- `src/rooms/critique/server/critique-runs.ts:33` — `import { fullAccessSpawn, graphStepMetadata } from "../../core/server"`
- `src/rooms/critique/server/critique-runs.ts:35` — `import { clearSpawnMarker } from "../../core/server"`
- `src/rooms/critique/server/specialist-graph.ts:4` — `import { fenceOutside, spawnTextId } from "../../core/server"`
- `src/rooms/critique/server/specialist-graph.ts:6` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/critique/server/specialists.ts:9` — `import { fenceOutside, registerObservedTool } from "../../core/server"`
- `src/rooms/critique/server/specialists.ts:11` — `import type { Services } from "../../core/server"` (type-only)

**`critique → memory`**
- `src/rooms/critique/server/critique-runs.ts:34` — `import { reviewerMemoryFor } from "../../memory/server"`

**`critique → native-agent`**
- `src/rooms/critique/server/employee-lessons.ts:12` — `import { recordRoleLine } from "../../native-agent"`
- `src/rooms/critique/server/employee-lessons.ts:13` — `export { recordRoleLine, roleLinesKey } from "../../native-agent"`
- `src/rooms/critique/server/specialists.ts:1` — `import { MAIN_AGENT_ID, isCustomAgentId } from "../../native-agent"`
- `src/rooms/critique/server/specialists.ts:2` — `import { EMPLOYEES } from "../../native-agent"`

**`critique → workflow`**
- `src/rooms/critique/server/specialist-graph.ts:3` — `import { builtinWorkflow } from "../../workflow"`
- `src/rooms/critique/server/specialists.ts:13` — `import type { ChainRuntime } from "../../workflow/server"` (type-only)
- `src/rooms/critique/server/specialists.ts:14` — `import type { StepContext, WorkflowEngine } from "../../workflow"` (type-only)

**`docs → core`**
- `src/rooms/docs/server/docs-nightly.ts:11` — `import { graphStepMetadata, modelCatalogOf, resolveSpawnModel, spawnUsageOf } from "../../core/server"`
- `src/rooms/docs/server/docs-nightly.ts:13` — `import { fullAccessSpawn } from "../../core/server"`
- `src/rooms/docs/server/docs-nightly.ts:22` — `import { abortable, scheduleIsolated } from "../../core/server"`
- `src/rooms/docs/server/docs-nightly.ts:24` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/docs/server/docs.ts:10` — `import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stageHelperSettings } from "../../core/server"`
- `src/rooms/docs/server/docs.ts:12` — `import { fullAccessSpawn, graphStepMetadata } from "../../core/server"`
- `src/rooms/docs/server/docs.ts:18` — `import type { Services } from "../../core/server"` (type-only)

**`errands → core`**
- `src/rooms/errands/server/rpc.ts:4` — `import type { Services } from "../../core/server"` (type-only)

**`errands → ui-shell`**
- `src/rooms/errands/ui/errands-screen.tsx:9` — `import { Pill, useOpenThreadPanel } from "../../ui-shell/ui"`

**`front → core`**
- `src/rooms/front/server/index.ts:2` — `import { scheduleIsolated } from "../../core/server"`

**`harness → core`**
- `src/rooms/harness/server/harness.ts:9` — `import { fullAccessSpawn, scheduleIsolated, type Services } from "../../core/server"`

**`harness → ui-shell`**
- `src/rooms/harness/ui/harness-card.tsx:15` — `import { useLpRealtime } from "../../ui-shell/ui"`

**`hypotheses → core`**
- `src/rooms/hypotheses/server/hypotheses.ts:5` — `import type { Services } from "../../core/server"` (type-only)

**`improvement → wall`**
- `src/rooms/improvement/server/rpc.ts:9` — `import type { WallApi } from "../../wall/server"` (type-only)

**`improvement → settings`**
- `src/rooms/improvement/ui/improvement-page.tsx:5` — `import { InheritanceContext, SettingField, SettingsGroup } from "../../settings/ui"`

**`lead → core`**
- `src/rooms/lead/server/lead-schedule.ts:1` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/lead/server/nearest.ts:5` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/lead/server/service.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/lead/server/service.ts:6` — `import { fullAccessSpawn, modelCatalogOf, resolveSpawnModel, scheduleIsolated, spawnUsageOf, warmSpawnUsage } from "../../core/server"`
- `src/rooms/lead/server/tick.ts:7` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/lead/server/tool.ts:2` — `import { registerObservedTool, type Services } from "../../core/server"`

**`lead → memory-eval`**
- `src/rooms/lead/server/memory-exam.ts:3` — `import { loadEvalData, runMemoryEval } from "../../memory-eval/server"`

**`lead → self-repair`**
- `src/rooms/lead/server/service.ts:13` — `import { lanePilotProjectOrNotice } from "../../self-repair/server"`

**`learning → self-repair`**
- `src/rooms/learning/rules-port.ts:4` — `import { adoptRuleProposal, deleteMemoryRecord, memorySettingsFor, rejectRuleProposal, retireAdoptedRule } from "../self-repair/server/insights"`
- `src/rooms/learning/service.ts:9` — `import { memorySettingsFor } from "../self-repair/server/insights"`

**`learning → core`**
- `src/rooms/learning/service.ts:8` — `import { scheduleIsolated } from "../core/server"`
- `src/rooms/learning/service.ts:10` — `import { registerObservedTool } from "../core/server"`
- `src/rooms/learning/service.ts:12` — `import type { Services } from "../core/server"` (type-only)

**`memory → core`**
- `src/rooms/memory/server/embeddings.ts:2` — `import { scheduleIsolated } from "../../core/server"`
- `src/rooms/memory/server/memory.ts:22` — `import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stageHelperSettings } from "../../core/server"`
- `src/rooms/memory/server/memory.ts:24` — `import { fullAccessSpawn, graphStepMetadata } from "../../core/server"`
- `src/rooms/memory/server/memory.ts:31` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/memory/server/session-memory.ts:10` — `import type { Services } from "../../core/server"` (type-only)

**`memory → writer`**
- `src/rooms/memory/server/memory-mix.ts:4` — `import { memoryLine, reviewerMemoryPicks, writerMemory, writerMemoryPicks } from "../../writer"`

**`memory → self-repair`**
- `src/rooms/memory/server/session-memory.ts:8` — `import { adoptRuleProposal, memorySettingsFor } from "../../self-repair/server"`
- `src/rooms/memory/server/thread-block.ts:2` — `import { memorySettingsFor } from "../../self-repair/server"`

**`memory-probe → core`**
- `src/rooms/memory-probe/server/memory-probe.ts:17` — `import type { Services } from "../../core/server"` (type-only)

**`native-agent → workflow`**
- `src/rooms/native-agent/agent-profile.ts:5` — `import { WORKFLOW_ARCHITECT_ID, WORKFLOW_ARCHITECT_NAME, WORKFLOW_ARCHITECT_TOOLS } from "../workflow"`
- `src/rooms/native-agent/native-agent-overlay.ts:5` — `import { WORKFLOW_ARCHITECT_ID, WORKFLOW_ARCHITECT_SESSION, WORKFLOW_ARCHITECT_SUMMARY } from "../workflow"`
- `src/rooms/native-agent/ui/composer-enable.tsx:22` — `import { takeArchitectLaunch } from "../../workflow/ui"`

**`native-agent → lead`**
- `src/rooms/native-agent/agent-profile.ts:6` — `import { LEAD_ID, LEAD_NAME, LEAD_TOOLS } from "../lead"`
- `src/rooms/native-agent/native-agent-overlay.ts:6` — `import { LEAD_ID, LEAD_SESSION, LEAD_SUMMARY } from "../lead"`

**`native-agent → tools`**
- `src/rooms/native-agent/native-agent-overlay.ts:7` — `import { rewriteFoldedToolNames } from "../tools"`

**`native-agent → writer`**
- `src/rooms/native-agent/native-agent-overlay.ts:10` — `import { LIVE_FOLDER_FILE_CAP, STICKY_WINDOW_MS } from "../writer"`
- `src/rooms/native-agent/native-dispatch.ts:2` — `import { noteCheckoutGuest } from "../writer/server/checkout-guests"`
- `src/rooms/native-agent/ui/team-details.tsx:3` — `import { WRITER_FALLBACK_DEFAULTS, WRITER_FALLBACK_SLOTS, writerFallbackKeys, writerFallbackSeed, writerFallbackSlots, type WriterFallbackSlot } from "../../writer/writer-fallbacks"`
- `src/rooms/native-agent/ui/team-model.ts:4` — `import { WRITER_FALLBACK_SLOTS, writerFallbackKeys } from "../../writer/writer-fallbacks"`

**`native-agent → native-install`**
- `src/rooms/native-agent/native-lane-reconcile.ts:6` — `import { NATIVE_OPENCODE_SOURCES, atomicText } from "../native-install"`
- `src/rooms/native-agent/native-session-hooks.ts:5` — `import { NATIVE_HOOK_SOURCES, SESSION_HOOK_SOURCE } from "../native-install"`

**`native-agent → core`**
- `src/rooms/native-agent/server/activation.ts:14` — `import { fullAccessSpawn, pmHasGuard, pmPrompt } from "../../core/server"`
- `src/rooms/native-agent/server/activation.ts:18` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/native-agent/server/helper-probe.ts:4` — `import { fullAccessSpawn } from "../../core/server"`
- `src/rooms/native-agent/server/profile-check.ts:4` — `import { scheduleIsolated } from "../../core/server"`

**`native-agent → schedule`**
- `src/rooms/native-agent/server/agent-registry.ts:11` — `import { createScheduleStore, taskOf } from "../../schedule"`

**`native-agent → ui-shell`**
- `src/rooms/native-agent/ui/helper-threads.tsx:3` — `import { useLpRealtime, useLpRpcQuery, useOpenThreadPanel } from "../../ui-shell/ui"`
- `src/rooms/native-agent/ui/team-details.tsx:12` — `import { asBoolean, COUNCIL_SEATS } from "../../ui-shell/ui"`
- `src/rooms/native-agent/ui/team-details.tsx:13` — `import type { LpPage } from "../../ui-shell/ui"` (type-only)

**`native-agent → qa`**
- `src/rooms/native-agent/ui/team-details.tsx:4` — `import { QA_HOST_KEY, QA_WORKSPACE_KEY } from "../../qa/qa-host"`

**`native-agent → settings`**
- `src/rooms/native-agent/ui/team-details.tsx:10` — `import { AdvancedRows } from "../../settings/ui"`
- `src/rooms/native-agent/ui/team-details.tsx:11` — `import { CatalogField } from "../../settings/ui"`
- `src/rooms/native-agent/ui/team-model.ts:2` — `import type { SelectionId } from "../../settings/ui/picker-selections"` (type-only)

**`native-install → settings`**
- `src/rooms/native-install/stack-ops.ts:6` — `import { readImportConfig } from "../settings"`

**`night → core`**
- `src/rooms/night/server/night.ts:5` — `import { GIT_PLUGIN_ID, gitCallRpc } from "../../core/server"`

**`owner-waiting → improvement`**
- `src/rooms/owner-waiting/push.ts:2` — `import { hubFields, writeHubFields } from "../improvement"`

**`owner-waiting → ui-shell`**
- `src/rooms/owner-waiting/ui/owner-waiting-board.tsx:2` — `import { useLpRpcQuery } from "../../ui-shell/ui"`

**`phase → workflow`**
- `src/rooms/phase/server/auto-stages.ts:1` — `import { builtinWorkflow } from "../../workflow"`
- `src/rooms/phase/server/driver-wiring.ts:1` — `import { builtinWorkflow, issueQuickWorkflowId } from "../../workflow"`
- `src/rooms/phase/server/driver-wiring.ts:2` — `import { architectStarter, createWorkflowLibrary } from "../../workflow/server"`

**`phase → core`**
- `src/rooms/phase/server/auto-stages.ts:2` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/phase/server/driver-tools.ts:2` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/phase/server/driver.ts:1` — `import { scheduleIsolated, type Services } from "../../core/server"`
- `src/rooms/phase/server/tool.ts:2` — `import { registerObservedTool, type Services } from "../../core/server"`

**`phase → writer`**
- `src/rooms/phase/server/driver-steps.ts:7` — `import { recheckPlanFact } from "../../writer/server"`

**`pm-replay → core`**
- `src/rooms/pm-replay/service.ts:7` — `import { registeredTools, scheduleIsolated, type Services } from "../core/server"`
- `src/rooms/pm-replay/surface.ts:4` — `import { flatParameters, unionMembers, withSignatures } from "../core/server"`

**`project-life → core`**
- `src/rooms/project-life/server/project-life.ts:7` — `import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stageHelperSettings } from "../../core/server"`
- `src/rooms/project-life/server/project-life.ts:9` — `import { fullAccessSpawn, graphStepMetadata } from "../../core/server"`
- `src/rooms/project-life/server/project-life.ts:15` — `import type { Services } from "../../core/server"` (type-only)

**`qa → core`**
- `src/rooms/qa/server/browser-graphs.ts:7` — `import { fenceOutside } from "../../core/server"`
- `src/rooms/qa/server/browser-graphs.ts:9` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/qa/server/children.ts:7` — `import { clearSpawnMarker, findThreadsByMetadata } from "../../core/server"`
- `src/rooms/qa/server/errand-graph.ts:9` — `import { fenceOutside, findThreadsByMetadata, keyedSpawnSupported, registerObservedTool, spawnTextId } from "../../core/server"`
- `src/rooms/qa/server/errand-graph.ts:10` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/qa/server/errands.ts:5` — `import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../core/server"`
- `src/rooms/qa/server/errands.ts:7` — `import { fullAccessSpawn, folderEnvironment, hiddenPlacement, projectFolder, projectSources } from "../../core/server"`
- `src/rooms/qa/server/errands.ts:12` — `import { spawnTextId } from "../../core/server"`
- `src/rooms/qa/server/errands.ts:16` — `import { fenceOutside, registerObservedTool } from "../../core/server"`
- `src/rooms/qa/server/errands.ts:23` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/qa/server/qa-thread.ts:3` — `import { fullAccessSpawn } from "../../core/server"`
- `src/rooms/qa/server/qa-thread.ts:4` — `import { spawnTextId } from "../../core/server"`
- `src/rooms/qa/server/qa.ts:7` — `import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../core/server"`

**`relay → native-agent`**
- `src/rooms/relay/server/handoff.ts:24` — `import bundledAgents from "../../native-agent/bundled-agents.json"`
- `src/rooms/relay/server/handoff.ts:25` — `import { BB_AGENT_SUMMARIES } from "../../native-agent/native-agent-overlay"`

**`relay → core`**
- `src/rooms/relay/server/handoff.ts:26` — `import { requirePmRun, type ServerContext } from "../../core/server"`
- `src/rooms/relay/server/handoff.ts:27` — `import { registerObservedTool } from "../../core/server"`
- `src/rooms/relay/server/handoff.ts:28` — `import { scheduleIsolated } from "../../core/server"`
- `src/rooms/relay/server/relay.ts:8` — `import type { ServerContext } from "../../core/server"` (type-only)
- `src/rooms/relay/server/relay.ts:10` — `import { registerObservedTool } from "../../core/server"`

**`rollback → core`**
- `src/rooms/rollback/server/rollback.ts:8` — `import type { Services } from "../../core/server"` (type-only)

**`rule-forms → core`**
- `src/rooms/rule-forms/promotion-service.ts:4` — `import { scheduleIsolated } from "../core/server"`
- `src/rooms/rule-forms/promotion-service.ts:5` — `import type { Services } from "../core/server"` (type-only)

**`run-goal → core`**
- `src/rooms/run-goal/server/run-goal.ts:2` — `import { scheduleIsolated, type Services } from "../../core/server"`

**`runs → docs`**
- `src/rooms/runs/server/child-snapshots.ts:1` — `import type { DocsPage } from "../../docs"` (type-only)

**`runs → memory`**
- `src/rooms/runs/server/child-snapshots.ts:2` — `import type { MemorySettings } from "../../memory"` (type-only)

**`runs → project-life`**
- `src/rooms/runs/server/child-snapshots.ts:3` — `import type { ProjectLifeTaskSummary } from "../../project-life"` (type-only)

**`runs → stability`**
- `src/rooms/runs/server/rpc/runs.ts:4` — `import { PARKED_KEY } from "../../../stability/server"`

**`runs → native-agent`**
- `src/rooms/runs/server/rpc/runs.ts:5` — `import { agentPickerLabel, employeeView, pickableAgent, placeEmployeeOn } from "../../../native-agent"`
- `src/rooms/runs/server/rpc/runs.ts:6` — `import { compileEffectiveMainAgent, detectCompiledMainAgentCapability } from "../../../native-agent"`
- `src/rooms/runs/server/rpc/runs.ts:8` — `import { detectRequiredSessionPolicyCapability } from "../../../native-agent"`
- `src/rooms/runs/server/rpc/runs.ts:9` — `import { storeNativeSelection } from "../../../native-agent/server/native-profile"`
- `src/rooms/runs/server/rpc/runs.ts:10` — `import { DEFAULT_NATIVE_AGENT, nativeAgentCliId, nativeSelectionSchema } from "../../../native-agent"`
- `src/rooms/runs/server/rpc/runs.ts:11` — `import { userVisibleProjects } from "../../../native-agent"`
- `src/rooms/runs/server/rpc/runs.ts:12` — `import { pendingSwitch } from "../../../native-agent"`
- `src/rooms/runs/server/run-routing.ts:2` — `import type { ExtraAccess } from "../../native-agent"` (type-only)
- `src/rooms/runs/server/run-routing.ts:3` — `import { decideHelperDispatch, detectVkCapability, parseHelperContextSettings, parseRequiredSessionPolicyCapability, requiredSessionPolicySpawnBinding } from "../../native-agent/helper-context"`
- `src/rooms/runs/server/run-routing.ts:4` — `import type { HelperPolicySnapshot, HelperRole } from "../../native-agent"` (type-only)
- `src/rooms/runs/server/run-routing.ts:5` — `import { helperSpawnFields, resolveHelperPlacement } from "../../native-agent/helper-placement"`
- `src/rooms/runs/ui/run-card.tsx:5` — `import { HELPER_PANEL_ACTION } from "../../native-agent/ui"`

**`runs → usage`**
- `src/rooms/runs/server/rpc/runs.ts:20` — `import { queueWaitPercentiles, runQueueWaits } from "../../../usage/server/attempt-metrics"`

**`runs → core`**
- `src/rooms/runs/server/rpc/runs.ts:22` — `import { folderEnvironment, projectSources } from "../../../core/server"`
- `src/rooms/runs/server/rpc/runs.ts:27` — `import type { Services } from "../../../core/server"` (type-only)
- `src/rooms/runs/server/run-routing.ts:10` — `import { findThreadsByMetadata } from "../../core/server"`
- `src/rooms/runs/server/task-reconcile.ts:4` — `import type { Services } from "../../core/server"` (type-only)

**`runs → writer`**
- `src/rooms/runs/server/run-finish.ts:4` — `import { STICKY_WINDOW_MS } from "../../writer/server/sticky"`

**`runs → tasks`**
- `src/rooms/runs/server/stage-records.ts:4` — `import { sha256, stageTransition, validateStageReceipt } from "../../tasks"`
- `src/rooms/runs/server/stage-records.ts:5` — `import type { StageId, StageState } from "../../tasks"` (type-only)

**`runs → verification`**
- `src/rooms/runs/server/task-reconcile.ts:1` — `import { createMergeIntentRecovery } from "../../verification/server"`

**`runs → work-graph`**
- `src/rooms/runs/server/thread-live.ts:2` — `import { workGraphStrips } from "../../work-graph/server"`
- `src/rooms/runs/ui/task-board.tsx:8` — `import { StageModelStats, StageStrip, WorkBreakdown, useStageStrips } from "../../work-graph/ui"`
- `src/rooms/runs/ui/thread-live.tsx:5` — `import { StageSteps, StageStrip, type Strip } from "../../work-graph/ui"`

**`runs → ui-shell`**
- `src/rooms/runs/ui/run-card.tsx:6` — `import { useOpenThreadPanel } from "../../ui-shell/ui"`
- `src/rooms/runs/ui/run-parts.tsx:8` — `import { StageSummary, runTone, stageTitle } from "../../ui-shell/ui"`
- `src/rooms/runs/ui/runs-service.tsx:22` — `import { CARD_BODY, CARD_HEAD, COEXISTENCE_MANAGER_KEYS, COEXISTENCE_VALUE_KEYS, compatibilityAliasRows, reasonKey, sectionKey } from "../../ui-shell/ui"`
- `src/rooms/runs/ui/runs-service.tsx:24` — `import type { LpPage } from "../../ui-shell/ui"` (type-only)
- `src/rooms/runs/ui/task-board.tsx:9` — `import { useLpRpcQuery } from "../../ui-shell/ui"`
- `src/rooms/runs/ui/thread-live.tsx:7` — `import { useLpRpcQuery } from "../../ui-shell/ui"`

**`runs → settings`**
- `src/rooms/runs/ui/runs-service.tsx:3` — `import { settingLabel } from "../../settings/setting-copy"`
- `src/rooms/runs/ui/runs-service.tsx:23` — `import { FieldControl, StatusBadge, StatusRow } from "../../settings/ui"`

**`runs → acceptance`**
- `src/rooms/runs/ui/task-board.tsx:7` — `import { AcceptanceCard } from "../../acceptance/ui"`

**`schedule → core`**
- `src/rooms/schedule/server/rpc/schedules.ts:5` — `import type { Services } from "../../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-agent-actions.ts:10` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-cli.ts:1` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-executors.ts:11` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-place.ts:5` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-service.ts:20` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-tools.ts:7` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/schedule/server/schedule-tools.ts:8` — `import { registerObservedTool } from "../../core/server"`

**`schedule → qa`**
- `src/rooms/schedule/server/schedule-service.ts:2` — `import { QA_HOST_KEY, mapListedQaHosts } from "../../qa"`

**`schedule → ui-shell`**
- `src/rooms/schedule/ui/schedule-board.tsx:9` — `import { useLpPoll, useLpRealtime } from "../../ui-shell/ui"`
- `src/rooms/schedule/ui/schedule-detail.tsx:9` — `import { Pill } from "../../ui-shell/ui"`
- `src/rooms/schedule/ui/schedule-history.tsx:8` — `import { useOpenThreadPanel } from "../../ui-shell/ui"`
- `src/rooms/schedule/ui/schedule-who.tsx:10` — `import { Pill } from "../../ui-shell/ui"`

**`secrets → verification`**
- `src/rooms/secrets/server/secrets.ts:4` — `import { SANDBOX_OWN_ENV } from "../../verification"`

**`self-repair → ui-shell`**
- `src/rooms/self-repair/ui/rule-proposals.tsx:9` — `import { useLpPoll, useLpRealtime } from "../../ui-shell/ui"`

**`stability → core`**
- `src/rooms/stability/server/canary.ts:7` — `import { scheduleIsolated } from "../../core/server"`
- `src/rooms/stability/server/health.ts:2` — `import { requirePmRun, type ServerContext } from "../../core/server"`
- `src/rooms/stability/server/health.ts:3` — `import { registerObservedTool } from "../../core/server"`
- `src/rooms/stability/server/health.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/stability/server/health.ts:5` — `import { bindRunChildBudget } from "../../core/server"`
- `src/rooms/stability/server/probes.ts:2` — `import { fullAccessSpawn } from "../../core/server"`
- `src/rooms/stability/server/probes.ts:6` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/stability/server/reconcile.ts:10` — `import { holderSpawnKey } from "../../core/server"`
- `src/rooms/stability/server/reconcile.ts:12` — `import { findThreadsByMetadata } from "../../core/server"`
- `src/rooms/stability/server/reconcile.ts:15` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/stability/server/service-projects.ts:2` — `import { scheduleIsolated } from "../../core/server"`
- `src/rooms/stability/server/stability.ts:10` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/stability/server/worktree-janitor.ts:3` — `import { scheduleIsolated } from "../../core/server"`

**`stability → qa`**
- `src/rooms/stability/server/worktree-janitor.ts:2` — `import { mapListedQaHosts } from "../../qa"`

**`stability → writer`**
- `src/rooms/stability/server/worktree-janitor.ts:8` — `import { STICKY_WINDOW_MS } from "../../writer"`

**`stage-return → writer`**
- `src/rooms/stage-return/server/stage-return.ts:6` — `import { createAttemptReopen, createWriterReassign } from "../../writer/server"`

**`stage-return → core`**
- `src/rooms/stage-return/server/stage-return.ts:8` — `import type { Services } from "../../core/server"` (type-only)

**`tasks → baseline`**
- `src/rooms/tasks/gate-vocabulary.ts:1` — `import { EXISTENCE_ONLY_WORDS } from "../baseline"`
- `src/rooms/tasks/server/contract-lint.ts:6` — `import { NO_RED_KINDS } from "../../baseline"`

**`tasks → native-install`**
- `src/rooms/tasks/read-first.ts:1` — `import { parseExecutionLineWindows, type PathWindows } from "../native-install"`

**`tasks → verification`**
- `src/rooms/tasks/server/contract-lint.ts:13` — `import { SANDBOX_OWN_ENV } from "../../verification"`
- `src/rooms/tasks/server/contract-lint.ts:14` — `import { gluedCheckCommand } from "../../verification/server"`
- `src/rooms/tasks/server/contract-lint.ts:16` — `import { safeRelative, validateOwnershipContract } from "../../verification"`
- `src/rooms/tasks/server/lint-task.ts:12` — `import { gateResolverFor } from "../../verification/server"`
- `src/rooms/tasks/server/lint-task.ts:13` — `import { parseIntegrationGateSettings } from "../../verification/server"`
- `src/rooms/tasks/validate-output.ts:5` — `import type { FlakyEvidence } from "../verification"` (type-only)
- `src/rooms/tasks/validate-output.ts:6` — `import { dropSatellites } from "../verification/ownership"`

**`tasks → core`**
- `src/rooms/tasks/server/conversation-tools.ts:2` — `import { callerPluginMetadata, registerObservedTool } from "../../core/server"`
- `src/rooms/tasks/server/lint-task.ts:16` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/tasks/server/queue-tool.ts:2` — `import { callerPluginMetadata, registerObservedTool } from "../../core/server"`

**`tasks → lead`**
- `src/rooms/tasks/server/queue-tool.ts:6` — `import { answerTaskWord } from "../../lead"`

**`ui-shell → settings`**
- `src/rooms/ui-shell/ui/page-model.ts:3` — `import { settingUnitKey } from "../../settings/setting-copy"`
- `src/rooms/ui-shell/ui/page.tsx:8` — `import { OwnedSettings } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/page.tsx:10` — `import { InheritanceContext } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-automation.tsx:2` — `import { CatalogField } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-automation.tsx:7` — `import { SettingsGroup } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-knowledge.tsx:8` — `import { CatalogField, CatalogFields } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-knowledge.tsx:9` — `import { AdvancedRows, SettingsGroup } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-overview.tsx:5` — `import { LocaleControls, OverviewLoading, StatusRow } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-team.tsx:9` — `import { AccessModePanel, isChanged, ModelOverridesPanel, ORIGIN_LABEL, PmAccessNote, RoleAccessBody, RoleModelsPanel, roleSummary, useAccessView, type AccessApi, type RoleView } from "../../settin…`
- `src/rooms/ui-shell/ui/tab-team.tsx:13` — `import { SettingField } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-work.tsx:7` — `import { CatalogField, CatalogFields } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/tab-work.tsx:8` — `import { AdvancedRows, JevProviderNote, JevProviderPanel, SettingsGroup } from "../../settings/ui"`
- `src/rooms/ui-shell/ui/use-lp-page.tsx:3` — `import { selectionKeys, selectionValue, SELECTION_SPECS, type SelectionId } from "../../settings/ui"`

**`usage → core`**
- `src/rooms/usage/server/token-usage.ts:7` — `import { scheduleIsolated } from "../../core/server"`

**`verification → core`**
- `src/rooms/verification/server/integration-gate.ts:7` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/verification/server/merge-intent.ts:4` — `import type { Services } from "../../core/server"` (type-only)

**`verification → lead`**
- `src/rooms/verification/server/integration-gate.ts:13` — `import { addRoad, getRoad, listRoad } from "../../lead"`

**`workflow → core`**
- `src/rooms/workflow/server/after-accept.ts:8` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/architect-start.ts:11` — `import { fullAccessSpawn, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../core/server"`
- `src/rooms/workflow/server/architect-start.ts:13` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/graph-helper.ts:3` — `import { findThreadsByMetadata, graphStepMetadata, keyedSpawnSupported } from "../../core/server"`
- `src/rooms/workflow/server/rpc/workflow-export.ts:4` — `import type { Services } from "../../../core/server"` (type-only)
- `src/rooms/workflow/server/rpc/workflow-ops.ts:4` — `import type { Services } from "../../../core/server"` (type-only)
- `src/rooms/workflow/server/rpc/workflows.ts:4` — `import type { Services } from "../../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-agent.ts:25` — `import { folderEnvironment, fullAccessSpawn, hiddenPlacement, projectFolder, projectSources } from "../../core/server"`
- `src/rooms/workflow/server/workflow-agent.ts:29` — `import { findThreadsByMetadata, keyedSpawnSupported } from "../../core/server"`
- `src/rooms/workflow/server/workflow-agent.ts:30` — `import { modelCatalogOf, noteProviderLimit, noteProviderStartFailure, noteProviderStartSuccess, pmHostOf, providerBlockedForFolder, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpa…`
- `src/rooms/workflow/server/workflow-answer.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-architect.ts:24` — `import { modelCatalogOf } from "../../core/server"`
- `src/rooms/workflow/server/workflow-architect.ts:25` — `import { registerObservedTool } from "../../core/server"`
- `src/rooms/workflow/server/workflow-architect.ts:30` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-executors.ts:22` — `import { keyedSpawnSupported, projectFolder } from "../../core/server"`
- `src/rooms/workflow/server/workflow-executors.ts:26` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-goal-audit.ts:8` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-library.ts:13` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-models.ts:6` — `import { CATALOG_WAIT_MS, createModelCatalog, modelCatalogOf, pmHostOf, spawnUsageOf, within, type ModelCatalogReader } from "../../core/server"`
- `src/rooms/workflow/server/workflow-ops.ts:8` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-runtime.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-tools.ts:15` — `import { bindGraphStepLookup, fenceOutside, registerObservedTool } from "../../core/server"`
- `src/rooms/workflow/server/workflow-tools.ts:18` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-triggers-live.ts:2` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow-triggers.ts:14` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/workflow/server/workflow.ts:24` — `import type { Services } from "../../core/server"` (type-only)

**`workflow → self-repair`**
- `src/rooms/workflow/server/architect-start.ts:12` — `import { lanePilotProjectOrNotice } from "../../self-repair/server"`

**`workflow → writer`**
- `src/rooms/workflow/server/graph-helper.ts:6` — `import { outputText } from "../../writer/server"`
- `src/rooms/workflow/server/workflow-agent.ts:6` — `import { providerLimitNotice } from "../../writer/server"`
- `src/rooms/workflow/server/workflow-agent.ts:35` — `import { outputText } from "../../writer/server"`
- `src/rooms/workflow/server/workflow-executors.ts:20` — `import { lpTaskPipelineExecutor, taskUsage } from "../../writer/server"`
- `src/rooms/workflow/server/workflow-executors.ts:21` — `import type { DispatchRuntime } from "../../writer/server"` (type-only)
- `src/rooms/workflow/server/workflow-executors.ts:338` — `import("../../writer/server")`
- `src/rooms/workflow/server/workflow-step-executors.ts:4` — `import { resolveStageWriterSelection } from "../../writer"`
- `src/rooms/workflow/server/workflow-step-executors.ts:5` — `import { writerFallbackChain, writerFallbacks } from "../../writer"`
- `src/rooms/workflow/server/workflow.ts:17` — `import { registerDispatchExecutors } from "../../writer/server"`

**`workflow → lead`**
- `src/rooms/workflow/server/pm-notice.ts:7` — `import { doneRoad, reopenRoad } from "../../lead"`
- `src/rooms/workflow/server/workflow-agent.ts:10` — `import { LEAD_ID } from "../../lead"`

**`workflow → qa`**
- `src/rooms/workflow/server/workflow-architect.ts:5` — `import { QA_HOST_KEY, mapListedQaHosts } from "../../qa"`

**`workflow → errands`**
- `src/rooms/workflow/server/workflow.ts:16` — `import { ERRAND_EPISODE_TRACE_EVENTS, recordErrandEpisode } from "../../errands"`

**`workflow → ui-shell`**
- `src/rooms/workflow/ui/workflow-detail.tsx:11` — `import { useLpPoll, useLpRealtime, useOpenThreadPanel } from "../../ui-shell/ui"`
- `src/rooms/workflow/ui/workflow-draft-detail.tsx:10` — `import { useLpPoll, useLpRealtime, useOpenThreadPanel } from "../../ui-shell/ui"`
- `src/rooms/workflow/ui/workflow-draft.ts:5` — `import { useLpPoll } from "../../ui-shell/ui"`
- `src/rooms/workflow/ui/workflow-draft.ts:6` — `import { useLpRealtime } from "../../ui-shell/ui/use-lp-realtime"`
- `src/rooms/workflow/ui/workflows.tsx:12` — `import { useLpPoll, useLpRealtime } from "../../ui-shell/ui"`

**`writer → settings`**
- `src/rooms/writer/argv-builder.ts:8` — `import { validateSettingsObject, validationErrorText } from "../settings"`

**`writer → core`**
- `src/rooms/writer/server/answer.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/attempt-reactions.ts:5` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/attempt-usage.ts:3` — `import { findThreadsByMetadata } from "../../core/server"`
- `src/rooms/writer/server/dispatch-guards.ts:8` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/dispatch-workflow.ts:14` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/dispatch.ts:31` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/finish.ts:17` — `import { fullAccessSpawn } from "../../core/server"`
- `src/rooms/writer/server/finish.ts:30` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/pipeline-tag.ts:2` — `import { graphStepMetadata } from "../../core/server"`
- `src/rooms/writer/server/question-timeout.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/reopen-attempt.ts:9` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/revive.ts:2` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/rule-forms.ts:1` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/second-pilot.ts:4` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/second-pilot.ts:6` — `import { fullAccessSpawn, sendPmNotice, stageHelperSettings } from "../../core/server"`
- `src/rooms/writer/server/spawn.ts:25` — `import { fullAccessSpawn } from "../../core/server"`
- `src/rooms/writer/server/spawn.ts:27` — `import { holderSpawnKey } from "../../core/server"`
- `src/rooms/writer/server/spawn.ts:36` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/stability.ts:1` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/start.ts:57` — `import { findThreadsByMetadata } from "../../core/server"`
- `src/rooms/writer/server/start.ts:59` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/state.ts:7` — `import { CATALOG_WAIT_MS, modelCatalogOf, noteProviderLimit, registerSpawnUsage, SEEN_LIMIT_HOLD_MS, threadModelOf, within, zcodeBusy, zcodeBusyPeek } from "../../core/server"`
- `src/rooms/writer/server/sticky.ts:10` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/update-task.ts:22` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/verification.ts:11` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/verify.ts:29` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/workflow.ts:1` — `import type { Services } from "../../core/server"` (type-only)
- `src/rooms/writer/server/writer-host.ts:8` — `import { CATALOG_WAIT_MS, modelCatalogOf, within } from "../../core/server"`
- `src/rooms/writer/server/writer-wake.ts:6` — `import type { Services } from "../../core/server"` (type-only)

**`writer → lead`**
- `src/rooms/writer/server/finish.ts:42` — `import { askTaskWord, taskWordItemPrefix } from "../../lead"`

**`writer → qa`**
- `src/rooms/writer/server/writer-host.ts:7` — `import { mapListedQaHosts } from "../../qa"`


</details>

<details>
<summary>Acyclic layers after FAS removal (27)</summary>

0. `settings` · `tools`
1. `coverage` · `forge` · `memory-eval` · `receipts`
2. `@migrations.ts`
3. `outage` · `wall`
4. `night-graphs`
5. `core`
6. `acceptance` · `backlog` · `checkers` · `cockpit` · `front` · `memory-probe` · `money` · `native-install` · `outbound` · `pm-replay` · `work-graph`
7. `capability` · `council` · `qa`
8. `ui-shell`
9. `harness` · `self-repair`
10. `docs` · `improvement`
11. `bench` · `jev`
12. `lead`
13. `errands`
14. `schedule` · `writer`
15. `baseline` · `hypotheses` · `memory` · `night` · `owner-presence` · `stage-return` · `workflow`
16. `rollback` · `stability`
17. `native-agent`
18. `learning` · `phase`
19. `relay` · `rule-forms` · `run-goal`
20. `deferral` · `forecast` · `policy` · `verification`
21. `anamnesis` · `owner-waiting` · `project-life` · `usage`
22. `tasks`
23. `secrets`
24. `critique`
25. `runs`
26. `contracts`

</details>

## 2. Redesign groups — what removes several edges at once

Simulation = delete the group's edge set from the real graph, recompute
(Tarjan, same as `room-graph.mjs`). Cumulative, applied top to bottom.
"Edges" = room edges still present.

| step | what changes | largest SCC | mutual pairs | edges |
|---|---|---|---|---|
| baseline | — | 64 | 94 | 684 |
| **G1 platform surface out of `core`** | `Services`, `scheduleIsolated`, spawn/model-catalog, `registerObservedTool`, `findThreadsByMetadata`/`graphStepMetadata`, git RPC, `folderEnvironment`/`projectFolder`, `fenceOutside` move to a bottom `kit`/`platform` room (same move as the F2 merge); `server.ts` passes instances where a room needs state. Deletes all 43 `*→core` edges; covers 36 FAS edges. `core→settings`/`core→wall`/`core→tools` stop being cyclic automatically. | 58 | 57 | 641 |
| **G2 `tools` unwired** | `core→tools` (`boundPresentation`) and `native-agent→tools` (`rewriteFoldedToolNames`) — pure presentation helpers → kit. Then nothing imports `tools` and its 50 registration out-edges are top-down. Covers 2 FAS edges. | 53 | 56 | 639 |
| **G3 `ui-shell` = pure leaf UI kit** | The tab-* pages and `page-model` that import domain UI (`settings` components, `harness`, `self-repair`, `runs`, `tasks`, `writer`, `workflow`, …, 18 out-edges) move to the owning rooms or a `pages` room; `ui-shell` keeps `Pill`, `useLp*`, `LpPage`. Covers the `ui-shell→settings` FAS edge and makes the 8 `*→ui-shell` FAS edges unnecessary — they become legal leaf imports. | 52 | 47 | 621 |
| **G4 `contracts` = pure leaf** | `contracts/host.ts` → `anamnesisHostMethods`, `contracts/rpc-shell.ts` → `scheduleRpcContract`: contract assembly moves to `server.ts` or the domains register slices. Covers 2 FAS edges; contracts becomes fan-in 58 / out 0. | 49 | 45 | 619 |
| **G5 engine surfaces via ports** | `*→writer` (25 edges): constants `STICKY_WINDOW_MS`, `LIVE_FOLDER_FILE_CAP`, `WRITER_FALLBACK_*` → contracts; `outputText`, `resolveStageWriterSelection`, `writerFallback*`, `providerLimitNotice` → a narrow writer port; attempt ops `createAttemptReopen`/`createWriterReassign`/`recheckPlanFact` → the tasks/attempt owner (F5); `workflow→writer` executor wiring (`registerDispatchExecutors`, `lpTaskPipelineExecutor`, `DispatchRuntime`, dynamic `import()`) inverts: workflow defines the registry, writer registers into it. `*→workflow` (22): `builtinWorkflow`, `ChainRuntime`/`NodeExecutor`/`StepContext` types, `issueQuickWorkflowId`, `architectStarter` → engine API in contracts/kit. Covers 12 FAS edges. | 46 | 27 | 574 |
| **G6 `settings` split** | Shared UI (`SettingField`, `SettingsGroup`, `CatalogField`, `InheritanceContext`, `OwnedSettings`, `AccessModePanel`, `ModelOverridesPanel`, `settingLabel`) joins the leaf UI kit; `validateSettingsObject`, `readImportConfig` → kit. Deletes 8 `*→settings` edges; covers 5 FAS edges (+ `ui-shell→settings` already in G3). | 45 | 24 | 567 |
| **G7a migrations passed in, not imported** | `memory-eval/server/{corpus,shelf}.ts` take `migrations` as a parameter from `plugin-db.ts` instead of importing the registry — one edge removes `@migrations.ts` (and its 22 out-edges) from every cycle. | 40 | 24 | 566 |
| **G7b shared config/constants → contracts+kit** | QA host config (`QA_HOST_KEY`, `QA_WORKSPACE_KEY`, `mapListedQaHosts`) — kills 6 FAS edges into `qa`; lead helper surface (`askTaskWord`/`answerTaskWord`/`taskWordItemPrefix`, `addRoad`/`getRoad`/`listRoad`/`doneRoad`/`reopenRoad`, `LEAD_*`) — 5 edges; self-repair insight surface (`memorySettingsFor`, `adoptRuleProposal`, `rejectRuleProposal`, `retireAdoptedRule`, `deleteMemoryRecord`, `lanePilotProjectOrNotice`) — 4 edges; improvement `hubFields`/`writeHubFields` + `WallApi` type — 3 edges; native-agent static surface (`bundled-agents.json`, `BB_AGENT_SUMMARIES`, `NATIVE_*_SOURCES`, `atomicText`, `MAIN_AGENT_ID`, `EMPLOYEES`, `recordRoleLine`) — 3 edges; leaf-ward constants (`SANDBOX_OWN_ENV`, `EXISTENCE_ONLY_WORDS`, `NO_RED_KINDS`, `parseExecutionLineWindows`, `ERRAND_EPISODE_TRACE_EVENTS`/`recordErrandEpisode`, `createScheduleStore`/`taskOf`, `loadEvalData`/`runMemoryEval`) — 6 edges. Covers 27 of the residual FAS edges. | 23 | 12 | 539 |
| **G7c residual domain-mesh** | The FAS recomputed on the post-G7b graph is 19 edges, 10 of them `runs → *`: split runs (routing vs snapshots vs stage-records vs UI) — `runs→{docs,memory,project-life}` are type-only → contracts; `runs→native-agent` (12 sites, the whole agent-selection surface) → an agent-resolution port; `runs→{tasks,stability,verification,acceptance,work-graph,usage}` → stage-record/merge-intent/metrics owner APIs; `critique→{tasks,memory,stability,qa}` (`sha256`, `taskStem`, `buildExecutionPacket`, `reviewerMemoryFor`, `reconcileCritic`, `qaSpawnClaimed`, `unownedExpectedOutputs`) → owner APIs; `tasks→verification` (ownership validators — merge into one owner or a port); `verification→{tasks,project-life}` (`STAGE_IDS`, `isMainfixTask`, `GateReport`, `isAllowedProjectLifePath`) → contracts + owner API; `baseline→rollback` (type-only) → contracts. Covers the last 15 original-FAS edges plus partner-side cuts (`baseline→rollback`, `verification→{project-life,tasks}`). | **1** | **0** | 522 |

End state after G1–G7: **fully acyclic** (largest SCC = 1 room, 0 mutual
pairs). `contracts` is the deepest sink. This is an upper-bound simulation —
it deletes whole edge directions; real merges may keep a few edges and still
land the same layering.

Per-FAS-edge group assignment: G1 36 · G5 12 · G7 42 · G6 5 · G4 2 · G2 2 ·
G3 1 · kept 10 (= 110). The 10 `kept` edges stay: `core→settings`,
`core→wall` are legal top-down composition; the 8 `*→ui-shell` edges are
legal leaf imports once G3 lands. Their `stable→volatile` flags in the table
reflect *today's* churn — after G3, `ui-shell` is intended to be a stable
leaf.

## 3. Top 10 rooms by fan-in + fan-out — hub or grab-bag?

| room | in+out | out | in | files / LOC | verdict |
|---|---|---|---|---|---|
| `core` | 97 | 54 | 43 | 27 / 2 444 | **Grab-bag.** A barrel over ~20 unrelated modules; both composition root and helper shelf. Split: `kit` leaf (helpers/types) + thin root nobody imports. |
| `contracts` | 60 | 2 | 58 | 26 / 2 606 | **Real hub** — once its 2 out-edges (anamnesis, schedule) leave, it's the intended bottom layer. |
| `storage` | 59 | 4 | 55 | — | **Real hub, done.** Already a leaf after the F2 merge; out of the SCC. |
| `writer` | 54 | 29 | 25 | 69 / 11 549 | **Grab-bag.** Largest room; start/finish/dispatch/sticky/spawn/verify in one surface. Split per F5 (attempt lifecycle, dispatch registry, narrow port). |
| `tools` | 52 | 50 | 2 | 8 / 1 536 | **Real hub** (tool aggregator) misplaced inside the cycle — only `core→tools` + `native-agent→tools` drag it in. Fix those 2 edges, stays a top. |
| `runs` | 50 | 19 | 31 | 38 / 3 648 | **Grab-bag.** Biggest residual importer (11 of 19 residual FAS edges): routing + snapshots + stage-records + RPC + board UI. Split per F5. |
| `workflow` | 45 | 23 | 22 | 71 / 10 708 | **Grab-bag.** Engine + architect + agent + library + UI in one room. Split engine core from architect/agent. |
| `native-agent` | 41 | 19 | 22 | 51 / 7 204 | **Grab-bag.** Registry + profiles + dispatch + overlay + bundled data + UI. Static surface → contracts; dispatch/activation separate. |
| `tasks` | 39 | 11 | 28 | 29 / 3 031 | **Mostly real hub** — central domain owner, 28 importers expected; but its out-edges borrow helpers (`baseline` vocabulary, `verification` validators, `lead` road API, `native-install` parsers) that belong below it. |
| `critique` | 33 | 13 | 20 | 26 / 3 967 | **Grab-bag-leaning.** `critic-stats`/`task-brief` are pure; `critique-runs` orchestrates across 6 rooms. Split orchestrator from pure stats. |

## Reproduce

```
node scripts/room-graph.mjs                 # summary
node scripts/room-graph.mjs --json          # full edge map
# analysis scripts: .bb/chats/thr_3rx8u95vyd/tmp/{fas,groups,residual,final}.mjs
git log --since=60.days --name-only --pretty=format: -- src/rooms   # churn
```
