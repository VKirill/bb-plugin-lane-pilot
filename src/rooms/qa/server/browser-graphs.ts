import type { NodeExecutor, RunSummary, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { getAttempt, getRunSettingsScopes, getTask, listAttemptsForTask, listStageReceipts, loadProjectSettings } from "../../storage";
import { taskV2Schema } from "../../contracts";
import { taskQaPlan } from "../../critique";
import { QA_HOST_KEY } from "../qa-host";
import { builtinWorkflow } from "../../workflow";
import { configuredSetting, fenceOutside } from "../../core/server";
import type { ServerCore, Services } from "../../core/server";
import { requireGreen } from "../../workflow/server";
import type { ChainRuntime } from "../../workflow/server";
import { withUsage } from "../../usage/server";

/**
 * Browser work as graphs (graph unification S4). Two built-in starter graphs, both started by a PM tool:
 * - `browser-step` (`lane_pilot_browser`): the action `browser.goal` (host `browserGoal`, jev-ultrafast in the owner's Chrome), usable in any graph.
 * - `lp.browser-qa` (`lane_pilot_browser_qa`): the action `lp.browser-qa` wraps `runBrowserQa` (qa.ts), so the `browser-qa` stage receipts are
 *   the ones the stage always wrote. A check still running after a plugin reload is read back from its receipt (`poll`).
 *   A task that carries qa_cases and qa_url runs it as a step of its own pipeline (`lp-task-pipeline`: the step `lp.qa-gate`, then the subworkflow).
 */
export const BROWSER_STEP = "browser-step";
export const BROWSER_QA = "lp.browser-qa";

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The browser machine of the project (`browser_qa.host_id`), as the run's settings scopes give it. */
export function browserHostId(ctx: Pick<ServerCore, "db">, projectId: string, runId: string | null): string | null {
  const settings = loadProjectSettings(ctx.db, projectId, runId ? getRunSettingsScopes(ctx.db, runId) : []);
  const value = configuredSetting(settings, QA_HOST_KEY);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type BrowserGoalInput = { url: string; goal: string; changes: boolean; authorized: boolean; timeoutSec: number };

/** A refusal is data, not a failure: the graph ends with `status: refused` and the reason, as the tool always answered. */
function refusal(input: BrowserGoalInput, hostId: string | null): string | null {
  if (input.changes && !input.authorized) return "changes_need_owner_authorization: ask the owner, then pass authorized=true";
  if (!hostId) return `no_browser_machine: set ${QA_HOST_KEY} (Browser QA machine) in Lane Pilot settings`;
  return null;
}

const bindings = new WeakMap<object, { engine: WorkflowEngine; services: Services }>();

/** The action `browser.goal` and the step `lp.browser-qa`; the tools reach the engine through `ctx` (set here). */
export function registerBrowserExecutors(engine: WorkflowEngine, ctx: ServerCore, services: Services): void {
  bindings.set(ctx, { engine, services });
  const { db, host, bb } = ctx;

  engine.register<ChainRuntime>("browser.goal", {
    // A goal that changes something is never repeated by a reload (the effect then reads «unknown»); a read-only one may be.
    reentrant: true,
    run: async (c: StepContext<ChainRuntime>) => {
      const rt = c.runtime;
      if (!rt) throw new Error("this workflow run has no project to work in (the plugin lost it); start it again");
      const node = c.node as Extract<typeof c.node, { type: "action" }>;
      const params = c.template(node.params) as Row;
      const input: BrowserGoalInput = {
        url: str(params.url), goal: str(params.goal), changes: params.changes === true, authorized: params.authorized === true,
        timeoutSec: typeof params.timeout_sec === "number" ? params.timeout_sec : 180,
      };
      const hostId = browserHostId(ctx, rt.projectId, rt.runId);
      const refused = refusal(input, hostId);
      if (refused) return { output: { status: "refused", reason: refused } };
      const goal = input.changes ? input.goal : `${input.goal}\nRead-only: do not submit, change, delete, pay or publish anything.`;
      const result = await c.effect("goal", "browser.goal", () => host.call("browserGoal", { requestedHostId: hostId!, url: input.url, goal, timeoutSec: input.timeoutSec },
        { hostId: hostId!, timeoutMs: (input.timeoutSec + 30) * 1000 }), { intent: { url: input.url, changes: input.changes }, reconcile: async () => (input.changes ? null : { happened: false }) });
      bb.log.info(`browser goal on ${hostId}: ${result.status} ${result.url ?? ""} (${result.actions ?? "?"} actions)`);
      // null fields are left out (the graph's fields are optional); the tool puts them back.
      return { output: { hostId: result.hostId, exitCode: result.exitCode, status: result.status, url: result.url, actions: result.actions, title: result.title, text: result.text, log: result.log } };
    },
  } as NodeExecutor<ChainRuntime>);

  // ---------------------------------------------------------------- browser check of an accepted task
  /** How long the gate looks at the acceptance receipt of an attempt that already reads accepted before it parks the step (the writer records the two a moment apart). */
  const RECEIPT_WAIT_MS = 2_000;
  /** How long a parked gate waits for the receipt before it ends blocked: far beyond any normal delay, so a missing receipt is a fault, not «no check». */
  const RECEIPT_BOUND_MS = 30 * 60_000;

  const acceptanceReceiptPassed = (runId: string, taskId: string): boolean =>
    listStageReceipts(db, runId, taskId).find((item) => item.stageId === "acceptance-receipt")?.state === "passed";
  const gateRun = (runId: string, taskId: string, plan: NonNullable<ReturnType<typeof taskQaPlan>>) =>
    ({ run: true, run_id: runId, task_id: taskId, url: plan.url, cases: plan.cases, env_class: plan.envClass, dev_server: plan.devServer });

  /**
   * The decision after the code task of `lp-task-pipeline`: is a browser check due? It is when the task ended accepted and its contract has
   * qa_cases and qa_url. It reads the stored task, not the dispatch's memory: the pipeline may have outlived a plugin reload.
   * «No check» is only ever the answer to «nothing to check»: a task that is due a check but whose acceptance receipt is not there yet parks
   * the step (`qa-receipt`); the poll runs the check when the receipt appears, also after a reload, and ends the step blocked when it never does.
   */
  engine.register("lp.qa-gate", {
    reentrant: true,
    run: async (c: StepContext) => {
      const row = engine.journal.getRun(c.runId);
      const runId = row?.link_run_id ?? "", taskId = row?.link_task_id ?? "";
      const none = { output: { run: false } };
      if (!runId || !taskId) return none;
      const contract = taskV2Schema.safeParse(getTask(db, taskId)?.contract);
      const plan = contract.success ? taskQaPlan(contract.data) : null;
      if (!plan) return none;
      const last = listAttemptsForTask(db, runId, taskId).at(-1);
      if (!last || getAttempt(db, last.id)?.state !== "accepted") return none;
      for (const until = Date.now() + RECEIPT_WAIT_MS; !acceptanceReceiptPassed(runId, taskId) && Date.now() <= until && !c.signal.aborted;) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (acceptanceReceiptPassed(runId, taskId)) return { output: gateRun(runId, taskId, plan) };
      return { wait: { kind: "qa-receipt", detail: { runId, taskId, attemptId: last.id, startedAt: Date.now() } } };
    },
    poll: async (step) => {
      const detail = step.await.detail as { runId?: string; taskId?: string; attemptId?: string; startedAt?: number } | undefined;
      if (!detail?.runId || !detail.taskId) return { error: "qa_gate_lost_task: the waiting gate does not say which task's acceptance it waits for" };
      const contract = taskV2Schema.safeParse(getTask(db, detail.taskId)?.contract);
      const plan = contract.success ? taskQaPlan(contract.data) : null;
      if (!plan) return { error: `qa_gate_lost_plan: task ${detail.taskId} no longer carries qa_cases and qa_url` };
      if (acceptanceReceiptPassed(detail.runId, detail.taskId)) return { output: gateRun(detail.runId, detail.taskId, plan) };
      if (detail.attemptId && getAttempt(db, detail.attemptId)?.state !== "accepted") return { error: `qa_gate_not_accepted: attempt ${detail.attemptId} stopped being accepted before its acceptance receipt appeared` };
      if (Date.now() - (detail.startedAt ?? 0) > RECEIPT_BOUND_MS) return { error: `qa_receipt_missing: the task is accepted and carries qa_cases and qa_url, but its acceptance receipt did not appear in ${RECEIPT_BOUND_MS / 60_000} minutes; the browser check was not run` };
      return null;
    },
  } as NodeExecutor);

  // The verdict of the check: a check that failed, was blocked or could not be run leaves the graph run failed. The `qa` step before it keeps the reply.
  engine.register("lp.browser-qa.verdict", {
    reentrant: true,
    run: async (c: StepContext) => {
      const state = str(c.resolve("qa.state")), reply = c.resolve("qa.reply") as Row | null;
      const reason = str(reply?.reason) || str((reply?.stage as Row | undefined)?.reason) || str(reply?.error);
      requireGreen("browser_qa", [{ stage: "browser-qa", state, reason }]);
      return { output: { state } };
    },
  } as NodeExecutor);

  const TERMINAL = ["passed", "failed", "blocked", "skipped"];
  /** What the check's own thread spent, for a receipt this step produced (not an earlier check's, found again): the step carries it up to its run. */
  const qaUsage = async (runId: string, taskId: string, since: number) => {
    const stage = listStageReceipts(db, runId, taskId).find((row) => row.stageId === "browser-qa");
    const result = stage?.result && typeof stage.result === "object" ? stage.result as Row : undefined;
    const threadId = stage?.threadId ?? (typeof result?.threadId === "string" ? result.threadId : undefined);
    return stage && threadId && stage.updatedAt >= since ? await withUsage(ctx.bb, threadId) : {};
  };
  /** A check whose receipt never turns terminal (nothing adopts it) fails the step after the longest check plus a margin. */
  const NO_VERDICT_MS = (1800 + 300) * 1000;

  engine.register<ChainRuntime>(BROWSER_QA, {
    reentrant: true,
    run: async (c: StepContext<ChainRuntime>) => {
      const rt = c.runtime;
      if (!rt?.pmThreadId || !rt.runId) throw new Error("needs_lane_pilot: a browser check needs the PM chat of the accepted task and its Lane Pilot run");
      const node = c.node as Extract<typeof c.node, { type: "action" }>;
      const params = c.template(node.params) as Row;
      const runId = str(params.run_id), taskId = str(params.task_id);
      let reply: Row;
      const since = Date.now();
      try {
        reply = await rt.services.runBrowserQa({
          threadId: rt.pmThreadId, projectId: rt.projectId, runId, taskId, url: str(params.url),
          cases: Array.isArray(params.cases) ? params.cases.map(String) : [], envClass: str(params.env_class) as never,
          viewports: str(params.viewports) || "375,768,1280", authorized: params.authorized === true,
          ...(str(params.dev_server) ? { devServer: str(params.dev_server) } : {}),
        });
      } catch (cause) {
        // What runBrowserQa throws is a call that does not fit (another chat's run, a task not accepted yet): it is the caller's to fix, not a fault of the graph.
        if (ctx.isDisposed()) throw cause;
        return { output: { state: "error", reply: { error: cause instanceof Error ? cause.message : String(cause) } } };
      }
      const state = str(reply.state);
      if (TERMINAL.includes(state) || !state) return { output: { state: state || "unknown", reply }, ...(await qaUsage(runId, taskId, since)) };
      // Still running (a check another call or a reload left): the step waits for the receipt.
      return { wait: { kind: "browser-qa", detail: { runId, taskId, startedAt: since } }, partial: { state, reply } };
    },
    poll: async (step) => {
      const detail = step.await.detail as { runId?: string; taskId?: string; startedAt?: number } | undefined;
      if (!detail?.runId || !detail.taskId) return { error: "the waiting step does not say which task's browser check it waits for" };
      const stage = listStageReceipts(db, detail.runId, detail.taskId).find((row) => row.stageId === "browser-qa");
      if (stage && TERMINAL.includes(stage.state)) {
        const result = stage.result && typeof stage.result === "object" ? stage.result as Row : undefined;
        const link = typeof result?.link === "string" ? result.link : undefined;
        return { output: { state: stage.state, reply: { runId: detail.runId, taskId: detail.taskId, state: stage.state, ...(link ? { link } : {}), stage, ...(result ? { result } : {}), ...(stage.reason ? { reason: stage.reason } : {}) } }, ...(await qaUsage(detail.runId, detail.taskId, detail.startedAt ?? 0)) };
      }
      if (Date.now() - (detail.startedAt ?? 0) > NO_VERDICT_MS) return { error: "browser_qa_no_verdict: the check left no final receipt in time" };
      return null;
    },
  } as NodeExecutor<ChainRuntime>);
}

function binding(ctx: ServerCore) {
  const found = bindings.get(ctx);
  if (!found) throw new Error("the workflow engine is not up yet");
  return found;
}

/** What the tool answers with once the run stops: the output of the node that ended it, or the first waiting step's partial; a failed run throws the step's own message. */
function stopped(summary: RunSummary): Row {
  if (summary.status === "failed") throw new Error(summary.error ?? summary.reason ?? "workflow failed");
  const output = summary.status === "waiting" ? summary.waiting[0]?.partial : summary.output;
  if (!output) throw new Error(`workflow ${summary.status}${summary.reason ? `: ${summary.reason}` : ""}`);
  return output;
}

/**
 * `lane_pilot_browser`: one goal in the owner's Chrome, as the graph `browser-step`; waits for the run (the host call has its own limit of
 * timeoutSec + 30) and answers with the text the tool always gave.
 */
export async function runBrowserStep(ctx: ServerCore, input: { projectId: string; runId: string | null; pmThreadId: string | null } & BrowserGoalInput): Promise<string> {
  const refused = refusal(input, browserHostId(ctx, input.projectId, input.runId));
  if (refused) return JSON.stringify({ status: "refused", reason: refused });
  const { engine, services } = binding(ctx);
  const workflow = builtinWorkflow(BROWSER_STEP);
  if (!workflow) throw new Error(`built-in workflow ${BROWSER_STEP} is not loaded`);
  const started = engine.start({
    workflow, inputs: { url: input.url, goal: input.goal, changes: input.changes, authorized: input.authorized, timeout_sec: input.timeoutSec },
    runtime: { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId } satisfies ChainRuntime,
    link: { projectId: input.projectId, ...(input.runId ? { runId: input.runId } : {}) },
  });
  const out = stopped(await started.done);
  const text = out.text;
  return JSON.stringify({
    hostId: out.hostId ?? null, exitCode: out.exitCode ?? null, status: out.status, url: out.url ?? null, actions: out.actions ?? null, title: out.title ?? null, log: out.log ?? "",
    ...(out.status === "refused" ? { reason: out.reason } : {}),
    text: typeof text === "string" ? fenceOutside("browser", text) : text ?? null,
  }, null, 2);
}

/**
 * `lane_pilot_browser_qa`: the graph `lp.browser-qa` runs `runBrowserQa`; the answer is its reply as before. A call that does not fit
 * (another chat's run, a task not accepted) throws the same message as before.
 */
export async function runBrowserQaGraph(ctx: ServerCore, input: { pmThreadId: string; projectId: string; runId: string; taskId: string; url: string; cases: string[]; envClass: string; viewports: string; authorized: boolean; devServer?: string | undefined }): Promise<Row> {
  const { engine, services } = binding(ctx);
  const workflow = builtinWorkflow(BROWSER_QA);
  if (!workflow) throw new Error(`built-in workflow ${BROWSER_QA} is not loaded`);
  const started = engine.start({
    workflow,
    inputs: { run_id: input.runId, task_id: input.taskId, url: input.url, cases: input.cases, env_class: input.envClass, viewports: input.viewports, authorized: input.authorized, dev_server: input.devServer ?? "" },
    runtime: { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId } satisfies ChainRuntime,
    link: { projectId: input.projectId, runId: input.runId, taskId: input.taskId },
  });
  const summary = await started.done;
  // A red verdict fails the graph run (its `verdict` step), but the tool still answers with the check's own reply, read from the `qa` step.
  const checked = summary.status === "failed" && engine.journal.steps(summary.runId).find((step) => step.node_id === "qa" && step.state === "succeeded");
  const out = checked ? JSON.parse(checked.output_json ?? "{}") as Row : stopped(summary);
  const reply = (out.reply ?? {}) as Row;
  if (out.state === "error") throw new Error(str(reply.error) || "browser check failed");
  return reply;
}
