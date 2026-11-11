import { getAttempt, getRun, getRunWriterHost, getTaskPlan, listAttemptsForTask } from "../../storage";
import { bestEffort, sha256Hex } from "@lane-pilot/kit";
import { rec, str } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import { lpTaskPipeline, need, needLanePilot, quote } from "./workflow-chain-runtime";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import type { Services, LpTaskRuntime } from "./workflow-chain-runtime";
import { validateTaskV2 } from "../../tasks/task-v2";
import { agentPrompt, outputContract, resolveTaskQualityMode } from "@lane-pilot/workflow-engine";
import type { GraphNode, NodeExecutor, PollResult, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { runOnHost } from "@lane-pilot/host-calls";
import { TERMINAL_ATTEMPT, safeId, shortPathCriticDefault, withTaskStandard, taskContractFields } from "./workflow-task-contract";
import type { HelperUsage, LpTaskNode } from "./workflow-task-contract";
import { leadHanded } from "./workflow-human-form";
import type { WorkflowAgents } from "./workflow-agent";
import type { createTaskLinter } from "../../tasks/server";

// ---------------------------------------------------------------- lp-task: one code task through the writer pipeline

/** The `lp-task` executor: a chain's code task dispatched to the writer pipeline, or the per-task pipeline's own attempt step. */
export function registerLpTask(engine: WorkflowEngine, ctx: ServerCore, services: Services, agents: WorkflowAgents, deps: {
  runtimeOf: (c: { runtime: unknown }, runId?: string) => ChainRuntime | undefined;
  lintTask: ReturnType<typeof createTaskLinter>;
}): void {
  const { bb, db, host } = ctx;
  const { runtimeOf, lintTask } = deps;

  const pipeline = () => { const p = lpTaskPipeline(engine); if (!p) throw new Error("the lp-task pipeline executor is not registered"); return p; };
  const chainTask: NodeExecutor<ChainRuntime> = {
    reentrant: true,
    run: async (c) => {
      const rt = needLanePilot(need(c), "a code task");
      const node = c.node as LpTaskNode;
      const { contract, usage: planned } = await contractOf(c, rt, node);
      const run = getRun(db, rt.runId);
      if (!run?.writer_workspace_path) throw new Error("the run has no workspace to build in");
      const stem = sha256Hex(`${c.runId}|${c.stepKey}`).slice(0, 8);
      const picked = resolveTaskQualityMode({ contract: contract.quality_mode, node: node.quality_mode, asked: c.mode, workflow: c.workflow.quality_mode ?? null });
      if (!picked.ok) return { output: failedTask("blocked", picked.detail) };
      const task = { ...withTaskStandard(contract, node.id), id: `w${stem}-${safeId(str(contract.id) || node.id)}`, project_cwd: run.writer_workspace_path, quality_mode: picked.mode };
      const valid = validateTaskV2(task);
      if (!valid.ok) return { output: failedTask("failed", `task-v2 invalid: ${valid.errors.join("; ")}`) };
      const hostId = getRunWriterHost(db, rt.runId) ?? "";
      const lint = await bestEffort(rt.ctx.log, "workflow task lint", lintTask(rt.projectId, rt.runId, valid.task, run.writer_workspace_path, hostId, "workflow"), null);
      if (lint?.errors.length) return { output: failedTask("failed", `contract lint: ${lint.errors.map((error) => error.message).join("; ").slice(0, 600)}`) };
      // The planner's files[] are its concrete steps; passing only the objective hid them from the plan critic (Roblox T5, 2026-11-08).
      // A reentrant dispatch keeps its stored plan, including the legacy format: changing its hash would defeat duplicate detection.
      const plan = getTaskPlan(db, valid.task.id) ?? (valid.task.files?.length ? [valid.task.objective, "Planned changes:", ...valid.task.files.map((file, index) =>
        `${index + 1}. ${file.action} ${file.path}${file.target ? ` (${file.target})` : ""}: ${file.change}`)].join("\n\n") : valid.task.objective);
      const reply = await services.dispatchWriter({ threadId: rt.pmThreadId, projectId: rt.projectId, task: valid.task, plan, birth: leadHanded(engine, c.runId) ? "lead" : "workflow", criticCodeDefault: shortPathCriticDefault(c.workflow.id, picked.mode) });
      if (reply.state === "rejected" || reply.ok === false) return { output: failedTask("blocked", String(reply.reason ?? reply.hint ?? "the dispatch was rejected")) };
      const taskId = str(reply.taskId) || valid.task.id;
      // chains-end: an attempt whose row is lost (task deleted, base wiped) would wait forever; the wait gets a
      // deadline — the node's own timeout or 48 h — and the engine turns it into an explicit await_timeout.
      const deadline = Date.now() + ((node.timeoutSec ?? 48 * 3_600)) * 1000;
      return { wait: { kind: "attempt", detail: { runId: str(reply.runId) || rt.runId, taskId, files: valid.task.owns_paths }, deadline }, ...(planned ? { usage: planned } : {}) };
    },
    poll: async (step): Promise<PollResult> => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting step does not say which task it waits for" };
      const listed = listAttemptsForTask(db, detail.runId, detail.taskId);
      const latest = listed.at(-1) ? getAttempt(db, listed.at(-1)!.id) : null;
      if (!latest || !TERMINAL_ATTEMPT.includes(latest.state)) return null;
      const reason = latest.reason ?? "";
      const state = latest.state === "accepted" ? "accepted" : latest.state === "canceled" ? "cancelled" : /needs[_ -]?human/i.test(reason) ? "needs_human" : "blocked";
      const rt = runtimeOf({ runtime: undefined }, step.runId);
      const merge = state === "accepted" && rt ? await mergeFacts(rt, latest.id) : { commit: "", files: [] as string[] };
      // What the task spent: the turns of its attempts in their threads (a sticky writer's thread carries other tasks' turns too) and the helpers it
      // started inside, read once, when the task is over (attempt-usage.ts).
      const spent = await services.taskUsage(bb, db, detail.runId, detail.taskId);
      const usage: HelperUsage | undefined = spent.usage;
      return { output: { state, attempts: listed.length, merge_commit: merge.commit, files: merge.files,
        verdict: { status: state === "accepted" ? "pass" : "rework", summary: reason, findings: [], evidence: reason || state } }, ...(usage ? { usage } : {}) };
    },
  };
  const failedTask = (state: string, reason: string): Row => ({ state, attempts: 0, merge_commit: "", files: [], verdict: { status: "rework", summary: reason, findings: [], evidence: reason } });

  /** The task contract of an lp-task node: the `contract` as rendered, or one written from `contract_template` and the step's data by a planner helper. */
  async function contractOf(c: StepContext<ChainRuntime>, rt: ChainRuntime, node: LpTaskNode): Promise<{ contract: Row; usage?: HelperUsage }> {
    if (node.contract !== undefined) {
      const rendered = c.template(node.contract);
      const value = typeof rendered === "string" ? (() => { try { return JSON.parse(rendered) as unknown; } catch { return rendered; } })() : rendered;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return { contract: value as Row };
      throw new Error(`the contract of ${node.id} is not an object (got ${typeof value})`);
    }
    const template = typeof node.contract_template === "string" ? node.contract_template : JSON.stringify(node.contract_template ?? {});
    const fields = taskContractFields();
    const result = await agents.run({
      rt, workflowRunId: c.runId, stepKey: c.stepKey, nodeId: node.id, spawnKey: c.spawnKey, role: "planner", title: `contract for ${node.id}`, fields, signal: c.signal,
      prompt: agentPrompt({ workflow: c.workflow.id, node: node.id, title: `contract for ${node.id}`, role: "planner", mode: c.mode, task: `Write ONE task-v2 contract for a writer from this template and the run's artifacts. Template: ${template}\nThe repository paths come from the artifacts in the run's folder; use only real paths. Put the whole contract object in the field \`contract\`.`, inputs: c.input.with, contract: outputContract(fields), readOnly: true }),
    });
    return { contract: rec(result.output.contract), ...(result.usage ? { usage: result.usage } : {}) };
  }

  /** The merge commit of an accepted attempt (found by the trailer every merge commit carries) and the files it changed. */
  async function mergeFacts(rt: ChainRuntime, attemptId: string): Promise<{ commit: string; files: string[] }> {
    if (!rt.runId) return { commit: "", files: [] };
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId);
    if (!run?.writer_workspace_path || !hostId) return { commit: "", files: [] };
    const ran = await bestEffort(rt.ctx.log, "workflow attempt commit probe", runOnHost(host, { hostId, cwd: run.writer_workspace_path, command: `c=$(git log --all -1 --format=%H --grep=${quote(`Lane-Pilot-Attempt: ${attemptId}`)}) && echo "$c" && git show --name-only --format= "$c"`, timeoutSec: 30, timeoutMs: 45_000 }), null);
    if (!ran || ran.exitCode !== 0) return { commit: "", files: [] };
    const [commit = "", ...files] = ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return { commit, files };
  }

  // One key serves the per-task pipeline (its runtime has an attempt) and the code tasks of a chain.
  engine.register<ChainRuntime | LpTaskRuntime>("lp-task", {
    reentrant: true,
    run: (c) => ((c.runtime as { attemptId?: string } | undefined)?.attemptId !== undefined ? pipeline().run(c as StepContext<LpTaskRuntime>) : chainTask.run(c as StepContext<ChainRuntime>)),
    // A step of the per-task pipeline waits on an attempt it started itself (its detail names the attempt); a chain's code task waits on a dispatched task.
    poll: (step, extra) => (step.await.detail && "attemptId" in (step.await.detail as object)
      ? pipeline().poll!(step, extra as { runtime: LpTaskRuntime | undefined; node: GraphNode }) : chainTask.poll!(step, extra as { runtime: ChainRuntime | undefined; node: GraphNode })),
  } as NodeExecutor<ChainRuntime | LpTaskRuntime>);
}
