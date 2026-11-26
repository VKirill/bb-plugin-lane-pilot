import type { AgentListItem, PrototypeConfig, TaskV2, BirthKind, CodeCriticDefault } from "../../../contracts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PreflightResult, WorkflowEngine, WorkflowStore } from "@lane-pilot/workflow-engine";
import type { createWorkflowCatalog } from "@lane-pilot/workflow-engine";
import type { RunBudget, createProviderBreaker } from "@lane-pilot/resilience";
import type { CliBinary } from "@lane-pilot/settings-catalog";
import type { DirtSnapshot } from "../../../dirt-snapshot";
import type { LanePilotDatabase, getAttempt, getRun } from "../../../storage";

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
  loadStore(projectId?: string): Promise<{ store: WorkflowStore; loopHooks?: { manifest: unknown; sha256: string | null; error?: string } }>;
  /** Composes the project's reserved loop hooks without making consuming rooms import workflow internals. */
  prepareWorkflow(projectId: string, workflow: import("@lane-pilot/workflow-engine").Workflow): Promise<{ workflow: import("@lane-pilot/workflow-engine").Workflow; resolve: import("@lane-pilot/workflow-engine").ResolveWorkflow; composed: boolean }>;
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
export type IsLiveFolder = (runId: string | undefined, hostId: string, folder: string, options?: { fresh?: boolean }) => Promise<boolean>;
export type ProbeLiveFolder = (runId: string | undefined, hostId: string, folder: string) => Promise<"git"|"no-git"|"unknown">;
export type InvalidateLiveFolder = (runId: string) => Promise<void>;

/** writer/server/state.ts — the shared writer state. */
export interface WriterStateApi {
  activeWriterTasks: Set<string>;
  providerBreaker: ReturnType<typeof createProviderBreaker>;
  /** The keyed writer pool (tasks/run-policy.ts RunWriterPool): one semaphore per run, mirrored structurally. */
  runWriterPool: { acquire(runId: string, limit: number, rank?: number): Promise<() => void>; /** Optional: a pool that cannot say so just waits unnamed. */ busy?(key: string, limit: number): boolean; /** Same-host parent/child folder claim; old test doubles may omit it. */ acquireFolder?(hostId: string, path: string, rank?: number, signal?: AbortSignal): Promise<() => void> };
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
    /** The contract before an in-place change: when owns_paths or never_touch differ, the owns barrier follows first. */
    previousContract?: TaskV2;
    reason: string; turn: string; qaAnswer: string;
  }): Promise<{ ok: true; deliveryUnknown?: true } | { ok: false; hint: string; sideEffects?: "unknown" }>;
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
export type ListedAgentProfile = AgentListItem;

export interface WriterReassignApi {
  requestReassign(input: ReassignInput): Promise<ReassignRequested | ReassignRefusal>;
  reassignTask(input: ReassignInput): Promise<ReassignResult>;
  awaitReassignedThread(runId: string, taskId: string, oldAttemptNo: number): Promise<string | null>;
}

/** native-agent/custom-agent.ts `AgentListItem` in contracts/agent-picker — the listing RPC types it without the room (checked both ways at wiring). */

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
/** `options.isolated`: a background sweep's run (the landing suite) — its own pool, one check at a time, and it writes no check-duration history. */
export type RunVerification = (config: PrototypeConfig, task: TaskV2, runId?: string, writerThreadId?: string, options?: { isolated?: boolean; throwaway?: boolean }) => Promise<Array<{
  command: string; exitCode: number; stdout: string; stderr: string; hostError?: true;
}>>;

/** workflow/server/graph-helper.ts — one helper thread of a graph step: its id, answer text and spend. */
export type GraphHelperRun = { threadId: string; text: string; usage: { usage?: { tokens: number; costUsd: number; unknown?: true }; threadId?: string } };

/** workflow/server/workflow-triggers.ts — who may start a workflow and what it answers. */
export type WorkflowTriggerSource = "manual" | "schedule" | "event";
export type WorkflowTriggerResult =
  | { ok: true; runId: string; created: boolean; status: string; notChecked: string[] }
  | { ok: false; reason: string; message: string; issues?: PreflightResult["issues"]; envRequests?: PreflightResult["envRequests"]; missing?: string[] };

/** workflow/server/workflow-triggers-live.ts — starts a workflow for a schedule, the board or a hook. */
export interface WorkflowTriggersApi {
  workflowTriggers: {
    start(input: {
      projectId: string; workflowId: string; inputs: Record<string, unknown>; source: WorkflowTriggerSource;
      key?: string | undefined; liveTrial?: boolean | undefined; origin?: "schedule" | undefined;
      /** A run that is nobody's business but the project's (the lead's tick): no PM chat, no run link, hidden helpers. */
      detached?: boolean | undefined;
      /** The starter of a Lane Pilot system schedule: it may start the starter graph whose `startedBy` is this name (the schedule executor only). */
      starter?: string | undefined;
    }): Promise<WorkflowTriggerResult>;
    emitEvent(
      name: string,
      payload?: Record<string, unknown>,
      options?: { id?: string; key?: string; attemptKey?: string; projectId?: string },
    ): Promise<{
      eventId: string;
      key: string;
      duplicate: boolean;
      woken: number;
      started: Array<{ workflowId: string; runId: string; created: boolean }>;
      failed: Array<{ workflowId: string; reason: string; message: string }>;
    }>;
    sync(projectId: string): Promise<{ created: number; updated: number; removed: number; failed: string[]; complete: boolean }>;
    pmOf(projectId: string): Promise<{ pmThreadId: string; runId: string } | null>;
    pmOfOrUnknown(projectId: string): Promise<{ pmThreadId: string; runId: string } | null | "unknown">;
    /** Checks a prepared project workflow with the same capability ports used by live triggers. */
    preflight(workflow: import("@lane-pilot/workflow-engine").Workflow, input: { projectId: string; threadId?: string | null }): Promise<PreflightResult>;
    syncTriggers(projectId?: string): Promise<void>;
    scheduledProjects(): string[];
  };
}

/** writer/server/dispatch.ts — the writer dispatch surface (PM tools, resume after a reload). */
export interface WriterDispatchApi {
  readWriterWorkspaceFile: ReadWriterWorkspaceFile;
  dispatchWriter: DispatchWriter;
  waitWriter: WaitWriter;
  resumeDispatch: ResumeDispatch;
}

/** writer/server/start.ts — starts the first writer attempt of a task. */
export interface WriterStartApi {
  startWriterTask: StartWriterTask;
}

/** The settings a stage's helpers see (project + run scopes merged): owned by the settings room, injected so critique,
 * writer, memory, docs and project-life do not import the high settings room. */
export type StageHelperSettings = (bb: BbPluginApi, db: LanePilotDatabase, projectId: string, runId: string) => Promise<Record<string, unknown>>;
