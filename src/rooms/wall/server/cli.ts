import { HEAD_PARTS, type HeadPart } from "@lane-pilot/contracts";
import { WALL_DEFAULTS } from "../config";
import type { WallApi } from "../service";

export const WALL_USAGE = [
  "bb lane-pilot wall status                       the classes with a recent failure, the repairs, the walls on the ladder, the last nights and what they spent",
  "bb lane-pilot wall night [--dry-run]            run the night now (03:00 by itself); --dry-run keeps nothing, calls no model and only says what it would pick and why",
  "bb lane-pilot wall advance                      follow the repairs (verdicts, merges, the release train, acceptance) and the task walls once",
  "bb lane-pilot wall show <class-key|wall-key>    one class or wall: its recurrence, repairs, hunt, backlog entry and re-runs",
  "bb lane-pilot wall close <wall-key> --evidence <text>   close a wall with what settles it (an accepted attempt, a commit, the owner's decision)",
  "bb lane-pilot wall rerun <class-key> [--head part,part] [--dry-run]   plan (and, for sandbox and bench projects, start) the re-run of the class's failed attempts from their earliest affected stage",
  `bb lane-pilot wall config [key=value ...]       ${Object.keys(WALL_DEFAULTS).join(", ")}`,
  "bb lane-pilot wall morning                      the three lines of the morning summary",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runWallCli(wall: WallApi, argv: string[]): Promise<Result> {
  try {
    const [op = "status", ...rest] = argv;
    const flags = rest.filter((word) => word.startsWith("--"));
    const positional = rest.filter((word) => !word.startsWith("--"));
    const flagValue = (name: string): string | undefined => {
      const at = rest.findIndex((word) => word === `--${name}` || word.startsWith(`--${name}=`));
      if (at < 0) return undefined;
      const word = rest[at]!;
      return word.includes("=") ? word.slice(word.indexOf("=") + 1) : rest[at + 1];
    };
    const out = (value: unknown): Result => ({ exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
    if (op === "status") return out(wall.status());
    if (op === "morning") return out(wall.morning().join("\n"));
    if (op === "night") return out(await wall.runNight({ dryRun: flags.includes("--dry-run") }));
    if (op === "advance") return out(await wall.advance());
    if (op === "show") {
      if (!positional[0]) throw new Error(`show needs a class or wall key\n${WALL_USAGE}`);
      return out(wall.show(positional[0]));
    }
    if (op === "close") {
      const evidence = flagValue("evidence");
      if (!positional[0] || !evidence) throw new Error(`close needs a wall key and --evidence\n${WALL_USAGE}`);
      return out(wall.close(positional[0], evidence));
    }
    if (op === "rerun") {
      if (!positional[0]) throw new Error(`rerun needs a class key\n${WALL_USAGE}`);
      const head = (flagValue("head") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      const bad = head.filter((part) => !(HEAD_PARTS as readonly string[]).includes(part));
      if (bad.length) throw new Error(`unknown head part ${bad.join(", ")}; known: ${HEAD_PARTS.join(", ")}`);
      const plans = await wall.rerun(positional[0], { head: head as HeadPart[], dryRun: flags.includes("--dry-run") });
      return out(plans.map((plan) => ({ project: plan.projectId, task: plan.taskId, attempt: plan.attemptId, scope: plan.scope, failedStage: plan.failedStage, from: plan.affected.from, mode: plan.affected.mode,
        reused: plan.affected.reused, stale: plan.affected.stale })));
    }
    if (op === "config") {
      if (!positional.length) return out(await wall.config());
      const patch: Record<string, unknown> = {};
      for (const pair of positional) {
        const at = pair.indexOf("=");
        if (at <= 0) throw new Error(`config wants key=value, got ${pair}`);
        const key = pair.slice(0, at), raw = pair.slice(at + 1);
        if (!(key in WALL_DEFAULTS)) throw new Error(`unknown setting ${key}; known: ${Object.keys(WALL_DEFAULTS).join(", ")}`);
        try { patch[key] = JSON.parse(raw); } catch { patch[key] = raw; }
      }
      return out(await wall.setConfig(patch));
    }
    return { exitCode: 1, stderr: `unknown wall operation «${op}»\n${WALL_USAGE}` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
