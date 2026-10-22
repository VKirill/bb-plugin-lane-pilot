import type { BaselineApi } from "./baseline";
import type { RegressionApi } from "./regress";

export const BASELINE_USAGE = [
  "bb lane-pilot regress [project-id] [--dry-run] [--plan] [--force] [--last N] [--days K]   (the last accepted tasks' cheap checks on current main, in a throwaway worktree; a check green at acceptance and red now is confirmed at its merge commit and bisected to the first bad commit and its task; --plan only picks, --dry-run writes nothing; nothing is ever reverted)",
  "bb lane-pilot regressions [project-id] [--all]   (the regression findings still open, with the culprit commit, its task and the evidence)",
  "bb lane-pilot regress-close <id> <reason...>   (settle a finding by hand)",
  "bb lane-pilot baseline <task-id>   (the checks that were already green or red on the base the task started from, and what turned red after its merge)",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

const FLAGS = { "--dry-run": "dryRun", "--plan": "plan", "--force": "force", "--all": "all" } as const;

/** Reads `--last N` / `--days K` out of the words; returns the rest. */
function takeNumbers(argv: string[]): { rest: string[]; last?: number; days?: number } {
  const rest: string[] = [];
  const out: { last?: number; days?: number } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === "--last" || word === "--days") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${word} needs a whole number`);
      out[word === "--last" ? "last" : "days"] = value;
      index += 1;
    } else rest.push(word);
  }
  return { rest, ...out };
}

export async function runBaselineCli(apis: { baseline: BaselineApi; regression: RegressionApi }, command: "regress" | "regressions" | "regress-close" | "baseline", argv: string[]): Promise<Result> {
  try {
    const { rest, last, days } = takeNumbers(argv);
    const flags = rest.filter((word) => word.startsWith("--"));
    const words = rest.filter((word) => !word.startsWith("--"));
    const allowed = command === "regress" ? ["--dry-run", "--plan", "--force"] : command === "regressions" ? ["--all"] : [];
    if (flags.some((flag) => !allowed.includes(flag)) || ((last !== undefined || days !== undefined) && command !== "regress")) throw new Error(`usage:\n${BASELINE_USAGE}`);
    const on = (flag: keyof typeof FLAGS) => flags.includes(flag);
    if (command === "regress") {
      if (words.length > 1) throw new Error(`usage:\n${BASELINE_USAGE}`);
      const result = await apis.regression.run({ projectId: words[0], lastN: last, days, dryRun: on("--dry-run"), plan: on("--plan"), force: on("--force") });
      // Exit 1 when something is red now, so a script can tell.
      const red = result.projects.some((project) => project.findings.some((finding) => finding.kind === "regression"));
      return { exitCode: red ? 1 : 0, stdout: JSON.stringify(result, null, 2) };
    }
    if (command === "regressions") {
      if (words.length > 1) throw new Error(`usage:\n${BASELINE_USAGE}`);
      return { exitCode: 0, stdout: JSON.stringify(apis.regression.list({ projectId: words[0], all: on("--all") }), null, 2) };
    }
    if (command === "regress-close") {
      const id = Number(words[0]);
      if (!Number.isInteger(id) || words.length < 2) throw new Error(`usage:\n${BASELINE_USAGE}`);
      const closed = apis.regression.close(id, words.slice(1).join(" "));
      return { exitCode: closed.ok ? 0 : 1, stdout: JSON.stringify(closed, null, 2) };
    }
    if (words.length !== 1) throw new Error(`usage:\n${BASELINE_USAGE}`);
    return { exitCode: 0, stdout: JSON.stringify({ taskId: words[0], baselines: apis.baseline.status(words[0]!) }, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
