import { observeStageChild } from "@lane-pilot/thread-observe";
import { z } from "zod";
import { findOpenNativeRun, getRun } from "../database";
import { writerExecutionSelection } from "../jev-reasoning";
import { mentionContext } from "../native-dispatch";
import { fullAccessSpawn } from "./pm-spawn";
import { storeNativeSelection } from "./native-profile";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "./run-routing";
import { stringAt } from "./values";
import { outputText } from "./writer-task";
import type { ServerCore } from "./core";

/** The specialists a PM may hand work to; Explore and Plan stay Claude Code subagents inside the PM session. */
export const SPECIALIST_ROLES = ["design-lead", "copy-lead", "seo-specialist", "tavily"] as const;
const SPECIALIST_MODEL = "claude-opus-5-5";
const WAIT_STEP_MS = 5_000;

function specialistPrompt(marker: string, role: string, task: string): string {
  return [
    marker,
    "",
    `The Lane Pilot PM of this project hands you this work as ${role}. Work in this checkout. Do not change product code:`,
    "write your deliverable where your profile says (under .agents/), then end with a short summary of what you produced and the paths.",
    "",
    "<task>",
    task,
    "</task>",
  ].join("\n");
}

/**
 * Specialists run as child BB threads of the PM chat with their own Lane Pilot profile, so each one can be opened,
 * read and stopped like a writer. Before this they were Claude Code subagents: BB showed only «a background agent
 * is running» and nobody could look inside.
 */
export function mountSpecialists(ctx: ServerCore): void {
  const { bb, db } = ctx;

  async function start(input: { projectId: string; pmThreadId: string; role: (typeof SPECIALIST_ROLES)[number]; task: string; title?: string }) {
    const runId = findOpenNativeRun(db, input.projectId, input.pmThreadId);
    const run = runId ? getRun(db, runId) : undefined;
    if (!runId || !run) throw new Error("specialist_needs_open_pm_run: call this from a Lane Pilot PM chat with an open run");
    const pm = await bb.sdk.threads.get({ threadId: input.pmThreadId });
    const environmentId = stringAt(pm, "environmentId");
    if (!environmentId) throw new Error("specialist_needs_pm_environment");
    const { selection } = await storeNativeSelection(ctx, { projectId: input.projectId, agentId: input.role, parentRunId: runId });
    const helperPolicy = requireHelperSpawn({ bb, db, projectId: input.projectId, runId });
    const placement = await helperChildPlacement({ bb, db, projectId: input.projectId, runId, role: "specialist", taskTitle: input.title ?? `${input.role}: ${input.task.slice(0, 60)}` });
    const spawned = await fullAccessSpawn(bb, {
      ...placement,
      ...requiredPolicyField(bb, helperPolicy, "claude-code"),
      ...writerExecutionSelection("claude-code", SPECIALIST_MODEL, "high", null),
      prompt: specialistPrompt(mentionContext(selection), input.role, input.task),
      environment: { type: "reuse", environmentId },
      pluginMetadata: { role: "specialist", specialist: input.role, lanePilotRunId: runId, parentPmThreadId: input.pmThreadId, helperMode: helperPolicy.mode },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("specialist_thread_id_missing");
    return { threadId, role: input.role, state: "running" as const, link: `@thread:${threadId}` };
  }

  async function wait(input: { threadId: string; timeoutSec: number }) {
    const deadline = Date.now() + input.timeoutSec * 1000;
    let detail = "";
    while (Date.now() < deadline) {
      if (ctx.isDisposed()) break;
      const observed = await observeStageChild(bb, input.threadId, Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
      if (observed.kind === "completed") {
        const raw = (await bb.sdk.threads.output({ threadId: input.threadId })).output;
        return { threadId: input.threadId, state: "done" as const, output: typeof raw === "string" ? raw : outputText(raw) };
      }
      if (observed.kind === "product_failure") return { threadId: input.threadId, state: "failed" as const, output: `${observed.via}: ${observed.detail}` };
      detail = observed.detail;
    }
    return { threadId: input.threadId, state: "running" as const, output: detail };
  }

  bb.agents.registerTool({
    name: "lane_pilot_specialist",
    description: "Hand work to a specialist (design-lead, copy-lead, seo-specialist, tavily) as a child thread of this PM chat that the owner can open.",
    instructions: "Use from a Lane Pilot PM chat instead of the Agent tool for these four roles. Give the whole task: goal, context, files to read, the deliverable and where to write it. Returns at once with the thread; then call lane_pilot_wait_specialist with that threadId, again while it reports running. Show the owner the returned @thread link. Specialists never change product code; implementation still goes through lane_pilot_dispatch_writer.",
    parameters: z.object({
      role: z.enum(SPECIALIST_ROLES),
      task: z.string().min(1).max(20_000),
      title: z.string().min(1).max(120).optional(),
    }).strict(),
    execute: async (params, context) => {
      if (!context.threadId || !context.projectId) throw new Error("specialist_needs_pm_thread");
      return JSON.stringify(await start({ projectId: context.projectId, pmThreadId: context.threadId, role: params.role, task: params.task, title: params.title }), null, 2);
    },
  });

  bb.agents.registerTool({
    name: "lane_pilot_wait_specialist",
    description: "Wait for a specialist thread started with lane_pilot_specialist and return its answer.",
    instructions: "Call with the threadId from lane_pilot_specialist (timeoutSec at most 240). While state is running, call it again.",
    parameters: z.object({ threadId: z.string().min(1), timeoutSec: z.number().int().min(5).max(240).default(240) }).strict(),
    execute: async (params) => JSON.stringify(await wait({ threadId: params.threadId, timeoutSec: params.timeoutSec }), null, 2),
  });
}
