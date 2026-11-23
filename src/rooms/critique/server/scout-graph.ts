import { z } from "zod";
import { redactKnown } from "@lane-pilot/kit";
import { wfRunProjectId, wfRunStepThreads } from "@lane-pilot/workflow-engine";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { findOpenNativeRun, getRun, latestRunForProjectThread } from "../../storage";
import { beginWorkflowWait, fenceOutside, findThreadsByMetadata, noteWorkflowReadByPm, registerObservedTool, spawnTextId } from "../../platform/server";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import type { WorkflowEngineApi } from "../../platform/server";

interface Services {
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

export const SCOUT_GRAPH = "scout";

export type ScoutAngle = { id: string; title: string; focus: string };

/** Default 3-angle pre-plan reconnaissance matching AI Factory's parallel explore scouts. */
export const DEFAULT_SCOUT_ANGLES: readonly ScoutAngle[] = [
  {
    id: "architecture",
    title: "Architecture & entry points",
    focus: "Map affected modules, entry points, schemas/contracts, RPC/CLI/HTTP surfaces, state flow, and exact file:line anchors the goal touches.",
  },
  {
    id: "patterns",
    title: "Existing patterns & conventions",
    focus: "Find the closest existing analogous feature, helper, RPC, setting, UI pattern, and test style in this repository (with file:line) so the plan reuses existing conventions instead of inventing parallel ones.",
  },
  {
    id: "dependencies",
    title: "Dependencies, callers & verification",
    focus: "Trace upstream callers/importers of symbols to change, boundary/size/migration/SMA locks, side effects, and the exact focused verification commands (cwd + command) for task-v2.",
  },
];

const ENDED_BADLY = ["failed", "blocked", "interrupted", "canceled"];
const POLL_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const slugOf = (text: string, index: number): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || `angle-${index + 1}`;

/** Normalizes custom audit angles (strings or `{id, title, focus}`) or returns the 3 standard reconnaissance angles. */
export function normalizeScoutAngles(raw: unknown): { mode: "recon" | "audit"; angles: ScoutAngle[] } {
  const list = Array.isArray(raw) ? raw : [];
  const custom: ScoutAngle[] = [];
  for (const [index, entry] of list.slice(0, 6).entries()) {
    if (typeof entry === "string" && entry.trim()) {
      const text = entry.trim();
      const colon = text.indexOf(":");
      const title = (colon > 0 && colon <= 60 ? text.slice(0, colon) : text.slice(0, 60)).trim();
      custom.push({ id: slugOf(title, index), title, focus: text });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>;
      const focus = typeof row.focus === "string" && row.focus.trim() ? row.focus.trim() : typeof row.prompt === "string" ? row.prompt.trim() : "";
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : focus.slice(0, 60).trim();
      if (!title && !focus) continue;
      const id = typeof row.id === "string" && row.id.trim() ? slugOf(row.id.trim(), index) : slugOf(title, index);
      custom.push({ id, title: title || id, focus: focus || title });
    }
  }
  return custom.length ? { mode: "audit", angles: custom } : { mode: "recon", angles: [...DEFAULT_SCOUT_ANGLES] };
}

export function registerScoutActions(engine: WorkflowEngine): void {
  engine.register<ChainRuntime>("lp.scout_angles", {
    reentrant: true,
    run: async (c: StepContext<ChainRuntime>) => {
      const { mode, angles } = normalizeScoutAngles(c.resolve("$inputs.angles"));
      const scope = String(c.resolve("$inputs.scope") ?? "").trim();
      const filesRaw = c.resolve("$inputs.files");
      const files = Array.isArray(filesRaw) ? filesRaw.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 20) : [];
      const parts = [scope ? `scope: ${scope}` : "", files.length ? `seed files: ${files.join(", ")}` : ""].filter(Boolean);
      return { output: { mode, angle_count: angles.length, angles, context_hint: parts.join(" | ") || "(entire workspace)" } };
    },
  } as never);
}

async function scoutThreads(ctx: ServerCore, projectId: string, workflowRunId: string): Promise<Array<{ threadId: string; link: string; step?: string; state?: string }>> {
  const fromSteps = wfRunStepThreads(ctx.db, workflowRunId);
  const seen = new Set(fromSteps.map((row) => row.threadId));
  const out: Array<{ threadId: string; link: string; step?: string; state?: string }> = fromSteps.map((row) => ({
    threadId: row.threadId, link: `@thread:${row.threadId}`, step: row.stepKey, state: row.state,
  }));
  const live = await findThreadsByMetadata(ctx.bb, { lanePilotWorkflowRunId: workflowRunId }, projectId).catch(() => null);
  for (const row of live ?? []) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      out.push({ threadId: row.id, link: `@thread:${row.id}` });
    }
  }
  return out;
}

export async function waitScoutRun(ctx: ServerCore, services: Services, input: { projectId: string; workflowRunId: string; timeoutSec: number }): Promise<Record<string, unknown>> {
  const owner = wfRunProjectId(ctx.db, input.workflowRunId, SCOUT_GRAPH);
  if (owner !== input.projectId) throw new Error(`not_found: no scout run "${input.workflowRunId}" in this project`);
  const endWait = beginWorkflowWait(input.workflowRunId);
  try {
  const deadline = Date.now() + input.timeoutSec * 1000;
  for (;;) {
    const summary = services.workflowEngine.get(input.workflowRunId);
    if (summary?.status === "succeeded") {
      noteWorkflowReadByPm(input.workflowRunId);
      const threads = await scoutThreads(ctx, input.projectId, input.workflowRunId);
      const output = (summary.output ?? {}) as Record<string, unknown>;
      return {
        workflowRunId: input.workflowRunId,
        state: "done",
        mode: output.mode ?? "recon",
        angleCount: output.angle_count ?? 0,
        status: output.status ?? "done",
        threads,
        output: fenceOutside("scout", redactKnown(JSON.stringify(output, null, 2))),
      };
    }
    if (summary && ENDED_BADLY.includes(summary.status)) {
      noteWorkflowReadByPm(input.workflowRunId);
      const threads = await scoutThreads(ctx, input.projectId, input.workflowRunId);
      return { workflowRunId: input.workflowRunId, state: "failed", threads, error: fenceOutside("scout", summary.error ?? summary.reason ?? summary.status) };
    }
    if (!summary || Date.now() >= deadline || ctx.isDisposed()) {
      const threads = await scoutThreads(ctx, input.projectId, input.workflowRunId);
      return {
        workflowRunId: input.workflowRunId,
        state: "running",
        threads,
        next: `Call lane_pilot_helpers {action:"wait_scout", workflowRunId:"${input.workflowRunId}"} to collect the synthesized report.`,
      };
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  } finally { endWait(); }
}

const angleInputSchema = z.union([
  z.string().trim().min(1).max(2000),
  z.object({
    id: z.string().trim().min(1).max(60).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    focus: z.string().trim().min(1).max(2000),
  }).strict(),
]);

export function mountScouts(ctx: ServerCore, services: Services): void {
  const { bb, db } = ctx;

  registerObservedTool(bb.agents, {
    name: "lane_pilot_scout",
    description: "Run the `scout` graph: 3 parallel read-only scouts (architecture, patterns, dependencies) before planning, or 2-6 custom parallel audit angles.",
    instructions: "Omit `angles` for 3-angle pre-plan reconnaissance, or pass 2-6 custom angles; returns `done` with `output` and `@thread` links, or `running` for `wait_scout`.",
    parameters: z.object({
      goal: z.string().trim().min(1).max(8000),
      scope: z.string().trim().max(1000).optional(),
      files: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
      angles: z.array(angleInputSchema).min(1).max(6).optional(),
      waitSec: z.number().int().min(0).max(240).default(180),
    }).strict(),
    execute: async (params, context) => {
      if (!context.threadId || !context.projectId) throw new Error("scout_needs_pm_thread");
      const runId = findOpenNativeRun(db, context.projectId, context.threadId) ?? latestRunForProjectThread(db, context.projectId, context.threadId)?.id;
      if (!runId || !getRun(db, runId)) throw new Error("scout_needs_open_pm_run: call this from a Lane Pilot PM chat with an open run");
      const workflow = services.workflowEngine.resolveWorkflow(SCOUT_GRAPH);
      if (!workflow) throw new Error(`built-in workflow ${SCOUT_GRAPH} is not loaded`);
      const inputs = { goal: params.goal, scope: params.scope ?? "", files: params.files ?? [], angles: params.angles ?? [] };
      const key = `scout:${runId}:${spawnTextId(JSON.stringify(inputs))}`;
      const begin = (idem: string) => services.workflowEngine.start({
        workflow, inputs, key: idem,
        runtime: { ctx, services, pmThreadId: context.threadId!, projectId: context.projectId!, runId },
        link: { projectId: context.projectId!, runId },
      });
      let started = begin(key);
      if (!started.created && ENDED_BADLY.includes(services.workflowEngine.get(started.runId)?.status ?? "")) started = begin(`${key}:${Date.now()}`);
      started.done.catch((cause: unknown) => ctx.log(`Lane Pilot scout run ${started.runId} stopped with an error: ${cause instanceof Error ? cause.message : String(cause)}`));
      return JSON.stringify(await waitScoutRun(ctx, services, { projectId: context.projectId, workflowRunId: started.runId, timeoutSec: params.waitSec }), null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_wait_scout",
    description: "Wait for a parallel `scout` graph run started with lane_pilot_scout and return its synthesized report.",
    instructions: "Pass `workflowRunId` when `scout` returned `running`.",
    parameters: z.object({
      workflowRunId: z.string().min(1).max(80),
      timeoutSec: z.number().int().min(5).max(240).default(180),
    }).strict(),
    execute: async (params, context) => {
      if (!context.projectId) throw new Error("scout_needs_pm_thread");
      return JSON.stringify(await waitScoutRun(ctx, services, { projectId: context.projectId, workflowRunId: params.workflowRunId, timeoutSec: params.timeoutSec }), null, 2);
    },
  });
}
