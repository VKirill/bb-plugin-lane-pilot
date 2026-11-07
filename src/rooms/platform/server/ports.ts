import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { WorkflowEngine, WorkflowStore } from "@lane-pilot/workflow-engine";
import type { createWorkflowCatalog } from "@lane-pilot/workflow-engine";
import type { RunBudget, createProviderBreaker } from "@lane-pilot/resilience";
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
  machineAffinity?: "mac-mini" | "ovh" | "windows" | "any";
  coreSkills?: string[];
  skillSections?: string[];
  deliverables?: string[];
  validator?: string;
};

/** writer/server/writer-host.ts — the host pickers and the agent listing the runs RPC answers with. */
export interface WriterHostApi {
  resolveProjectWriterHost(args: {
    projectId: string; threadId?: string | null; selected?: { hostId: string; path: string } | null;
  }): Promise<{ status: "offline" | "resolved" | "setup_required" | "catalog_unavailable" | "ambiguous"; [key: string]: unknown }>;
  listedAgentProfiles(opts?: { pickable?: boolean }): Promise<ListedAgentProfile[]>;
}

/** The settings a stage's helpers see (project + run scopes merged): owned by the settings room, injected so critique,
 * writer, memory, docs and project-life do not import the high settings room. */
export type StageHelperSettings = (bb: BbPluginApi, db: LanePilotDatabase, projectId: string, runId: string) => Promise<Record<string, unknown>>;
