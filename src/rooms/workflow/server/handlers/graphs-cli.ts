import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { GRAPHS_LAST_EXPORT_AT_KEY } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { readOwnerConfigKey, writeOwnerConfigKey } from "../../../owner-waiting/server";
import { listWorkflowGitDrift } from "../../builtin";

export { GRAPHS_LAST_EXPORT_AT_KEY };

export const GRAPHS_CLI_USAGE = [
  "bb lane-pilot graphs mark-exported [--at <ms|iso>] [--json]",
  "bb lane-pilot graphs status [--json]",
].join("\n");

function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function logInfo(ctx: Pick<ServerCore, "bb" | "log">, message: string): void {
  if (ctx.bb?.log?.info) ctx.bb.log.info(message);
  else ctx.log(message);
}

/** Handles `bb lane-pilot graphs mark-exported` and `bb lane-pilot graphs status`. */
export async function graphsCli(
  ctx: Pick<ServerCore, "db" | "bb" | "log">,
  args: string[],
): Promise<PluginCliResult> {
  const jsonFlag = args.includes("--json");
  let atOverride: number | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--at") {
      const next = args[i + 1];
      if (!next) return { exitCode: 1, stderr: `--at requires a timestamp\n${GRAPHS_CLI_USAGE}\n` };
      atOverride = parseTimestamp(next);
      if (atOverride === null) return { exitCode: 1, stderr: `invalid --at timestamp: ${next}\n` };
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\n${GRAPHS_CLI_USAGE}\n` };
    }
    positional.push(arg);
  }

  const [sub, ...rest] = positional;
  if (sub === "mark-exported" && rest.length === 0) {
    const at = atOverride ?? Date.now();
    await ctx.bb?.storage?.kv?.set?.(GRAPHS_LAST_EXPORT_AT_KEY, at as never);
    writeOwnerConfigKey(ctx.db, GRAPHS_LAST_EXPORT_AT_KEY, String(at), at);
    const iso = new Date(at).toISOString();
    logInfo(ctx, `graphs.export marked at=${iso}`);
    if (jsonFlag) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, key: GRAPHS_LAST_EXPORT_AT_KEY, lastExportAt: at, iso }, null, 2)}\n`,
      };
    }
    return { exitCode: 0, stdout: `${GRAPHS_LAST_EXPORT_AT_KEY}=${iso}\n` };
  }

  if (sub === "status" && rest.length === 0) {
    const kvRaw = await ctx.bb?.storage?.kv?.get?.(GRAPHS_LAST_EXPORT_AT_KEY);
    const cfgRaw = readOwnerConfigKey(ctx.db, GRAPHS_LAST_EXPORT_AT_KEY);
    const lastExportAt = typeof kvRaw === "number" && Number.isFinite(kvRaw)
      ? kvRaw
      : cfgRaw
        ? parseTimestamp(cfgRaw)
        : null;
    const drifted = listWorkflowGitDrift(ctx.db);
    if (jsonFlag) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ lastExportAt, drifted }, null, 2)}\n`,
      };
    }
    const dateLabel = lastExportAt !== null ? new Date(lastExportAt).toISOString().slice(0, 10) : "never";
    const lines = [
      `last_export_at: ${dateLabel}`,
      ...(drifted.length
        ? drifted.map((d) => `- ${d.workflowId} v${d.version} (${d.status})`)
        : ["no hub graph drift"]),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  return { exitCode: 1, stderr: `${GRAPHS_CLI_USAGE}\n` };
}
