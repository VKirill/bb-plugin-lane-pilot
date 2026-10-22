import type { BenchApi } from "./service";
import type { Fault } from "./runner";

export const BENCH_USAGE = [
  "bb lane-pilot bench build [--set v1] [--seed S] [--only stratum,..] [--tries 4] [--plan | --dry-run] [--wait]   (select, warm up and freeze a set of past tasks)",
  "bb lane-pilot bench show [--set v1]                    (the tasks of a set and the funnel of its build)",
  "bb lane-pilot bench prepare [--set v1]                 (the «LP bench …» projects the set needs, and the command that creates each)",
  "bb lane-pilot bench run --arm NAME [--set v1] [--writer provider/model] [--harness none|tree|<tree id>] [--repeat k] [--tasks N] [--only id,id]",
  "                       [--setting key=value]... [--fault owns|read_first] [--budget-tokens N] [--budget-hours H] [--wait]",
  "bb lane-pilot bench noise <armA> <armB> [--set v1]      (two identical arms: calibrates the threshold of compare)",
  "bb lane-pilot bench compare <armA> <armB> [--set v1] [--noise X,Y] [--harness-id <tree id>] [--json]   (A is the baseline; --harness-id records the verdict harness.adopt_by=bench waits for)",
  "bb lane-pilot bench status [--set v1]",
  "bb lane-pilot bench config [budget_tokens=N] [budget_hours=H]   (bench.budget_tokens / bench.budget_hours: the cap of one arm)",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };
const BOOLEAN = new Set(["dry-run", "plan", "wait", "json"]);
const REPEATABLE = new Set(["setting"]);

export function parseBenchArgs(argv: readonly string[], known: readonly string[]): { positional: string[]; flags: Record<string, string>; lists: Record<string, string[]> } {
  const positional: string[] = [], flags: Record<string, string> = {}, lists: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const hit = /^--([a-z-]+)(?:=(.*))?$/s.exec(word);
    if (!hit) { positional.push(word); continue; }
    const name = hit[1]!;
    if (!known.includes(name)) throw new Error(`unknown flag --${name}\n${BENCH_USAGE}`);
    const value = BOOLEAN.has(name) ? (hit[2] ?? "true") : (hit[2] ?? argv[++i]);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (REPEATABLE.has(name)) lists[name] = [...(lists[name] ?? []), value]; else flags[name] = value;
  }
  return { positional, flags, lists };
}

const positive = (name: string, text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
};

/** `key=value` with the value read as JSON when it parses (true, 3, "text"), else as text. */
function settingPair(text: string): [string, unknown] {
  const at = text.indexOf("=");
  if (at <= 0) throw new Error(`--setting wants key=value, got ${text}`);
  const raw = text.slice(at + 1);
  try { return [text.slice(0, at), JSON.parse(raw)]; } catch { return [text.slice(0, at), raw]; }
}

export async function runBenchCli(bench: BenchApi, argv: string[]): Promise<Result> {
  try {
    const [sub, ...rest] = argv;
    const out = (value: unknown): Result => ({ exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
    if (sub === "build") {
      const { flags } = parseBenchArgs(rest, ["set", "seed", "only", "tries", "dry-run", "plan", "wait", "min-free-gb", "check-timeout"]);
      return out(await bench.build({
        version: flags.set ?? "v1", wait: flags.wait === "true", dryRun: flags["dry-run"] === "true", planOnly: flags.plan === "true",
        ...(flags.seed ? { seed: flags.seed } : {}), ...(flags.only ? { only: flags.only.split(",") } : {}), ...(flags.tries ? { triesFactor: positive("tries", flags.tries)! } : {}),
        ...(flags["min-free-gb"] ? { minFreeGb: positive("min-free-gb", flags["min-free-gb"])! } : {}), ...(flags["check-timeout"] ? { checkTimeoutSec: positive("check-timeout", flags["check-timeout"])! } : {}),
      }));
    }
    if (sub === "show") {
      const { flags } = parseBenchArgs(rest, ["set"]);
      const version = flags.set ?? "v1";
      const shown = bench.show(version);
      if (!shown) return { exitCode: 1, stderr: `no bench set ${version}` };
      return out({ ...shown, build: await bench.lastBuild(version) });
    }
    if (sub === "prepare") {
      const { flags } = parseBenchArgs(rest, ["set"]);
      return out(await bench.prepare(flags.set ?? "v1"));
    }
    if (sub === "run") {
      const { flags, lists } = parseBenchArgs(rest, ["set", "arm", "writer", "harness", "repeat", "tasks", "only", "setting", "fault", "budget-tokens", "budget-hours", "wait", "task-timeout"]);
      if (!flags.arm) throw new Error(`bench run needs --arm NAME\n${BENCH_USAGE}`);
      let writer: { providerId: string; model: string } | undefined;
      if (flags.writer) {
        const at = flags.writer.indexOf("/");
        if (at <= 0 || at === flags.writer.length - 1) throw new Error("--writer wants provider/model, e.g. codex/gpt-6-luna");
        writer = { providerId: flags.writer.slice(0, at), model: flags.writer.slice(at + 1) };
      }
      if (flags.fault && flags.fault !== "owns" && flags.fault !== "read_first") throw new Error("--fault is owns or read_first");
      const settings = Object.fromEntries((lists.setting ?? []).map(settingPair));
      return out(await bench.run({
        version: flags.set ?? "v1", arm: flags.arm, ...(writer ? { writer } : {}), ...(flags.harness ? { harness: flags.harness } : {}),
        ...(flags.repeat ? { repeat: positive("repeat", flags.repeat)! } : {}), ...(flags.tasks ? { limit: positive("tasks", flags.tasks)! } : {}),
        ...(flags.only ? { only: flags.only.split(",") } : {}), settings, ...(flags.fault ? { fault: flags.fault as Fault } : {}),
        ...(flags["budget-tokens"] ? { budgetTokens: positive("budget-tokens", flags["budget-tokens"])! } : {}), ...(flags["budget-hours"] ? { budgetHours: positive("budget-hours", flags["budget-hours"])! } : {}),
        ...(flags["task-timeout"] ? { taskTimeoutMin: positive("task-timeout", flags["task-timeout"])! } : {}), wait: flags.wait === "true",
      }));
    }
    if (sub === "noise") {
      const { positional, flags } = parseBenchArgs(rest, ["set"]);
      if (positional.length !== 2) throw new Error("usage: bb lane-pilot bench noise <armA> <armB> [--set v1]");
      return out(bench.noise({ version: flags.set ?? "v1", armA: positional[0]!, armB: positional[1]! }));
    }
    if (sub === "compare") {
      const { positional, flags } = parseBenchArgs(rest, ["set", "noise", "harness-id", "json"]);
      if (positional.length !== 2) throw new Error("usage: bb lane-pilot bench compare <armA> <armB> [--set v1] [--noise X,Y] [--harness-id id] [--json]");
      const noiseArms = flags.noise ? flags.noise.split(",") as [string, string] : undefined;
      if (noiseArms && noiseArms.length !== 2) throw new Error("--noise wants two arm names: X,Y");
      const result = bench.compare({ version: flags.set ?? "v1", armA: positional[0]!, armB: positional[1]!, ...(noiseArms ? { noiseArms } : {}), ...(flags["harness-id"] ? { harnessId: flags["harness-id"] } : {}) });
      return { exitCode: result.comparison.verdict === "pass" ? 0 : 1, stdout: flags.json === "true" ? JSON.stringify(result.comparison, null, 2) : `${result.text}${result.verdictId ? `\nRecorded as ${result.verdictId} for harness ${flags["harness-id"]}.` : ""}` };
    }
    if (sub === "status") {
      const { flags } = parseBenchArgs(rest, ["set"]);
      return out(bench.status(flags.set));
    }
    if (sub === "config") {
      const patch: Record<string, number> = {};
      for (const word of rest) {
        const [key, value] = word.split("=");
        if ((key !== "budget_tokens" && key !== "budget_hours") || !value) throw new Error("config takes budget_tokens=N and budget_hours=H");
        patch[key === "budget_tokens" ? "budgetTokens" : "budgetHours"] = Number(value);
      }
      return out(Object.keys(patch).length ? await bench.configure(patch) : await bench.settings());
    }
    return { exitCode: 1, stderr: BENCH_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
