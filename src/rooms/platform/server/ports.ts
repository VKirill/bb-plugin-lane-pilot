import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { WorkflowEngine, WorkflowStore } from "@lane-pilot/workflow-engine";
import type { createWorkflowCatalog } from "@lane-pilot/workflow-engine";
import type { RunBudget, createProviderBreaker } from "@lane-pilot/resilience";
import type { CliBinary } from "@lane-pilot/settings-catalog";
import type { PrototypeConfig, TaskV2, BirthKind, CodeCriticDefault } from "../../contracts";
import type { DirtSnapshot } from "../../dirt-snapshot";
import type { LanePilotDatabase, getAttempt, getRun } from "../../storage";
import type { ServerCore } from "../../contracts/server";

/**
 * The cross-room service surfaces, declared here so a consumer types what it uses without importing the owner room.
 * server.ts assigns the real factories' results into the bag; a field that drifts from its port fails there, not here.
 */

/** workflow/server/workflow.ts — the one engine of the plugin instance. */
export interface WorkflowEngineApi {
  workflowEngine: WorkflowEngine;
  workflowCatalog: ReturnType<typeof createWorkflowCatalog>;
  startAfterAcceptance(projectId: string, runId: string, taskId: string, pmThreadId: string): void;
}

/** workflow/server/workflow-library.ts — the graphs a project has, over the built-in and global stores. */
export interface WorkflowLibraryApi {
  loadStore(projectId?: string): Promise<{ store: WorkflowStore }>;
  issueQuickWorkflowId(settings: Record<string, unknown> | null | undefined): "issue-quick" | "issue-quick-legacy";
  issueQuickModelCalls(settings: Record<string, unknown> | null | undefined): number;
  issueQuickShortPath(settings: Record<string, unknown> | null | undefined): boolean;
}

/** workflow/server/architect-start.ts — starts the workflow architect for an owner's request. */
export interface ArchitectApi {
  startOrder(input: { projectId: string; text: string; pmThreadId: string }): Promise<{ threadId: string }>;
}

/** writer/server/dispatch.ts */
export type DispatchWriter = (args: {
  threadId: string; projectId: string; task?: TaskV2; plan?: string; baseRef?: string; objective?: string;
  requireObjective?: boolean; criticCodeDefault?: CodeCriticDefault; birth?: BirthKind;
}) => Promise<Record<string, unknown>>;

export type ReadWriterWorkspaceFile = (args: {
  threadId: string; projectId: string; path: string; offset: number; maxLines: number;
}) => Promise<Record<string, unknown>>;

export type WaitWriter = (args: { threadId: string; projectId: string; runId: string; timeoutSec: number }) => Promise<Record<string, unknown>>;

export type ResumeDispatch = (attemptId: string) => Promise<{ resumed: true; live?: true } | { resumed: false; why: string }>;

/** writer/server/live-folder.ts */
export type IsLiveFolder = (runId: string | undefined, hostId: string, folder: string) => Promise<boolean>;

/** writer/server/state.ts — the shared writer state. */
export interface WriterStateApi {
  activeWriterTasks: Set<string>;
  providerBreaker: ReturnType<typeof createProviderBreaker>;
  /** The keyed writer pool (tasks/run-policy.ts RunWriterPool): one semaphore per run, mirrored structurally. */
  runWriterPool: { acquire(runId: string, limit: number, rank?: number): Promise<() => void> };
  runBudgets: Map<string, RunBudget>;
  runBudgetFor(runId: string, settings: Record<string, unknown>): RunBudget;
}

/** writer/server/start.ts */
export type StartWriterTask = (input: {
  projectId: string; runId: string; taskId: string; firstAttemptId: string; pmThreadId: string;
  config: PrototypeConfig; task: TaskV2; plan: string; writerThreadId?: string; dirtBefore?: DirtSnapshot[]; pmReadContext?: string;
  turnSent?: boolean;
}) => void;

/** writer/server/plan-fact.ts, bound to ctx at the composition root. */
export type RecheckPlanFact = (input: { projectId: string; runId: string; taskId: string; hostId: string }) => Promise<"passed" | "failed" | "skipped" | null>;

/** writer/server/attempt-usage.ts — what a task's threads spent. */
export type TaskUsage = (bb: BbPluginApi, db: LanePilotDatabase, runId: string, taskId: string) => Promise<{ usage?: { tokens: number; costUsd: number; unknown?: true } }>;

type Attempt = NonNullable<ReturnType<typeof getAttempt>>;
type Run = NonNullable<ReturnType<typeof getRun>>;

/** writer/server/reopen-attempt.ts — a blocked attempt reopened in its writer thread. */
export interface AttemptReopenApi {
  checkReopenable(input: {
    runId: string; taskId: string; run: Run; attempt: Attempt;
  }): Promise<{ ok: true; threadId: string; workspacePath: string } | { ok: false; hint: string }>;
  reopenAttempt(input: {
    projectId: string; runId: string; taskId: string; pmThreadId: string;
    attempt: Attempt; threadId: string; workspacePath: string;
    config: PrototypeConfig; contract: TaskV2;
    reason: string; turn: string; qaAnswer: string;
  }): Promise<{ ok: true } | { ok: false; hint: string }>;
}

export type ReassignInput = {
  projectId: string; runId: string; taskId: string;
  providerId?: string; model?: string; reasoningEffort?: string; reason?: string;
};
export type ReassignRequested = { ok: true; taskId: string; runId: string; oldThreadId: string; oldAttemptNo: number; providerId: string; model: string };
export type ReassignRefusal = { ok: false; error: "not_reassignable"; taskId: string; state: string; reason: string };
export type ReassignResult =
  | { ok: true; taskId: string; oldThreadId: string; newThreadId: string | null; providerId: string; model: string }
  | ReassignRefusal;

/** writer/server/reassign.ts — the PM reassigns a task to another model. */
export interface WriterReassignApi {
  requestReassign(input: ReassignInput): Promise<ReassignRequested | ReassignRefusal>;
  reassignTask(input: ReassignInput): Promise<ReassignResult>;
  awaitReassignedThread(runId: string, taskId: string, oldAttemptNo: number): Promise<string | null>;
}

/** native-agent/custom-agent.ts `AgentListItem`, mirrored so the listing RPC types it without the room (checked both ways at wiring). */
export type AgentKind = "coordinator" | "specialist" | "internal";
export type ListedAgentProfile = {
  id: string;
  description: string;
  displayName: string;
  summary?: string;
  kind: AgentKind;
  custom: boolean;
  prompt: string;
  sourceHash: string;
  sourceVersion: string;
  edited: boolean;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  effort?: string;
  domain?: string;
  machineAffinity?: string;
  coreSkills?: string[];
  skillSections?: string[];
  deliverables?: string[];
  validator?: string;
};

/** writer/server/writer-host.ts — the binding verdict of a project, mirrored (native-agent/project-binding.ts plus writer-host's own `catalog_unavailable`). */
export type WriterHostResolution =
  | { status: "resolved"; hostId: string; path: string; source: "session" | "unique_source" | "explicit_override"; bindingId?: string }
  | { status: "ambiguous"; bindings: Array<{ id?: string; hostId: string; path: string; isDefault?: boolean; projectId?: string }> }
  | { status: "setup_required" }
  | { status: "offline"; hostId: string; path: string }
  | { status: "catalog_unavailable"; reason: string };

type ProvidersList = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>;
type ProviderModels = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>;

/** writer/server/writer-host.ts — the host pickers and the agent listing the runs RPC answers with. */
export interface WriterHostApi {
  resolveProjectWriterHost(args: {
    projectId: string; threadId?: string | null; selected?: { hostId: string; path: string } | null;
  }): Promise<WriterHostResolution>;
  selectionCatalogHost(projectId: string, threadId?: string | null, selected?: { hostId: string; path: string } | null): Promise<
    | { ok: true; hostId: string }
    | { ok: false; validation: { code: "setup_required" | "writer_binding_ambiguous" | "writer_host_offline" | "catalog_unavailable"; key: string; params: string[] } }
  >;
  selectionCatalog(projectId: string, hostId: string, providerId: string): Promise<[ProvidersList, ProviderModels]>;
  listedAgentProfiles(opts?: { pickable?: boolean }): Promise<ListedAgentProfile[]>;
}

/** writer/argv-builder.ts — the settings rendered as one CLI invocation for the preview the settings screen shows. */
export type BuildCliInvocation = (input: {
  binary: CliBinary; subcommand: string; settings: Record<string, unknown>; required?: Record<string, string>;
}) => { argv: string[]; env: Record<string, string>; applied: string[]; unapplied: Array<{ key: string; value: unknown; channel: "NONE"; reason: string }> };

/** writer/server/verify.ts — a task's verification[] run on a prepared tree, per check. */
export type RunVerification = (config: PrototypeConfig, task: TaskV2, runId?: string) => Promise<Array<{
  command: string; exitCode: number; stdout: string; stderr: string; hostError?: true;
}>>;

/** workflow/server/graph-helper.ts — one helper thread of a graph step: its id, answer text and spend. */
export type GraphHelperRun = { threadId: string; text: string; usage: { usage?: { tokens: number; costUsd: number; unknown?: true }; threadId?: string } };

/** wall/service.ts `graphSteps` — the wall row's hunt steps the wall-hunt graph drives (the pack stays wall-typed and passes through opaquely). */
export interface WallGraphApi {
  graph: {
    spawnReader(input: { who: "hunter" | "analysis"; prompt: string; graph: { spawnId: string; metadata: Record<string, unknown> } }): Promise<string>;
    hunterPrompt(angle: string, pack: unknown): string;
    judge(wallKey: string, pack: unknown, runs: ReadonlyArray<{ angle: string; text: string | null; tokens: number }>): { outcome: { state: "usable" | "unknown"; usable: readonly unknown[] }; tokens: number };
    recordAnalysis(wallKey: string, text: string): void;
  };
}

/** writer/skill-switch.ts — the skill-switch line of the wall's morning summary, injected into the wall so it does not import writer. */
export type SkillSwitchMorningLine = (db: Pick<import("better-sqlite3").Database, "prepare" | "transaction">, now: number) => string | null;

/** The settings a stage's helpers see (project + run scopes merged): owned by the settings room, injected so critique,
 * writer, memory, docs and project-life do not import the high settings room. */
export type StageHelperSettings = (bb: BbPluginApi, db: LanePilotDatabase, projectId: string, runId: string) => Promise<Record<string, unknown>>;
