import type { StoredWorkflow } from "@lane-pilot/workflow-engine";
import { diagnosisLines, errandsDiagnosis } from "../diagnosis";
import { episodesBackfill, sweepErrandEpisodes, type EpisodeEnrichDeps } from "../episode-enrich";

export const EPISODES_USAGE = `bb lane-pilot errands episodes-backfill [--limit N]
  Phase-A episode rows for past errand runs that have none (the same recorder the completion hook uses);
  every run of a process with 3+ runs goes first, then the other outcomes. Prints the selection bias.
bb lane-pilot errands episodes-sweep [--limit N]
  The hourly enrichment pass now, over up to N pending episodes (default 10, max 200): the same model, mask and Jev.
bb lane-pilot errands diagnose [--days N] [--project ID] [--json]
  The errand diagnosis: outcomes, cost and time, failure classes, repeats, router near misses,
  skills offered but unused and fixture litter in the graph catalog.`;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

/** `bb lane-pilot errands …`: the episode backfill and the period diagnosis. */
export async function runEpisodesCli(
  deps: Pick<EpisodeEnrichDeps, "db" | "readEvents" | "log" | "warn"> & {
    /** The workflow catalog store, for the fixture-litter section; absent → that section reports no data. */
    catalog?: { store(): Promise<{ list(): StoredWorkflow[] }> };
    /** The live sweep deps (model, Jev); absent → `episodes-sweep` refuses. */
    sweepDeps?: () => EpisodeEnrichDeps;
  },
  command: string,
  args: string[],
): Promise<CliResult> {
  if (command === "diagnose") {
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
  if (command !== "episodes-backfill" && command !== "episodes-sweep") return { exitCode: 1, stderr: EPISODES_USAGE };
  let limit = command === "episodes-sweep" ? 10 : 30;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--limit" && args[index + 1] !== undefined) {
      limit = Number(args[index + 1]);
      index += 1;
      if (!Number.isFinite(limit) || limit < 1) return { exitCode: 1, stderr: "--limit must be a positive number" };
    } else {
      return { exitCode: 1, stderr: EPISODES_USAGE };
    }
  }
  if (command === "episodes-sweep") {
    if (!deps.sweepDeps) return { exitCode: 1, stderr: "episodes-sweep: no live sweep here" };
    const swept = await sweepErrandEpisodes(deps.sweepDeps(), Math.min(limit, 200));
    return { exitCode: 0, stdout: `episodes: ${swept.enriched} enriched, ${swept.skipped} skipped, ${swept.failed} failed, ${swept.held} held of ${swept.picked} picked\n` };
  }
  const result = await episodesBackfill(deps as EpisodeEnrichDeps, { limit });
  const line = `picked ${result.picked} of ${result.total}: groups ${result.groups}, failed ${result.failed}, single ${result.single}`;
  return { exitCode: 0, stdout: `${line}\n${JSON.stringify({ ...result, bias: line }, null, 2)}` };
}
