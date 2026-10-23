import { settingsPair } from "../logic";
import type { HypothesesApi } from "./hypotheses";

export const HYPOTHESIS_USAGE = [
  "bb lane-pilot hypothesis list",
  "bb lane-pilot hypothesis add --title \"…\" --source <url or reference> --setting key=value [--setting …]",
  "bb lane-pilot hypothesis test <id> [--set vN] [--tasks N]   (starts the baseline arm and the hypothesis arm on the bench set)",
  "bb lane-pilot hypothesis verdict <id>                        (compares the arms; not worse → the night policy applies it or holds it)",
  "bb lane-pilot hypothesis revert <id>                         (an adopted one: the old global values come back)",
].join("\n");
type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runHypothesisCli(api: HypothesesApi, argv: readonly string[]): Promise<Result> {
  try {
    const [op, ...rest] = argv;
    const flag = (name: string) => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : undefined; };
    const out = (value: unknown): Result => ({ exitCode: 0, stdout: JSON.stringify(value, null, 2) });
    if (op === "list") return out(api.list());
    if (op === "add") {
      const settings = Object.fromEntries(rest.flatMap((arg, index) => (rest[index - 1] === "--setting" ? [settingsPair(arg)] : [])));
      return out(api.add({ title: flag("title") ?? "", source: flag("source") ?? "", settings }));
    }
    if ((op === "test" || op === "verdict" || op === "revert") && rest[0] && !rest[0].startsWith("--")) {
      if (op === "test") return out(await api.test(rest[0], { version: flag("set"), tasks: flag("tasks") ? Number(flag("tasks")) : undefined }));
      return out(op === "verdict" ? api.verdict(rest[0]) : api.revert(rest[0]));
    }
    return { exitCode: 1, stderr: HYPOTHESIS_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
