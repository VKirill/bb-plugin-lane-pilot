import { renderDrill } from "../../drill";
import { CHECKERS, DEFECT_CLASSES, EXPECTED_CATCHERS } from "../../models/types";
import type { CheckersApi, ScoreRequest } from "../services/checkers-api";

export const CHECKERS_USAGE = [
  "bb lane-pilot checkers score [--tasks 6] [--only id,id] [--classes a,b] [--checkers a,b] [--critic provider/model] [--critic-on escapes|all] [--budget-tokens N] [--check-timeout sec] [--json]",
  "                             (plant known defects in accepted candidates, run the checkers on them, print the checker scorecard; the critics run only with --critic, from scripts/lp-checkers.ts, not inside the plugin)",
  "bb lane-pilot checkers scorecard [run-id] [--json]   (the stored scorecard of a run, newest by default)",
  "bb lane-pilot checkers drill [--blind a,b] [--json]  (the quick drill: code checkers on a fixture; exit 1 when a checker misses its class)",
  "bb lane-pilot checkers defects                       (the defect classes and who must catch each)",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

function flagsOf(argv: readonly string[], known: readonly string[], booleans: readonly string[] = ["json"]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [], flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const hit = /^--([a-z-]+)(?:=(.*))?$/s.exec(word);
    if (!hit) { positional.push(word); continue; }
    const name = hit[1]!;
    if (!known.includes(name)) throw new Error(`unknown flag --${name}\n${CHECKERS_USAGE}`);
    const value = booleans.includes(name) ? (hit[2] ?? "true") : (hit[2] ?? argv[++i]);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

const list = <T extends string>(text: string | undefined, allowed: readonly T[], what: string): T[] | undefined => {
  if (!text) return undefined;
  const items = text.split(",").map((item) => item.trim()).filter(Boolean);
  const bad = items.filter((item) => !(allowed as readonly string[]).includes(item));
  if (bad.length) throw new Error(`unknown ${what} ${bad.join(", ")}; known: ${allowed.join(", ")}`);
  return items as T[];
};

const positive = (name: string, text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
};

export async function runCheckersCli(api: CheckersApi, argv: string[]): Promise<Result> {
  try {
    const [sub, ...rest] = argv;
    const json = (value: unknown): Result => ({ exitCode: 0, stdout: JSON.stringify(value, null, 2) });
    if (sub === "score") {
      const { flags } = flagsOf(rest, ["tasks", "only", "classes", "checkers", "critic", "critic-on", "budget-tokens", "check-timeout", "json"]);
      let critic: ScoreRequest["critic"];
      if (flags.critic) {
        const at = flags.critic.indexOf("/");
        if (at <= 0 || at === flags.critic.length - 1) throw new Error("--critic wants provider/model, e.g. codex/gpt-6-luna");
        critic = { providerId: flags.critic.slice(0, at), model: flags.critic.slice(at + 1) };
      }
      if (flags["critic-on"] && flags["critic-on"] !== "escapes" && flags["critic-on"] !== "all") throw new Error("--critic-on is escapes or all");
      const classes = list(flags.classes, DEFECT_CLASSES, "defect class"), checkers = list(flags.checkers, CHECKERS, "checker");
      const report = await api.score({
        limit: positive("tasks", flags.tasks) ?? 6, ...(flags.only ? { only: flags.only.split(",") } : {}), ...(classes ? { classes } : {}), ...(checkers ? { checkers } : {}),
        ...(critic ? { critic } : {}), ...(flags["critic-on"] ? { criticOn: flags["critic-on"] as "escapes" | "all" } : {}),
        ...(flags["budget-tokens"] ? { budgetTokens: positive("budget-tokens", flags["budget-tokens"])! } : {}), ...(flags["check-timeout"] ? { checkTimeoutSec: positive("check-timeout", flags["check-timeout"])! } : {}),
      });
      return flags.json === "true" ? json({ runId: report.runId, state: report.state, candidates: report.candidates, planted: report.planted, spentTokens: report.spentTokens, scorecard: report.scorecard, rows: report.rows })
        : { exitCode: report.scorecard.regressions.length ? 1 : 0, stdout: `${report.text}\n\nrun ${report.runId ?? "(not stored)"}: ${report.candidates} candidates, ${report.planted} planted defects, ${report.spentTokens} model tokens (${report.state})` };
    }
    if (sub === "scorecard") {
      const { positional, flags } = flagsOf(rest, ["json"]);
      const found = api.scorecard(positional[0]);
      if (!found) return { exitCode: 1, stderr: "no scoring run is stored yet: run `bb lane-pilot checkers score`" };
      return flags.json === "true" ? json({ run: found.run, scorecard: found.card }) : { exitCode: 0, stdout: `run ${found.run.id} (${found.run.source}, ${found.run.state})\n\n${found.text}` };
    }
    if (sub === "drill") {
      const { flags } = flagsOf(rest, ["blind", "json"]);
      const blind = list(flags.blind, CHECKERS, "checker");
      const drill = await api.drill({ ...(blind ? { blind } : {}) });
      return { exitCode: drill.ok ? 0 : 1, stdout: flags.json === "true" ? JSON.stringify({ ok: drill.ok, problems: drill.problems, checked: drill.checked }, null, 2) : renderDrill(drill) };
    }
    if (sub === "defects") {
      return json(DEFECT_CLASSES.map((defectClass) => ({ defectClass, designedCatchers: EXPECTED_CATCHERS[defectClass] })));
    }
    return { exitCode: 1, stderr: CHECKERS_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
