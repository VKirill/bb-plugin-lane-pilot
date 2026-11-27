import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import { wfRunRow } from "@lane-pilot/workflow-engine";
import { z } from "zod";
import type { ServerCore } from "../../../contracts/server";
import { registerObservedTool } from "../../../platform/server";
import { builtinWorkflow } from "../../builtin";
import { saveBranch, savePath, type LoadedWorkflowSource, type SavePathDeps } from "../services/path-save";
import { createWorkflowArchitect, type WorkflowArchitect } from "../services/workflow-architect";

export const PATH_SAVE_USAGE =
  'bb lane-pilot path save <runId> [--note "<text>"] | bb lane-pilot path branch <graphId> <candidateKey> [--project <id>] [--note "<text>"]';

type ArchitectServices = Parameters<typeof createWorkflowArchitect>[1];

function resolveArchitect(
  ctx: ServerCore,
  services: Partial<ArchitectServices> | undefined,
): (Pick<WorkflowArchitect, "create" | "createFrom">) | null {
  if (!services || !("workflowEngine" in services) || !services.workflowEngine) return null;
  return createWorkflowArchitect(ctx, services as ArchitectServices);
}

/** The graph loader every path/branch save uses, so a desk answer and the PM tool resolve the same base file. */
export function resolveWorkflowLoader(
  services: Partial<ArchitectServices> | undefined,
): SavePathDeps["loadWorkflow"] {
  return async (graphId, projectId) => {
    // Publish compares the base against the file's bytes, so the hash must come from the file text (source()),
    // not from the parsed definition (StoredWorkflow.sha256), or every branch publish is a file_conflict.
    if (services?.workflowLibrary?.source) {
      const found = await services.workflowLibrary.source({ id: graphId, ...(projectId ? { projectId } : {}) });
      if (found) {
        return {
          workflow: found.workflow,
          origin: found.origin,
          path: found.path,
          fileSha256: found.fileSha256,
        } satisfies LoadedWorkflowSource;
      }
    }
    if (services?.workflowCatalog) {
      const store = await services.workflowCatalog.store().catch(() => null);
      const item = store?.get(graphId);
      if (item) {
        return {
          workflow: item.workflow,
          origin: item.origin,
          path: item.source,
          fileSha256: item.origin === "builtin" ? null : item.sha256,
        } satisfies LoadedWorkflowSource;
      }
    }
    const wf = services?.workflowEngine?.resolveWorkflow?.(graphId) ?? builtinWorkflow(graphId);
    return wf ? { workflow: wf, origin: builtinWorkflow(graphId) ? "builtin" : "global" } : null;
  };
}

/**
 * Registers the `lane_pilot_path_save` PM tool to turn a finished run or repeated branch candidate into a workflow draft.
 */
export function mountPathSaveTool(
  ctx: ServerCore,
  services?: Partial<ArchitectServices>,
): void {
  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_path_save",
    description: "Save a finished run (errand or workflow) or a repeated branch candidate as a workflow draft so it can be refined, tested and published later.",
    instructions: "Use from the active Lane Pilot PM chat. Pass `runId` (plus optional `note`) after an errand or finished run went well, or pass `branch: { graphId, candidateKey }` to open a branch draft from repeated deviations. Does not publish.",
    parameters: z.object({
      runId: z.string().min(1).max(80).optional(),
      branch: z.object({
        graphId: z.string().min(1).max(80),
        candidateKey: z.string().min(1).max(120),
      }).strict().optional(),
      note: z.string().max(2000).optional(),
    }).strict().refine((value) => Boolean(value.runId) !== Boolean(value.branch), {
      message: "provide either runId or branch",
    }),
    execute: async (params, context) => {
      if (!context.threadId || !context.projectId) {
        throw new Error("workflow_needs_pm_thread: call this from a Lane Pilot PM chat");
      }
      const architect = resolveArchitect(ctx, services);
      if (params.branch) {
        const res = await saveBranch(
          ctx,
          { architect, loadWorkflow: resolveWorkflowLoader(services) },
          {
            graphId: params.branch.graphId,
            candidateKey: params.branch.candidateKey,
            projectId: context.projectId,
            threadId: context.threadId,
            note: params.note,
          },
        );
        return JSON.stringify(res, null, 2);
      }
      const res = await savePath(
        ctx,
        { architect },
        {
          runId: params.runId!,
          note: params.note,
          projectId: context.projectId,
          threadId: context.threadId,
        },
      );
      return JSON.stringify(res, null, 2);
    },
  });
}

/**
 * Handles `bb lane-pilot path save <runId> [--note "<text>"]` and `bb lane-pilot path branch <graphId> <candidateKey>`.
 */
export async function pathSaveCli(
  ctx: ServerCore,
  services: Partial<ArchitectServices> | undefined,
  args: string[],
  invocation?: PluginCliContext,
): Promise<PluginCliResult> {
  const sub = args[0];
  if (sub !== "save" && sub !== "branch") {
    return { exitCode: 1, stderr: `usage: ${PATH_SAVE_USAGE}\n` };
  }

  const positional: string[] = [];
  let note: string | undefined;
  let explicitProjectId: string | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--note") {
      const next = args[i + 1];
      if (next === undefined) return { exitCode: 1, stderr: `usage: ${PATH_SAVE_USAGE}\n` };
      note = next;
      i += 1;
    } else if (arg.startsWith("--note=")) {
      note = arg.slice("--note=".length);
    } else if (arg === "--project") {
      const next = args[i + 1];
      if (next === undefined) return { exitCode: 1, stderr: `usage: ${PATH_SAVE_USAGE}\n` };
      explicitProjectId = next;
      i += 1;
    } else if (arg.startsWith("--project=")) {
      explicitProjectId = arg.slice("--project=".length);
    } else if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\nusage: ${PATH_SAVE_USAGE}\n` };
    } else {
      positional.push(arg);
    }
  }

  let projectId = explicitProjectId;
  if (!projectId && invocation?.threadId) {
    const thread = await orMiss(ctx.bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound);
    projectId = stringAt(thread, "projectId") ?? undefined;
  }

  const architect = resolveArchitect(ctx, services);
  if (sub === "branch") {
    if (positional.length !== 2) {
      return { exitCode: 1, stderr: `usage: ${PATH_SAVE_USAGE}\n` };
    }
    const [graphId, candidateKey] = positional as [string, string];
    const res = await saveBranch(
      ctx,
      { architect, loadWorkflow: resolveWorkflowLoader(services) },
      {
        graphId,
        candidateKey,
        ...(projectId ? { projectId } : {}),
        ...(invocation?.threadId ? { threadId: invocation.threadId } : {}),
        ...(note ? { note } : {}),
      },
    );
    if (!res.ok) {
      const detail = res.workflowId ? ` (${res.workflowId})` : "";
      return { exitCode: 1, stderr: `branch draft refused: ${res.reason}${detail}\n` };
    }
    return { exitCode: 0, stdout: `${JSON.stringify(res, null, 2)}\n` };
  }

  if (positional.length !== 1) {
    return { exitCode: 1, stderr: `usage: ${PATH_SAVE_USAGE}\n` };
  }

  const runId = positional[0]!;
  if (!projectId) {
    projectId = wfRunRow(ctx.db, runId)?.project_id ?? "";
  }

  const res = await savePath(
    ctx,
    { architect },
    {
      runId,
      note,
      projectId,
      ...(invocation?.threadId ? { threadId: invocation.threadId } : {}),
    },
  );
  if (!res.ok) {
    const detail = res.workflowId ? ` (${res.workflowId})` : "";
    return { exitCode: 1, stderr: `path save refused: ${res.reason}${detail}\n` };
  }
  return { exitCode: 0, stdout: `${JSON.stringify(res, null, 2)}\n` };
}
