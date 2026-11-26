import type { BaselineApi } from "../services/baseline-service";

export const BASELINE_USAGE = "bb lane-pilot baseline <task-id>   (the checks that were already green or red on the base the task started from, and what turned red after its merge)";

type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runBaselineCli(apis: { baseline: BaselineApi }, argv: string[]): Promise<Result> {
  try {
    if (argv.length !== 1 || argv[0]!.startsWith("-")) throw new Error(`usage:\n${BASELINE_USAGE}`);
    return { exitCode: 0, stdout: JSON.stringify({ taskId: argv[0], baselines: apis.baseline.status(argv[0]!) }, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
