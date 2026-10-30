import type { BenchApi } from "./service";
import { renderBaseline } from "./baseline";
import type { Fault } from "./runner";

export const BENCH_USAGE = [
  "bb lane-pilot bench build [--set vN] [--seed S] [--only stratum,..] [--tries 4] [--plan | --dry-run] [--wait]   (select, warm up and freeze a set of past tasks; default: the next free version)",
  "bb lane-pilot bench show [--set vN]                    (without --set: the newest set; the tasks of a set and the funnel of its build)",
  "bb lane-pilot bench prepare [--set vN]                 (the «LP bench …» projects the set needs, and the command that creates each)",
  "bb lane-pilot bench run --arm NAME [--set vN] [--writer provider/model] [--harness none|tree|<tree id>] [--repeat k] [--noise N] [--tasks N] [--only id,id]",
  "                       [--setting key=value]... [--fault owns|read_first] [--budget-tokens N] [--budget-hours H] [--wait]",
  "                       (--noise N: the same set N times, then pass@1 and pass^N; N is 2 to 10. The frozen set is not changed.)",
  "bb lane-pilot bench noise <armA> <armB> [--set vN]      (two identical arms: calibrates the threshold of compare)",
  "bb lane-pilot bench compare <armA> <armB> [--set vN] [--noise X,Y] [--harness-id <tree id>] [--json]   (A is the baseline; --harness-id records the verdict harness.adopt_by=bench waits for)",
  "bb lane-pilot bench sweep                                 (close a series still running past its hour cap)",
  "bb lane-pilot bench status [--set vN]                  (without --set: every set)",
  "bb lane-pilot bench config [budget_tokens=N] [budget_hours=H] [host=MACHINE] [noise_repeats=N] [repos_root=DIR]",
  "                       (host empty: each project's own machine. noise_repeats 0: the weekly run is once. repos_root remaps stored checkout paths; empty clears it. A refused provider is not retried on another model.)",
  "bb lane-pilot bench baseline [--days 14] [--project ID] [--json]   (no model: false-done rate, phantom writes, git loss recoverability of the accepted attempts)",
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

/** Without --set: the newest set for reading and running, the next free version for a build («v1» on an empty hub). */
function defaultVersion(bench: BenchApi, kind: "newest" | "next"): string {
  const sets = bench.status();
  if (kind === "next") return `v${Math.max(0, ...sets.map((row) => Number(/^v(\d+)$/.exec(row.version)?.[1] ?? 0))) + 1}`;
  return sets.slice().sort((a, b) => b.createdAt - a.createdAt)[0]?.version ?? "v1";
}

export async function runBenchCli(bench: BenchApi, argv: string[]): Promise<Result> {
  try {
    const [sub, ...rest] = argv;
    const out = (value: unknown): Result => ({ exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
    if (sub === "build") {
      const { flags } = parseBenchArgs(rest, ["set", "seed", "only", "tries", "dry-run", "plan", "wait", "min-free-gb", "check-timeout"]);
      return out(await bench.build({
        version: flags.set ?? defaultVersion(bench, "next"), wait: flags.wait === "true", dryRun: flags["dry-run"] === "true", planOnly: flags.plan === "true",
        ...(flags.seed ? { seed: flags.seed } : {}), ...(flags.only ? { only: flags.only.split(",") } : {}), ...(flags.tries ? { triesFactor: positive("tries", flags.tries)! } : {}),
        ...(flags["min-free-gb"] ? { minFreeGb: positive("min-free-gb", flags["min-free-gb"])! } : {}), ...(flags["check-timeout"] ? { checkTimeoutSec: positive("check-timeout", flags["check-timeout"])! } : {}),
      }));
    }
    if (sub === "show") {
      const { flags } = parseBenchArgs(rest, ["set"]);
      const version = flags.set ?? defaultVersion(bench, "newest");
      const shown = bench.show(version);
      if (!shown) return { exitCode: 1, stderr: `no bench set ${version}` };
      return out({ ...shown, build: await bench.lastBuild(version) });
    }
    if (sub === "prepare") {
      const { flags } = parseBenchArgs(rest, ["set"]);
      return out(await bench.prepare(flags.set ?? defaultVersion(bench, "newest")));
    }
    if (sub === "run") {
      const { flags, lists } = parseBenchArgs(rest, ["set", "arm", "writer", "harness", "repeat", "noise", "tasks", "only", "setting", "fault", "budget-tokens", "budget-hours", "wait", "task-timeout"]);
      if (!flags.arm) throw new Error(`bench run needs --arm NAME\n${BENCH_USAGE}`);
      let writer: { providerId: string; model: string } | undefined;
      if (flags.writer) {
        const at = flags.writer.indexOf("/");
        if (at <= 0 || at === flags.writer.length - 1) throw new Error("--writer wants provider/model, e.g. claude-code/claude-haiku-5-5");
        writer = { providerId: flags.writer.slice(0, at), model: flags.writer.slice(at + 1) };
      }
      if (flags.fault && flags.fault !== "owns" && flags.fault !== "read_first") throw new Error("--fault is owns or read_first");
      let noiseRepeats: number | undefined;
      if (flags.noise !== undefined) {
        const value = Number(flags.noise);
        if (!Number.isInteger(value) || value < 2 || value > 10) throw new Error("--noise wants an integer from 2 to 10");
        noiseRepeats = value;
      }
      const settings = Object.fromEntries((lists.setting ?? []).map(settingPair));
      return out(await bench.run({
        version: flags.set ?? defaultVersion(bench, "newest"), arm: flags.arm, ...(writer ? { writer } : {}), ...(flags.harness ? { harness: flags.harness } : {}),
        ...(flags.repeat ? { repeat: positive("repeat", flags.repeat)! } : {}), ...(noiseRepeats ? { repeat: noiseRepeats, noise: true } : {}),
        ...(flags.tasks ? { limit: positive("tasks", flags.tasks)! } : {}),
        ...(flags.only ? { only: flags.only.split(",") } : {}), settings, ...(flags.fault ? { fault: flags.fault as Fault } : {}),
        ...(flags["budget-tokens"] ? { budgetTokens: positive("budget-tokens", flags["budget-tokens"])! } : {}), ...(flags["budget-hours"] ? { budgetHours: positive("budget-hours", flags["budget-hours"])! } : {}),
        ...(flags["task-timeout"] ? { taskTimeoutMin: positive("task-timeout", flags["task-timeout"])! } : {}), wait: flags.wait === "true",
      }));
    }
    if (sub === "noise") {
      const { positional, flags } = parseBenchArgs(rest, ["set"]);
      if (positional.length !== 2) throw new Error("usage: bb lane-pilot bench noise <armA> <armB> [--set vN]");
      return out(bench.noise({ version: flags.set ?? defaultVersion(bench, "newest"), armA: positional[0]!, armB: positional[1]! }));
    }
    if (sub === "compare") {
      const { positional, flags } = parseBenchArgs(rest, ["set", "noise", "harness-id", "json"]);
      if (positional.length !== 2) throw new Error("usage: bb lane-pilot bench compare <armA> <armB> [--set vN] [--noise X,Y] [--harness-id id] [--json]");
      const noiseArms = flags.noise ? flags.noise.split(",") as [string, string] : undefined;
      if (noiseArms && noiseArms.length !== 2) throw new Error("--noise wants two arm names: X,Y");
      const result = bench.compare({ version: flags.set ?? defaultVersion(bench, "newest"), armA: positional[0]!, armB: positional[1]!, ...(noiseArms ? { noiseArms } : {}), ...(flags["harness-id"] ? { harnessId: flags["harness-id"] } : {}) });
      // 0 pass, 1 fail, 2 inconclusive: a script must not read too little data as either answer.
      return { exitCode: result.comparison.verdict === "pass" ? 0 : result.comparison.verdict === "fail" ? 1 : 2, stdout: flags.json === "true" ? JSON.stringify(result.comparison, null, 2) : `${result.text}${result.verdictId ? `\nRecorded as ${result.verdictId} for harness ${flags["harness-id"]}.` : ""}` };
    }
    if (sub === "status") {
      const { flags } = parseBenchArgs(rest, ["set"]);
      return out(bench.status(flags.set));
    }
    if (sub === "baseline") {
      const { flags } = parseBenchArgs(rest, ["days", "project", "json"]);
      const metrics = await bench.baseline({ days: positive("days", flags.days), ...(flags.project ? { projectId: flags.project } : {}) });
      return out(flags.json ? metrics : renderBaseline(metrics));
    }
    if (sub === "sweep") {
      parseBenchArgs(rest, []);
      return out(bench.sweep());
    }
    if (sub === "config") {
      const patch: { budgetTokens?: number; budgetHours?: number; hostId?: string | null; noiseRepeats?: number; reposRoot?: string | null } = {};
      for (const word of rest) {
        const at = word.indexOf("=");
        if (at <= 0) throw new Error("config takes budget_tokens=N, budget_hours=H, host=MACHINE, noise_repeats=N, repos_root=DIR");
        const key = word.slice(0, at), value = word.slice(at + 1);
        if (key === "budget_tokens" || key === "budget_hours") {
          const number = Number(value);
          if (!value || !Number.isFinite(number)) throw new Error(`${key} must be a positive number`);
          patch[key === "budget_tokens" ? "budgetTokens" : "budgetHours"] = number;
        } else if (key === "host") patch.hostId = value.trim() || null;
        else if (key === "noise_repeats") {
          const number = Number(value);
          if (!Number.isInteger(number) || number < 0 || number > 10) throw new Error("noise_repeats must be an integer from 0 to 10");
          patch.noiseRepeats = number;
        } else if (key === "repos_root") patch.reposRoot = value.trim() || null;
        else throw new Error("config takes budget_tokens=N, budget_hours=H, host=MACHINE, noise_repeats=N, repos_root=DIR");
      }
      if (Object.keys(patch).length) await bench.configure(patch);
      return out({ ...(await bench.settings()), ...(await bench.placement()) });
    }
    return { exitCode: 1, stderr: BENCH_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
