import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../../contracts/server";
import {
  countRefusalsByActionClass,
  grantAutonomy,
  listAutonomyRows,
  recomputeAutonomy,
  revokeAutonomy,
} from "../repositories/sp-autonomy";

export const SPECIALIST_USAGE = [
  "bb lane-pilot specialist autonomy <project> <domain> [--json]",
  "bb lane-pilot specialist autonomy grant <project> <domain> <actionClass> [--reason <text>] [--json]",
  "bb lane-pilot specialist autonomy revoke <project> <domain> <actionClass> [--reason <text>] [--json]",
].join("\n");

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function formatAutonomyTable(
  rows: ReturnType<typeof listAutonomyRows>,
  refusals: ReturnType<typeof countRefusalsByActionClass>,
): string {
  if (rows.length === 0) return "no specialist autonomy records\n";
  const header = [
    pad("action_class", 32),
    pad("state", 14),
    pad("n", 6),
    pad("k", 6),
    pad("wilson_lb", 10),
    pad("kappa", 9),
    pad("high_risk", 10),
    pad("refusals", 9),
    "frozen_until",
  ].join(" ");
  const lines = rows.map((row) => {
    const refCount = refusals[row.action_class]?.total ?? 0;
    const frozen = row.frozen_until ? new Date(row.frozen_until).toISOString().slice(0, 10) : "-";
    return [
      pad(row.action_class, 32),
      pad(row.autonomy_class, 14),
      pad(String(row.samples_n), 6),
      pad(String(row.successes_k), 6),
      pad(row.wilson_lb.toFixed(4), 10),
      pad(row.cohen_kappa.toFixed(4), 9),
      pad(row.high_risk ? "yes" : "no", 10),
      pad(String(refCount), 9),
      frozen,
    ].join(" ");
  });
  return `${header}\n${lines.join("\n")}\n`;
}

/** Handles `bb lane-pilot specialist autonomy <project> <domain>`, `grant`, and `revoke`. */
export function runSpecialistCli(
  ctx: ServerCore,
  args: string[],
  invocation?: PluginCliContext,
): PluginCliResult {
  let jsonFlag = false;
  let reason: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      jsonFlag = true;
    } else if (arg === "--reason") {
      const next = args[i + 1];
      if (next === undefined) return { exitCode: 1, stderr: `usage:\n${SPECIALIST_USAGE}\n` };
      reason = next;
      i += 1;
    } else if (arg.startsWith("--reason=")) {
      reason = arg.slice("--reason=".length);
    } else if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\n${SPECIALIST_USAGE}\n` };
    } else {
      positional.push(arg);
    }
  }

  const head = positional[0];
  const sub = head === "autonomy" ? positional[1] : head;
  const tail = head === "autonomy" ? positional.slice(2) : positional.slice(1);

  if (sub === "grant") {
    if (invocation?.threadId) {
      return { exitCode: 1, stderr: "refused: specialist autonomy grant is the owner's alone; run it at a terminal\n" };
    }
    const [projectId, domain, actionClass] = tail;
    if (!projectId || !domain || !actionClass || tail.length !== 3) {
      return { exitCode: 1, stderr: `usage:\n${SPECIALIST_USAGE}\n` };
    }
    const res = grantAutonomy(ctx.db, { projectId, domain, actionClass, by: "owner", ...(reason ? { reason } : {}) }, ctx.bb.log);
    if (!res.ok) {
      return { exitCode: 1, stderr: `grant refused: ${res.reason}\n` };
    }
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ projectId, domain, actionClass, ...res }, null, 2)}\n` };
    }
    return { exitCode: 0, stdout: `granted ${actionClass} (${domain}) -> ${res.autonomyClass}\n` };
  }

  if (sub === "revoke") {
    const [projectId, domain, actionClass] = tail;
    if (!projectId || !domain || !actionClass || tail.length !== 3) {
      return { exitCode: 1, stderr: `usage:\n${SPECIALIST_USAGE}\n` };
    }
    const res = revokeAutonomy(ctx.db, { projectId, domain, actionClass, ...(reason ? { reason } : {}) }, ctx.bb.log);
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ projectId, domain, actionClass, ...res }, null, 2)}\n` };
    }
    return { exitCode: 0, stdout: `revoked ${actionClass} (${domain}) -> ${res.autonomyClass}\n` };
  }

  if (head === "autonomy" && positional.length === 3) {
    const [, projectId, domain] = positional as [string, string, string];
    recomputeAutonomy(ctx.db, { projectId, domain }, ctx.bb.log);
    const rows = listAutonomyRows(ctx.db, projectId, domain);
    const refusals = countRefusalsByActionClass(ctx.db, projectId, domain);
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ projectId, domain, rows, refusals }, null, 2)}\n` };
    }
    return { exitCode: 0, stdout: formatAutonomyTable(rows, refusals) };
  }

  return { exitCode: 1, stderr: `${SPECIALIST_USAGE}\n` };
}
