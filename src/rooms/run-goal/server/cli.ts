import type { RunGoalApi } from "./run-goal";

export const RUN_GOAL_USAGE = "bb lane-pilot run-goal <run-id> | --sweep | --status <run-id>   (every accepted task's checks together on the final main)";
type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runRunGoalCli(api: RunGoalApi, argv: readonly string[]): Promise<Result> {
  try {
    if (argv[0] === "--sweep" && argv.length === 1) return { exitCode: 0, stdout: JSON.stringify(await api.sweep(), null, 2) };
    if (argv[0] === "--status" && argv.length === 2) return { exitCode: 0, stdout: JSON.stringify(api.status(argv[1]!), null, 2) };
    if (argv.length === 1 && !argv[0]!.startsWith("--")) {
      const record = await api.check(argv[0]!);
      return { exitCode: record.state === "failed" ? 1 : 0, stdout: JSON.stringify(record, null, 2) };
    }
    return { exitCode: 1, stderr: RUN_GOAL_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
