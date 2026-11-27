import type { PluginCliResult } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../../contracts/server";
import { caseCounts, rotateHeldOut } from "../repositories/case-repository";
import { approveHypothesis, rejectHypothesis, type DecideDeps } from "../services/decide";

export type EvolveCliServices = {
  evolvePublishDraft?: DecideDeps["publishDraft"];
};

export const EVOLVE_USAGE = [
  "bb lane-pilot evolve cases <workflowId> [--json]",
  "bb lane-pilot evolve rotate <workflowId> <caseId…> [--json]",
  "bb lane-pilot evolve approve <hypothesisId> [--json]",
  "bb lane-pilot evolve reject <hypothesisId> [--json]",
].join("\n");

/** Handles `bb lane-pilot evolve cases|rotate|approve|reject`. */
export async function runEvolveCli(
  ctx: ServerCore,
  args: string[],
  services?: EvolveCliServices,
): Promise<PluginCliResult> {
  const jsonFlag = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const unknownFlag = positional.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    return { exitCode: 1, stderr: `unknown option ${unknownFlag}\n${EVOLVE_USAGE}\n` };
  }

  const [sub, targetId, ...rest] = positional;
  if (sub === "cases" && targetId && rest.length === 0) {
    const counts = caseCounts(ctx.db, targetId);
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ workflowId: targetId, ...counts }, null, 2)}\n` };
    }
    return {
      exitCode: 0,
      stdout: `evolve cases wf=${targetId}: held_out=${counts.heldOut}, working=${counts.working}\n`,
    };
  }

  if (sub === "rotate" && targetId && rest.length > 0) {
    const res = rotateHeldOut(ctx.db, { workflowId: targetId, caseIds: rest, by: "owner" }, ctx.bb.log);
    if (!res.ok) {
      return { exitCode: 1, stderr: `evolve rotate refused: ${res.reason}\n` };
    }
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ workflowId: targetId, rotated: res.rotated }, null, 2)}\n` };
    }
    return {
      exitCode: 0,
      stdout: `evolve rotated wf=${targetId}: ${res.rotated} case(s)\n`,
    };
  }

  if (sub === "approve" && targetId && rest.length === 0) {
    const res = await approveHypothesis(
      { db: ctx.db, bb: ctx.bb, log: ctx.bb.log },
      { publishDraft: services?.evolvePublishDraft },
      { hypothesisId: targetId },
    );
    if (!res.ok) {
      return { exitCode: 1, stderr: `evolve approve refused: ${res.reason}\n` };
    }
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ hypothesisId: targetId, ...res }, null, 2)}\n` };
    }
    const extra = res.trialId ? ` trial=${res.trialId}` : res.version !== undefined ? ` version=${res.version}` : "";
    return {
      exitCode: 0,
      stdout: `evolve approved hyp=${targetId} mode=${res.mode}${extra}\n`,
    };
  }

  if (sub === "reject" && targetId && rest.length === 0) {
    const res = rejectHypothesis(
      { db: ctx.db, bb: ctx.bb, log: ctx.bb.log },
      {},
      { hypothesisId: targetId },
    );
    if (!res.ok) {
      return { exitCode: 1, stderr: `evolve reject refused: ${res.reason}\n` };
    }
    if (jsonFlag) {
      return { exitCode: 0, stdout: `${JSON.stringify({ hypothesisId: targetId, ...res }, null, 2)}\n` };
    }
    return {
      exitCode: 0,
      stdout: `evolve rejected hyp=${targetId}\n`,
    };
  }

  return { exitCode: 1, stderr: `${EVOLVE_USAGE}\n` };
}
