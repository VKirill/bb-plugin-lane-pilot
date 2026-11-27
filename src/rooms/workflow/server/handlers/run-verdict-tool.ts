import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { OWNER_REFUSAL_REASONS, RUN_VERDICTS } from "@lane-pilot/contracts";
import { z } from "zod";
import type { ServerCore } from "../../../contracts/server";
import { registerObservedTool } from "../../../platform/server";
import { recordOwnerRunVerdict } from "../services/run-verdict";

export const RUN_VERDICT_USAGE = "bb lane-pilot run-verdict <runId> accept|reject [--reason <r>] [--note \"<text>\"]";

/**
 * Registers the `lane_pilot_run_verdict` PM tool so the PM can record the owner's verdict on a finished workflow run.
 */
export function mountRunVerdictTool(ctx: ServerCore): void {
  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_run_verdict",
    description: "Record the owner's accept or reject verdict on a finished workflow run — only after the owner said it in this chat.",
    instructions: "Use only from the active Lane Pilot PM chat and only after the owner explicitly accepted or rejected a finished workflow run in this chat. Pass `runId`, `verdict` (`accept` or `reject`), optional refusal `reason` (`wrong_result|too_costly|off_brand|bad_timing|unsafe|other`), and optional short `note`.",
    parameters: z.object({
      runId: z.string().min(1).max(80),
      verdict: z.enum(RUN_VERDICTS),
      reason: z.enum(OWNER_REFUSAL_REASONS).optional(),
      note: z.string().max(2000).optional(),
    }).strict(),
    execute: async (params, context) => {
      if (!context.threadId || !context.projectId) {
        throw new Error("workflow_needs_pm_thread: call this from a Lane Pilot PM chat");
      }
      const res = recordOwnerRunVerdict(
        ctx.db,
        {
          runId: params.runId,
          verdict: params.verdict,
          reason: params.reason,
          note: params.note,
          projectId: context.projectId,
        },
        ctx.bb.log,
      );
      if (!res.ok) return JSON.stringify({ status: "refused", runId: params.runId, reason: res.reason }, null, 2);
      return JSON.stringify({ status: "recorded", verdict: res.row }, null, 2);
    },
  });
}

/**
 * Handles `bb lane-pilot run-verdict <runId> accept|reject [--reason <r>] [--note "<text>"]`.
 */
export function runVerdictCli(ctx: ServerCore, args: string[]): PluginCliResult {
  const positional: string[] = [];
  let reason: string | undefined;
  let note: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--reason") {
      const next = args[i + 1];
      if (next === undefined) return { exitCode: 1, stderr: `usage: ${RUN_VERDICT_USAGE}\n` };
      reason = next;
      i += 1;
    } else if (arg.startsWith("--reason=")) {
      reason = arg.slice("--reason=".length);
    } else if (arg === "--note") {
      const next = args[i + 1];
      if (next === undefined) return { exitCode: 1, stderr: `usage: ${RUN_VERDICT_USAGE}\n` };
      note = next;
      i += 1;
    } else if (arg.startsWith("--note=")) {
      note = arg.slice("--note=".length);
    } else if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\nusage: ${RUN_VERDICT_USAGE}\n` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    return { exitCode: 1, stderr: `usage: ${RUN_VERDICT_USAGE}\n` };
  }

  const [runId, verdict] = positional as [string, string];
  const res = recordOwnerRunVerdict(ctx.db, { runId, verdict, reason, note }, ctx.bb.log);
  if (!res.ok) return { exitCode: 1, stderr: `run verdict refused: ${res.reason}\n` };
  return { exitCode: 0, stdout: `${JSON.stringify(res.row, null, 2)}\n` };
}
