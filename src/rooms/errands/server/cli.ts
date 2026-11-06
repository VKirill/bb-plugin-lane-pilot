import { episodesBackfill, type EpisodeEnrichDeps } from "../episode-enrich";

export const EPISODES_USAGE = `bb lane-pilot errands episodes-backfill [--limit N]
  Phase-A episode rows for past errand runs that have none (the same recorder the completion hook uses);
  every run of a process with 3+ runs goes first, then the other outcomes. Prints the selection bias.`;

/** `bb lane-pilot errands …`: the episode backfill is the only errands CLI today. */
export async function runEpisodesCli(
  deps: Pick<EpisodeEnrichDeps, "db" | "readEvents" | "log" | "warn">,
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  if (command !== "episodes-backfill") return { exitCode: 1, stderr: EPISODES_USAGE };
  let limit = 30;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--limit" && args[index + 1] !== undefined) {
      limit = Number(args[index + 1]);
      index += 1;
      if (!Number.isFinite(limit) || limit < 1) return { exitCode: 1, stderr: "--limit must be a positive number" };
    } else {
      return { exitCode: 1, stderr: EPISODES_USAGE };
    }
  }
  const result = await episodesBackfill(deps as EpisodeEnrichDeps, { limit });
  const line = `picked ${result.picked} of ${result.total}: groups ${result.groups}, failed ${result.failed}, single ${result.single}`;
  return { exitCode: 0, stdout: `${line}\n${JSON.stringify({ ...result, bias: line }, null, 2)}` };
}
