import type { StoredWorkflow } from "@lane-pilot/workflow-engine";
import { diagnosisLines } from "../../models/diagnosis";
import { errandsDiagnosis } from "../services/errands-diagnosis";

export const EPISODES_USAGE = `bb lane-pilot errands diagnose [--days N] [--project ID] [--json]
  The errand diagnosis: outcomes, cost and time, failure classes, repeats, router near misses,
  skills offered but unused and fixture litter in the graph catalog.`;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

/** `bb lane-pilot errands …`: period diagnosis. */
export async function runEpisodesCli(
  deps: {
    db: Parameters<typeof errandsDiagnosis>[0];
    /** The workflow catalog store, for the fixture-litter section; absent → that section reports no data. */
    catalog?: { store(): Promise<{ list(): StoredWorkflow[] }> };
  },
  command: string,
  args: string[],
): Promise<CliResult> {
  if (command !== "diagnose") return { exitCode: 1, stderr: EPISODES_USAGE };
  let days = 7, projectId: string | undefined, json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--days" && args[index + 1] !== undefined) {
      days = Number(args[index + 1]);
      index += 1;
      if (!Number.isInteger(days) || days < 1 || days > 365) return { exitCode: 1, stderr: "--days must be an integer 1–365" };
    } else if (arg === "--project" && args[index + 1] !== undefined) {
      projectId = args[index + 1];
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      return { exitCode: 1, stderr: EPISODES_USAGE };
    }
  }
  let workflows: StoredWorkflow[] | undefined;
  try { workflows = deps.catalog ? (await deps.catalog.store()).list() : undefined; }
  catch { workflows = undefined; }
  const diagnosis = errandsDiagnosis(deps.db, { days, projectId }, workflows ? { workflows } : {});
  return { exitCode: 0, stdout: json ? `${JSON.stringify(diagnosis, null, 2)}\n` : `${diagnosisLines(diagnosis).join("\n")}\n` };
}
