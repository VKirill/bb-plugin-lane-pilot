import { observeStageChild, waitThreadIdle } from "@lane-pilot/thread-observe";
import { isOffered, routeIntent, type StepContext, type Workflow, wfErrandSpawnRunOfThread, wfWorkflowIdOfRun } from "@lane-pilot/workflow-engine";
import { bestEffort, redactKnown } from "@lane-pilot/kit";
import { SCHEDULE_RUN_KEY_PREFIX, type DocsPort, type ExtraAccess } from "../../../contracts";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { beginWorkflowWait, fenceOutside, findThreadsByMetadata, keyedSpawnSupported, noteWorkflowReadByPm, type WorkflowEngineApi, type WorkflowLibraryApi } from "../../../platform/server";
import { withUsage } from "../../../usage/server";
import type { ErrandSnapshot } from "../../models/errand-prompt";
import type { ErrandCore } from "./errand-core";
import { errandSpawnOf } from "./errands-overview";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface ErrandsServices {
  docsPlaces: DocsPort["docsPlaces"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowLibrary: WorkflowLibraryApi;
}

export const ERRAND_WORKFLOW = "errand";
export const ERRAND_SPAWN_WAIT_MS = 15_000;
const WAIT_STEP_MS = 5_000;
export const ERRAND_TERMINAL = ["failed", "blocked", "canceled"];
const API_RECON_WORKFLOW = "api-recon";
// An errand hands its brief to a graph only on a sure route: a read-only check of our own plugin's screens in BB scored 61
// (hub errands, 2026-10-30), and the week's two invoices ran as plain errands although invoice-send routed at 95 and 70 (hub, 2026-11-02).
const ERRAND_ROUTE_CONFIDENCE = 90;
// A starter's own graph or an internal one is never a self-route target even when it lands on the offered list.
const ERRAND_ROUTE_NEVER = new Set(["errand", "specialist", "browser-step", "web-research"]);

const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const sleepErrandWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ErrandRunStart = {
  projectId: string; pmThreadId: string | null; runId: string | null;
  /** Names the run: the same key is the same run (a schedule's: the key of its run). */
  key: string;
  task: string; title?: string | undefined; authorized: boolean; accounts: readonly string[];
  /** BB plugins, skills and MCP servers the helper loads on top of the errand role's own. */
  plugins?: readonly string[] | undefined; skills?: readonly string[] | undefined; mcp?: readonly string[] | undefined;
  providerId?: string | undefined; model?: string | undefined; reasoning?: string | undefined; serviceTier?: "default" | "fast" | undefined;
  /** The kind of errand (errand-kinds.ts) and who named it (pm, hint, jev, schedule): the row of the role table the helper runs on. */
  kind?: string | undefined; kindBy?: string | undefined;
  /** A hidden thread with no parent chat. */
  detached?: boolean | undefined;
  /** A schedule started it: the helper cannot create schedules, and the thread says which schedule run it is for. */
  schedule?: { id: string; runKey: string } | undefined;
  /** What the router said about the brief (the ledger on the run's inputs; startRun of a schedule leaves both empty). */
  routeTop?: string | undefined; routeWhy?: string | undefined;
};

/** Orchestration for the `errand` graph: step execution, intent routing, run creation and waiting. */
export function createErrandGraphService(ctx: ServerCore, services: ErrandsServices, core: ErrandCore) {
  const { bb, db } = ctx;
  const engine = services.workflowEngine;

  const need = (c: StepContext<ChainRuntime>): ChainRuntime => {
    if (!c.runtime) throw new Error("this errand has no project to work in (its PM chat was closed or the plugin lost it); start it again");
    return c.runtime;
  };
  const list = (c: StepContext<ChainRuntime>, input: string): string[] => {
    const value = c.resolve(`$inputs.${input}`);
    return Array.isArray(value) ? value.map(String) : [];
  };
  const names = (c: StepContext<ChainRuntime>): string[] => list(c, "accounts");
  /** What the errand asked for besides the role's profile; nothing asked keeps the profile alone. */
  const access = (c: StepContext<ChainRuntime>): ExtraAccess | undefined => {
    const extra: ExtraAccess = {};
    if (list(c, "plugins").length) extra.bbPlugins = list(c, "plugins");
    if (list(c, "skills").length) extra.skills = list(c, "skills");
    if (list(c, "mcp").length) extra.mcpServers = list(c, "mcp");
    return Object.keys(extra).length ? extra : undefined;
  };

  async function runAccountsStep(c: StepContext<ChainRuntime>) {
    const rt = need(c);
    const resolved = await core.resolveAccounts({ projectId: rt.projectId, runId: rt.runId, pmThreadId: rt.pmThreadId, names: names(c) });
    if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
    return { output: { ok: true, count: resolved.accounts.length } };
  }

  async function runErrandStep(c: StepContext<ChainRuntime>) {
    const rt = need(c);
    const input = (name: string) => c.resolve(`$inputs.${name}`);
    // Only the gate and the catalog entries for the brief: the `accounts` step already noted them as issued.
    const resolved = await core.resolveAccounts({ projectId: rt.projectId, runId: rt.runId, pmThreadId: rt.pmThreadId, names: names(c), record: false });
    if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
    const detached = input("detached") === true || rt.origin === "schedule";
    const tier = text(input("serviceTier"));
    const agentId = text(input("agentId")) || undefined;
    const place = { projectId: rt.projectId, pmThreadId: rt.pmThreadId, ...(agentId ? { agentId } : {}) };
    const snapshot = await c.effect<ErrandSnapshot | null>("before", "errand.before", () => core.errandSnapshot(place), { reconcile: async () => ({ happened: false }) });
    const spawnId = c.spawnKey;
    const started = await c.effect<{ threadId: string; browserMachine: string | null }>("spawn", "errand.spawn", () => core.startErrand({
      ...place, runId: rt.runId, task: text(input("task")), title: text(input("title")) || undefined, authorized: input("authorized") === true, accounts: resolved.accounts, access: access(c),
      providerId: text(input("providerId")) || undefined, model: text(input("model")) || undefined, reasoning: text(input("reasoning")) || undefined,
      serviceTier: tier === "fast" ? "fast" : undefined, kind: text(input("kind")) || undefined, spawnId, detached,
      metadata: {
        lanePilotWorkflowRunId: c.runId, lanePilotWorkflowStep: c.stepKey, lanePilotWorkflowSpawn: c.spawnKey, lanePilotWorkflowNode: c.nodeId,
        ...(rt.origin ? { origin: rt.origin } : {}), ...(text(input("scheduleId")) ? { scheduleId: text(input("scheduleId")), scheduleRunKey: text(input("scheduleRunKey")) } : {}),
      },
    }), {
      intent: { spawnId },
      // A spawn the process died in is found again by its key (or by the metadata where the core has no keys); one that never happened is made.
      reconcile: async () => {
        if (keyedSpawnSupported(bb)) return { happened: false };
        const found = await findThreadsByMetadata(bb, { lanePilotWorkflowRunId: c.runId, lanePilotWorkflowStep: c.stepKey, lanePilotWorkflowSpawn: c.spawnKey }, rt.projectId);
        if (!found) return null;
        return found[0] ? { happened: true, result: { threadId: found[0].id, browserMachine: null } } : { happened: false };
      },
    });
    try {
      await waitThreadIdle(bb, started.threadId, "errand", undefined, undefined, () => (ctx.isDisposed() ? "plugin_stopped" : c.signal.aborted ? "aborted" : null));
    } catch (cause) {
      if (c.signal.aborted) await bestEffort(ctx.log, `errand thread stop ${started.threadId}`, bb.sdk.threads.stop({ threadId: started.threadId }), undefined);
      throw cause;
    }
    const report = await core.completedReport(started.threadId, rt.projectId, snapshot);
    return {
      output: {
        state: report.state, reason: report.reason ?? "", output: report.output, files: report.files ?? [], thread_id: started.threadId,
        verified: report.verified, checks: report.checks.map((row) => `${row.claim} → ${row.evidence}`),
        handoff: `errand ${report.state}${report.reason ? `: ${report.reason}` : ""}`,
      },
      ...(await withUsage(bb, started.threadId)),
    };
  }

  /** The offered catalog the PM's router sees (the project's own graphs included), else the shipped ones when the store cannot be read here. */
  const library = services.workflowLibrary;
  async function offeredCatalog(projectId: string): Promise<Workflow[]> {
    try { return (await library.loadStore(projectId)).store.list().map((item) => item.workflow); }
    catch {
      const catalog = services.workflowCatalog;
      if (!catalog?.store) return catalog?.builtins() ?? [];
      const store = await bestEffort(ctx.log, `workflow catalog ${projectId}`, catalog.store(), null);
      if (!store) return catalog.builtins();
      const listed = await bestEffort(ctx.log, `workflow catalog list ${projectId}`, Promise.resolve().then(() => store.list().map((item) => item.workflow)), null);
      return listed ?? catalog.builtins();
    }
  }

  /**
   * A sure route of the brief to an offered graph: the run of that graph, else the ledger entry (routeTop/routeWhy) a plain errand
   * run carries so the errands page and the lead can read what the router said. The PM wrote both magicseo recons as errands, and both
   * fell to a GLM member of the errand pool (2026-10-30 and the replay of 2026-10-31); the router reads the brief, so neither the owner
   * nor the PM needs to know the graph.
   */
  async function routedGraph(input: { task: string; authorized: boolean; accounts: readonly string[]; projectId: string }): Promise<{ match: { workflow: Workflow; inputs: Record<string, unknown>; confidence: number } } | { top: string; why: string }> {
    const catalog = await offeredCatalog(input.projectId);
    const routed = await bestEffort(ctx.log, "errand route intent", routeIntent({ intent: input.task, workflows: catalog }), null);
    if (!routed) return { top: "", why: "none" };
    if (routed.decision !== "route" || !routed.workflowId) return { top: routed.suggested ? `${routed.suggested}:${routed.confidence}` : "", why: routed.suggested ? "below_confidence" : "none" };
    const top = `${routed.workflowId}:${routed.confidence}`;
    if (routed.confidence < ERRAND_ROUTE_CONFIDENCE) return { top, why: "below_confidence" };
    const workflow = catalog.find((item) => item.id === routed.workflowId);
    if (!workflow || !isOffered(workflow) || ERRAND_ROUTE_NEVER.has(workflow.id) || workflow.id.startsWith("lp.")) return { top, why: "not_offered" };
    // A brief with authorized: true routes only to a published graph: a tested one's first real run is decided by the owner, never under an authorized blanket.
    if (workflow.status === "tested" && input.authorized) return { top, why: "tested_needs_unauthorized" };
    // A required input the brief (and the router's guesses) cannot fill stays the PM's question, not a half-started graph.
    if (routed.missingInputs.length) return { top, why: `missing_inputs:${routed.missingInputs.join(",")}` };
    // api-recon's account is not in the brief's text: the errand's first Env Catalog name fills it, as apiRecon did.
    const inputs = workflow.id === API_RECON_WORKFLOW ? { ...routed.inputs, account: routed.inputs.account ?? input.accounts[0] ?? "" } : routed.inputs;
    return { match: { workflow, inputs, confidence: routed.confidence } };
  }

  /** Starts the errand graph, or returns the run that already has the key. */
  function startRun(input: ErrandRunStart): { runId: string; created: boolean } {
    const workflow = services.workflowEngine.resolveWorkflow(ERRAND_WORKFLOW);
    if (!workflow) throw new Error(`built-in workflow ${ERRAND_WORKFLOW} is not loaded`);
    const runtime: ChainRuntime = { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId, ...(input.schedule ? { origin: "schedule" as const } : {}) };
    // A scheduled run carries the schedule prefix in its key: after a reload the key is all that says who started it.
    const key = input.schedule ? `${SCHEDULE_RUN_KEY_PREFIX}${input.projectId}:${ERRAND_WORKFLOW}:${input.key}` : input.key;
    const started = engine.start({
      workflow, key, runtime, link: { projectId: input.projectId, ...(input.runId ? { runId: input.runId } : {}) },
      inputs: {
        task: input.task, title: input.title ?? "", authorized: input.authorized, accounts: [...input.accounts],
        plugins: [...input.plugins ?? []], skills: [...input.skills ?? []], mcp: [...input.mcp ?? []],
        providerId: input.providerId ?? "", model: input.model ?? "", reasoning: input.reasoning ?? "", serviceTier: input.serviceTier ?? "default",
        detached: input.detached === true, scheduleId: input.schedule?.id ?? "", scheduleRunKey: input.schedule?.runKey ?? "",
        kind: input.kind ?? "", kindBy: input.kindBy ?? "",
        routeTop: input.routeTop ?? "", routeWhy: input.routeWhy ?? "",
      },
    });
    started.done.catch((cause: unknown) => ctx.log(`Lane Pilot errand run ${started.runId} stopped with an error: ${cause instanceof Error ? cause.message : String(cause)}`));
    return { runId: started.runId, created: started.created };
  }

  /** What the `spawn` effect of a run's helper step recorded: the thread and the browser machine, once the thread exists. */
  function spawnedOf(runId: string): { threadId: string; browserMachine: string | null } | null {
    return errandSpawnOf(db, runId);
  }
  /** The errand run whose helper thread this is; null for a thread no errand run made (one an earlier version started). */
  function runOfThread(threadId: string): string | null {
    return wfErrandSpawnRunOfThread(db, threadId);
  }
  const isErrandRun = (runId: string): boolean => wfWorkflowIdOfRun(db, runId) === ERRAND_WORKFLOW;

  /**
   * The errand run's report once it ends, or «running» with what the helper is doing when `deadline` passes first. While it
   * waits, the run counts as awaited, so the run's end never also becomes a PM notice (wait_errand and a detached errand alike).
   */
  async function errandOutcome(runId: string, threadIdHint: string | undefined, deadline: number): Promise<{ ended: boolean; text: string }> {
    const done = (value: string) => ({ ended: true, text: value });
    let detail = "";
    const endWait = beginWorkflowWait(runId);
    try {
      while (Date.now() < deadline && !ctx.isDisposed()) {
        const summary = engine.get(runId);
        if (!summary) throw new Error(`there is no errand run ${runId}`);
        const threadId = spawnedOf(runId)?.threadId ?? threadIdHint;
        if (summary.status === "succeeded") {
          noteWorkflowReadByPm(runId);
          const out = (summary.output ?? {}) as Record<string, unknown>;
          // The api-recon graph's map (see apiRecon): its status, the summary and the paths of the map.
          if (typeof out.status === "string" && out.state === undefined) {
            const files = [text(out.api_map), text(out.endpoints)].filter(Boolean);
            return done(JSON.stringify({
              workflowRunId: runId, workflow: API_RECON_WORKFLOW, state: out.status === "done" ? "done" : "blocked", ...(text(out.reason) ? { reason: text(out.reason) } : {}),
              ...(files.length ? { files } : {}), observed: out.observed ?? null, bundleOnly: out.bundle_only ?? null, officialApi: out.official_api ?? null,
              output: fenceOutside("errand", text(out.report)),
            }, null, 2));
          }
          return done(JSON.stringify({
            workflowRunId: runId, threadId: text(out.thread_id) || threadId, state: out.state === "done" ? "done" : "blocked",
            ...(text(out.reason) ? { reason: text(out.reason) } : {}), ...(Array.isArray(out.files) && out.files.length ? { files: out.files } : {}),
            output: fenceOutside("errand", text(out.output)),
          }, null, 2));
        }
        if (ERRAND_TERMINAL.includes(summary.status)) {
          noteWorkflowReadByPm(runId);
          return done(JSON.stringify({ workflowRunId: runId, ...(threadId ? { threadId } : {}), state: "failed", output: fenceOutside("errand", redactKnown(summary.error ?? summary.reason ?? summary.status)) }));
        }
        if (threadId) {
          const observed = await observeStageChild(bb, threadId, Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
          detail = observed.kind === "completed" ? "the helper has ended; its report is being checked" : observed.detail;
          // The thread has ended or failed: the step finishes or fails the run in a moment, so look again soon, not at once.
          if (observed.kind !== "observing") await sleepErrandWait(250);
        } else await sleepErrandWait(Math.min(500, Math.max(1, deadline - Date.now())));
      }
      const threadId = spawnedOf(runId)?.threadId ?? threadIdHint;
      return { ended: false, text: JSON.stringify({ workflowRunId: runId, ...(threadId ? { threadId } : {}), state: "running", output: fenceOutside("errand", redactKnown(detail)) }) };
    } finally { endWait(); }
  }

  /** An errand thread no run made (started by an earlier version of the plugin): waited on as before, with no checkout snapshot to compare. */
  async function legacyWait(threadId: string, deadline: number, projectId: string): Promise<string> {
    let detail = "";
    while (Date.now() < deadline && !ctx.isDisposed()) {
      const observed = await observeStageChild(bb, threadId, Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
      if (observed.kind === "completed") {
        const report = await core.completedReport(threadId, projectId);
        return JSON.stringify({ threadId, ...report, output: fenceOutside("errand", report.output) }, null, 2);
      }
      if (observed.kind === "product_failure") return JSON.stringify({ threadId, state: "failed", output: fenceOutside("errand", redactKnown(`${observed.via}: ${observed.detail}`)) });
      detail = observed.detail;
    }
    return JSON.stringify({ threadId, state: "running", output: fenceOutside("errand", redactKnown(detail)) });
  }

  return {
    runAccountsStep,
    runErrandStep,
    routedGraph,
    startRun,
    spawnedOf,
    runOfThread,
    isErrandRun,
    errandOutcome,
    legacyWait,
  };
}
export type ErrandGraphService = ReturnType<typeof createErrandGraphService>;
