import { MAIN_AGENT_ID, isCustomAgentId } from "../../native-agent";
import { observeStageChild } from "@lane-pilot/thread-observe";
import { z } from "zod";
import { findOpenNativeRun, getRun } from "../../storage";
import { outputText } from "../../writer/server/writer-task";
import { fenceOutside, registerObservedTool } from "../../core/server";
import type { ServerCore, Services } from "../../core/server";
import type { ChainRuntime } from "../../workflow/server";
import type { StepContext, WorkflowEngine } from "../../workflow";
import { specialistRunOfThread, startSpecialistRun, waitSpecialistRun } from "./specialist-graph";

/** The specialists a PM may hand work to; Explore and Plan stay Claude Code subagents inside the PM session. */
export const SPECIALIST_ROLES = ["design-lead", "copy-lead", "seo-specialist", "tavily", "video-lead"] as const;
const WAIT_STEP_MS = 5_000;

export function specialistPrompt(marker: string, role: string, task: string, roleLines: readonly string[] = [], tag = "task"): string {
  return [
    marker,
    ...(roleLines.length ? ["", `Lines added to your role in this project (one dated line per review lesson):`, ...roleLines.map((line) => `- ${line}`)] : []),
    "",
    `The Lane Pilot PM of this project hands you this work as ${role}. You work in the PM's own checkout, so write only your deliverable (under .agents/, or DESIGN.md files if you are design-lead) and do not change product code, docs/, README.md or PROJECT.md: Lane Pilot's nightly docs pass owns those, and implementation goes to a writer. If the task asks for such a change, do not make it: return it as a task for a writer.`,
    "Do not commit: leave your files in place and give the PM their paths. If you need an account or key, list the names with env_list and read one with env_get; never print a value. Your final message is the PM's only view of your work: what you produced, the paths, open questions.",
    "",
    `<${tag}>`,
    task,
    `</${tag}>`,
  ].join("\n");
}

/** The `brief` step of a `specialist` run: the task and the role lines of this project; the agent step adds the profile marker and the answer contract. */
export function registerSpecialistActions(engine: WorkflowEngine, ctx: ServerCore): void {
  engine.register<ChainRuntime>("lp.specialist_brief", {
    reentrant: true,
    run: async (c: StepContext<ChainRuntime>) => {
      const role = String(c.resolve("$inputs.role") ?? ""), task = String(c.resolve("$inputs.task") ?? "");
      const lines = ((await ctx.bb.storage.kv.get(`lp.role.lines:${c.runtime?.projectId ?? ""}:${role}`).catch(() => null)) as string[] | null) ?? [];
      // The step's own <task> wraps this text, so the PM's task stands in <request>.
      const answer = "In this run your final message ends with the JSON block described below: its report field carries your whole answer to the PM (what you produced, the paths, open questions).";
      return { output: { text: `${specialistPrompt("", role, task, lines, "request").replace(/^\n+/, "")}\n\n${answer}` } };
    },
  } as never);
}

/**
 * Specialists run as child BB threads of the PM chat with their own Lane Pilot profile, so each one can be opened, read and stopped like a
 * writer. The work is a run of the built-in graph `specialist` (specialist-graph.ts); the two tools keep their names and answers.
 */
export function mountSpecialists(ctx: ServerCore, services: Services): void {
  const { bb, db } = ctx;

  async function start(input: { projectId: string; pmThreadId: string; role: string; task: string; title?: string }) {
    const runId = findOpenNativeRun(db, input.projectId, input.pmThreadId);
    const run = runId ? getRun(db, runId) : undefined;
    if (!runId || !run) throw new Error("specialist_needs_open_pm_run: call this from a Lane Pilot PM chat with an open run");
    // A bundled specialist, or an agent the owner defined (agents create): the same graph runs both.
    const owned = await ctx.ownedAgents();
    const custom = !(SPECIALIST_ROLES as readonly string[]).includes(input.role);
    if (custom && !(isCustomAgentId(input.role) && owned[input.role] && !owned[input.role]?.compiledCorrupt)) throw new Error(`unknown_specialist:${input.role} — use one of ${SPECIALIST_ROLES.join(", ")} or an agent the owner created (bb lane-pilot agents list --custom)`);
    const started = await startSpecialistRun(ctx, services, { projectId: input.projectId, pmThreadId: input.pmThreadId, runId, role: input.role, task: input.task, title: input.title ?? `${input.role}: ${input.task.slice(0, 60)}` });
    return { threadId: started.threadId, role: input.role, state: "running" as const, link: `@thread:${started.threadId}`, workflowRunId: started.workflowRunId };
  }

  /** A thread that no graph run started: a specialist that was running when the graph came in. Read as before, from the thread alone. */
  async function waitThread(input: { threadId: string; timeoutSec: number }) {
    const deadline = Date.now() + input.timeoutSec * 1000;
    let detail = "";
    while (Date.now() < deadline) {
      if (ctx.isDisposed()) break;
      const observed = await observeStageChild(bb, input.threadId, Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
      if (observed.kind === "completed") {
        const raw = (await bb.sdk.threads.output({ threadId: input.threadId })).output;
        return { threadId: input.threadId, state: "done" as const, output: fenceOutside("specialist", typeof raw === "string" ? raw : outputText(raw)) };
      }
      if (observed.kind === "product_failure") return { threadId: input.threadId, state: "failed" as const, output: fenceOutside("specialist", `${observed.via}: ${observed.detail}`) };
      detail = observed.detail;
    }
    return { threadId: input.threadId, state: "running" as const, output: fenceOutside("specialist", detail) };
  }

  registerObservedTool(bb.agents, {
    name: "lane_pilot_specialist",
    description: "Hand work to a specialist (design-lead, copy-lead, seo-specialist, tavily, video-lead, or an agent the owner created) as a child thread of this PM chat that the owner can open.",
    instructions: "Use from a Lane Pilot PM chat instead of the Agent tool for these roles; an agent the owner created is named by its id. Give the whole task: goal, context, files to read, the deliverable and where to write it. Returns at once with the thread; then call lane_pilot_wait_specialist with that threadId, again while it reports running. Show the owner the returned @thread link. Specialists never change product code; implementation still goes through lane_pilot_dispatch_writer.",
    parameters: z.object({
      role: z.string().regex(MAIN_AGENT_ID),
      task: z.string().min(1).max(20_000),
      title: z.string().min(1).max(120).optional(),
    }).strict(),
    execute: async (params, context) => {
      if (!context.threadId || !context.projectId) throw new Error("specialist_needs_pm_thread");
      return JSON.stringify(await start({ projectId: context.projectId, pmThreadId: context.threadId, role: params.role, task: params.task, title: params.title }), null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_wait_specialist",
    description: "Wait for a specialist thread started with lane_pilot_specialist and return its answer.",
    instructions: "Call with the threadId from lane_pilot_specialist (timeoutSec at most 240). While state is running, call it again.",
    parameters: z.object({ threadId: z.string().min(1), timeoutSec: z.number().int().min(5).max(240).default(240) }).strict(),
    execute: async (params, context) => {
      const runId = await specialistRunOfThread(bb, params.threadId);
      if (!runId) return JSON.stringify(await waitThread({ threadId: params.threadId, timeoutSec: params.timeoutSec }), null, 2);
      if (!context.projectId) throw new Error("specialist_needs_pm_thread");
      return JSON.stringify(await waitSpecialistRun(ctx, services, { projectId: context.projectId, runId, timeoutSec: params.timeoutSec }), null, 2);
    },
  });
}
