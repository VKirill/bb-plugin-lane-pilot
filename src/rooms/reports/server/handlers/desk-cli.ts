import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../../contracts/server";
import { createWorkflowArchitect, resolveWorkflowLoader, type WorkflowArchitect } from "../../../workflow/server";
import { composeReviewDesk } from "../services/review-desk";
import { acceptDeskDefaults, answerDeskItem, type DeskAnswerDeps } from "../services/review-desk-answers";

export const DESK_USAGE = [
  "bb lane-pilot desk show [--json]",
  "bb lane-pilot desk answer <itemId> <option…> [--reason <text>] [--json]",
  "bb lane-pilot desk accept-defaults [--json]",
].join("\n");

type ArchitectServices = Parameters<typeof createWorkflowArchitect>[1];

function resolveArchitect(
  ctx: ServerCore,
  services: Partial<ArchitectServices> | undefined,
): Partial<Pick<WorkflowArchitect, "create" | "createFrom" | "publish">> | undefined {
  if (!services || !("workflowEngine" in services) || !services.workflowEngine) return undefined;
  return createWorkflowArchitect(ctx, services as ArchitectServices);
}

/** Handles `bb lane-pilot desk show|answer|accept-defaults`. */
export async function runDeskCli(
  ctx: ServerCore,
  services: Partial<ArchitectServices> | undefined,
  args: string[],
  invocation?: PluginCliContext,
  extraDeps?: Partial<DeskAnswerDeps>,
): Promise<PluginCliResult> {
  let jsonFlag = false;
  let reason: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      jsonFlag = true;
    } else if (arg === "--reason") {
      const next = args[i + 1];
      if (next === undefined) return { exitCode: 1, stderr: `usage:\n${DESK_USAGE}\n` };
      reason = next;
      i += 1;
    } else if (arg.startsWith("--reason=")) {
      reason = arg.slice("--reason=".length);
    } else if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\n${DESK_USAGE}\n` };
    } else {
      positional.push(arg);
    }
  }

  const sub = positional[0];
  if (!sub || sub === "show") {
    if (positional.length > 1) return { exitCode: 1, stderr: `usage:\n${DESK_USAGE}\n` };
    const desk = composeReviewDesk(ctx.db, { log: ctx.bb.log, ...extraDeps?.composeDeps });
    if (jsonFlag) return { exitCode: 0, stdout: `${JSON.stringify(desk, null, 2)}\n` };
    return { exitCode: 0, stdout: `${desk.text}\n` };
  }

  if (invocation?.threadId) {
    return { exitCode: 1, stderr: "refused: desk decisions are the owner's alone; run at a terminal\n" };
  }

  const architect = extraDeps?.architect ?? resolveArchitect(ctx, services);
  const answerDeps: DeskAnswerDeps = {
    bb: ctx.bb,
    log: ctx.bb.log,
    ...(reason ? { reason } : {}),
    ...(architect ? { architect } : {}),
    loadWorkflow: resolveWorkflowLoader(services),
    ...extraDeps,
  };

  if (sub === "answer") {
    const itemId = positional[1];
    const option = positional.slice(2).join(" ").trim();
    if (!itemId || !option) return { exitCode: 1, stderr: `usage:\n${DESK_USAGE}\n` };
    const res = await answerDeskItem(ctx.db, { itemId, option }, answerDeps);
    if (!res.ok) {
      return { exitCode: 1, stderr: `desk answer refused: ${res.reason}\n` };
    }
    if (jsonFlag) return { exitCode: 0, stdout: `${JSON.stringify(res, null, 2)}\n` };
    return { exitCode: 0, stdout: `desk answered ${res.itemId}: ${res.option}${res.detail ? ` (${res.detail})` : ""}\n` };
  }

  if (sub === "accept-defaults") {
    if (positional.length > 1) return { exitCode: 1, stderr: `usage:\n${DESK_USAGE}\n` };
    const res = await acceptDeskDefaults(ctx.db, answerDeps);
    if (jsonFlag) return { exitCode: 0, stdout: `${JSON.stringify(res, null, 2)}\n` };
    return { exitCode: 0, stdout: `desk accept-defaults (${res.week}): applied=${res.applied} kept=${res.kept} failed=${res.failed.length}\n` };
  }

  return { exitCode: 1, stderr: `${DESK_USAGE}\n` };
}
