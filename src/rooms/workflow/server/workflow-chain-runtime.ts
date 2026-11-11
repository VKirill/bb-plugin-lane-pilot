import type { IsTaskSatisfied } from "../../contracts";
import { getRun } from "../../storage";
import { isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import type { NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { RunRow } from "../../storage";
import { projectFolder } from "../../platform/server";
import { startedBySchedule } from "./workflow-runtime";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

import type { DispatchWriter } from "../../platform/server";

import type { StabilityPort } from "../../contracts";
import { parseIntegrationGateSettings, type VerificationGatePort } from "../../contracts/integration-gate";
import type { TaskUsage } from "../../platform/server";
import type { WorkflowEngineApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  dispatchWriter: DispatchWriter;
  isTaskSatisfied: IsTaskSatisfied;
  taskUsage: TaskUsage;
  stability: StabilityPort;
  resolveIntegrationGate: VerificationGatePort;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

export type LpTaskRuntime = { attemptId: string };

/** The dispatch pipeline's `lp-task` executor: the writer room provides it from the composition root, per engine; the merged
 * executor reads it at run time, never at mount. */
const lpTaskPipelines = new WeakMap<WorkflowEngine, NodeExecutor<LpTaskRuntime>>();
export function provideLpTaskPipeline(engine: WorkflowEngine, executor: NodeExecutor<LpTaskRuntime>): void { lpTaskPipelines.set(engine, executor); }
export function lpTaskPipeline(engine: WorkflowEngine): NodeExecutor<LpTaskRuntime> | undefined { return lpTaskPipelines.get(engine); }

/**
 * The executors that run a chain on the host: the generic agent step, the owner's question, the code task of a chain, the actions
 * that read the plugin's own state or the PM's checkout, and the actions that go through a helper thread (a skill, an MCP tool, the
 * owner's accounts) the way errands do. The pure ones (dedupe, the verdict thresholds, the citation check) are in workflow/actions.ts.
 */
export type Row = Record<string, unknown>;
export const rec = (value: unknown): Row => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {});
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const stringList = (value: unknown): string[] => (typeof value === "string" && value ? [value] : []);

/** The runtime of a chain run rebuilt from its row after a reload; undefined for the per-task pipeline, which needs its own in-memory runtime. */
export function chainRuntimeFor(ctx: ServerCore, services: Services) {
  return (run: RunRow): ChainRuntime | undefined => {
    if (run.workflow_id === "lp-task-pipeline" || run.idem_key?.startsWith("lp-task:")) return undefined;
    if (!run.project_id) return undefined;
    // A run started in a project without a PM chat has no link: it works on its own.
    if (!run.link_run_id) return { ctx, services, pmThreadId: null, projectId: run.project_id, runId: null, ...(startedBySchedule(ctx.db, run) ? { origin: "schedule" as const } : {}) };
    const linked = getRun(ctx.db, run.link_run_id);
    if (!linked?.pm_thread_id) return undefined;
    return { ctx, services, pmThreadId: linked.pm_thread_id, projectId: run.project_id, runId: run.link_run_id, ...(startedBySchedule(ctx.db, run) ? { origin: "schedule" as const } : {}) };
  };
}

export const need = (c: StepContext<ChainRuntime>): ChainRuntime => {
  if (!c.runtime) throw new Error("this workflow run has no PM chat to work in (its run was closed or the plugin lost it); start it again");
  return c.runtime;
};

/** The steps that build code or read the Lane Pilot run need a PM chat and its run; a run of a project without Lane Pilot stops there with the way out. */
type WithPm = ChainRuntime & { pmThreadId: string; runId: string };
export const needLanePilot = (rt: ChainRuntime, what: string): WithPm => {
  if (!rt.pmThreadId || !rt.runId) throw new Error(`needs_lane_pilot: ${what} needs Lane Pilot in the project (an open PM chat) and this run has none; enable Lane Pilot in a chat of the project`);
  return rt as WithPm;
};

/** The PM's checkout: where a chain writes its reports and reads its diffs. Without a PM chat it is the project's own first folder. */
export async function pmCheckout(rt: ChainRuntime): Promise<{ hostId: string; path: string }> {
  const { bb } = rt.ctx;
  if (!rt.pmThreadId) {
    const folder = await projectFolder(bb, rt.projectId);
    if (!folder) throw new Error("the project has no folder on a machine to work in");
    return folder;
  }
  const pm = await bb.sdk.threads.get({ threadId: rt.pmThreadId });
  const environmentId = stringAt(pm, "environmentId");
  const env = environmentId ? await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound) : null;
  const path = stringAt(env, "path"), hostId = stringAt(env, "hostId");
  if (!path || !hostId) throw new Error("the PM chat has no checkout to work in");
  return { hostId, path };
}

export const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
export const PRUNE = /(^|\/)(node_modules|vendor|dist|build)\/|\.lock$|\.min\.[a-z]+$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

// One deep import into contracts serves the whole room: siblings take it from here, not across the boundary.
export { parseIntegrationGateSettings };
