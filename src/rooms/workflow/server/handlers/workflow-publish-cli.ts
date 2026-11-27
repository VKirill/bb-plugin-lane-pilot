import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../../contracts/server";
import { createDraftStore } from "../../../storage";
import { grantOwner, publishGateLog } from "../services/publish-gate";
import { createWorkflowArchitect } from "../services/workflow-architect";

export const WORKFLOW_PUBLISH_USAGE = "bb lane-pilot workflow publish <draftId> --owner [--json]";

type ArchitectServices = Parameters<typeof createWorkflowArchitect>[1];

/** Handles `bb lane-pilot workflow publish <draftId> --owner [--json]` from the owner's terminal. */
export async function workflowPublishCli(
  ctx: ServerCore,
  services: Partial<ArchitectServices> | undefined,
  args: string[],
  invocation?: PluginCliContext,
): Promise<PluginCliResult> {
  if (invocation?.threadId) {
    return { exitCode: 1, stderr: "workflow publish refused: --owner is only for the owner's terminal, not an agent thread\n" };
  }

  const jsonFlag = args.includes("--json");
  const ownerFlag = args.includes("--owner");
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json" || arg === "--owner") continue;
    if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\nusage: ${WORKFLOW_PUBLISH_USAGE}\n` };
    }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    return { exitCode: 1, stderr: `usage: ${WORKFLOW_PUBLISH_USAGE}\n` };
  }
  const draftId = positional[0]!;
  if (!ownerFlag) {
    return { exitCode: 1, stderr: `workflow publish refused: pass --owner to confirm\nusage: ${WORKFLOW_PUBLISH_USAGE}\n` };
  }

  const draft = createDraftStore(ctx.db).get(draftId);
  if (!draft) {
    return { exitCode: 1, stderr: `workflow publish refused: draft ${draftId} not found\n` };
  }

  grantOwner(ctx.db, draft.id, "cli", { log: publishGateLog(ctx) });
  const architect = createWorkflowArchitect(ctx, {
    workflowEngine: services?.workflowEngine ?? ({ hasExecutor: () => false } as never),
    ...(services?.workflowCatalog ? { workflowCatalog: services.workflowCatalog } : {}),
    ...(services?.workflowTriggers ? { workflowTriggers: services.workflowTriggers } : {}),
    ...(services?.workflowLibrary ? { workflowLibrary: services.workflowLibrary } : {}),
  });
  const result = await architect.publish({
    projectId: draft.projectId,
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    draftId: draft.id,
  });

  if (jsonFlag) {
    return { exitCode: result.published ? 0 : 1, stdout: `${JSON.stringify(result, null, 2)}\n` };
  }
  if (!result.published) {
    const reason = String((result as { reason?: unknown }).reason ?? "publish_refused");
    return { exitCode: 1, stderr: `workflow publish refused: ${reason}\n` };
  }
  const version = (result as { workflowVersion?: unknown }).workflowVersion ?? "";
  const path = (result as { path?: unknown }).path ?? "";
  return { exitCode: 0, stdout: `published ${draft.workflowId} v${version}${path ? ` (${path})` : ""}\n` };
}
