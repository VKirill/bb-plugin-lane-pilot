import { renderDrill, runDrill, type DrillReport } from "./drill";
import type { ModelPort, Subject, VerificationSession, Where } from "./checkers";
import { runDiffHiddenAudit, type DiffHiddenAuditReport } from "./diff-hidden";
import { honestClaim } from "./mutators";
import { runScore, type ScoreReport } from "./service";
import { buildScorecard, renderScorecard, type Scorecard } from "./score";
import { getRun, latestRun, listRows, listRuns, type CheckerDb, type CheckerRun } from "./store";
import { CHECKERS, DEFECT_CLASSES, EXPECTED_CATCHERS, type CheckerId, type DefectClass, type PlantInput } from "./types";

/** An accepted candidate with the way to run its checks in a clone at its base. */
export type LoadedCandidate = { input: PlantInput; open: () => Promise<VerificationSession>; where?: Where };

export type CheckersDeps = {
  db: CheckerDb;
  /** The real accepted candidates to plant defects in (the hub's history or a bench set); `only` names task ids. */
  load: (options: { limit: number; only?: readonly string[]; checkTimeoutSec?: number }) => Promise<LoadedCandidate[]>;
  /** The model the critics ask through, from `provider/model`; null when this host cannot ask one. */
  model: (spec: { providerId: string; model: string }) => ModelPort | null;
  log: (line: string) => void;
};

export type ScoreRequest = {
  limit?: number;
  only?: readonly string[];
  classes?: readonly DefectClass[];
  checkers?: readonly CheckerId[];
  /** `provider/model` of the critics; absent: code checkers only. */
  critic?: { providerId: string; model: string };
  budgetTokens?: number;
  criticOn?: "escapes" | "all";
  checkTimeoutSec?: number;
};

export const DEFAULT_CRITIC_MODEL = { providerId: "codex", model: "gpt-6-luna" } as const;

export function createCheckers(deps: CheckersDeps) {
  async function score(request: ScoreRequest = {}): Promise<ScoreReport> {
    const loaded = await deps.load({ limit: request.limit ?? 6, ...(request.only ? { only: request.only } : {}), ...(request.checkTimeoutSec ? { checkTimeoutSec: request.checkTimeoutSec } : {}) });
    if (!loaded.length) throw new Error("no accepted candidate could be loaded (see the log for why each was skipped)");
    const model = request.critic ? deps.model(request.critic) : null;
    if (request.critic && !model) throw new Error(`this host cannot ask ${request.critic.providerId}/${request.critic.model}: the plugin starts no critic threads; run the critics with scripts/lp-checkers.ts, or score with the code checkers only (no --critic)`);
    const byTask = new Map(loaded.map((row) => [row.input.taskId, row]));
    return await runScore({
      db: deps.db, model, log: deps.log, where: (input) => byTask.get(input.taskId)?.where,
      openVerification: async (input) => await byTask.get(input.taskId)?.open() ?? null,
    }, {
      source: loaded[0]!.input.source.split(":")[0] ?? "history", candidates: loaded.map((row) => row.input),
      ...(request.classes ? { classes: request.classes } : {}), ...(request.checkers ? { checkers: request.checkers } : {}),
      ...(request.budgetTokens ? { budgetTokens: request.budgetTokens } : {}), ...(request.criticOn ? { criticOn: request.criticOn } : {}),
    });
  }

  function scorecard(runId?: string): { run: CheckerRun; card: Scorecard; text: string } | null {
    const run = runId ? getRun(deps.db, runId) : latestRun(deps.db);
    if (!run) return null;
    const card = buildScorecard(listRows(deps.db, run.id));
    return { run, card, text: renderScorecard(card) };
  }

  async function diffHidden(options: { limit?: number; only?: readonly string[]; checkers?: CheckerId[] } = {}): Promise<DiffHiddenAuditReport> {
    const loaded = await deps.load({ limit: options.limit ?? 6, ...(options.only ? { only: options.only } : {}) });
    const subjects: Subject[] = loaded.map((row) => ({
      contract: row.input.contract,
      changes: row.input.changes,
      claim: honestClaim({ contract: row.input.contract, changes: row.input.changes }),
    }));
    return await runDiffHiddenAudit(subjects, {
      checkers: options.checkers,
      db: deps.db,
    });
  }

  return {
    score,
    scorecard,
    runs: (limit = 10) => listRuns(deps.db, limit),
    drill: (options: Parameters<typeof runDrill>[0] = {}): Promise<DrillReport> => runDrill(options),
    diffHidden,
  };
}

export type CheckersApi = ReturnType<typeof createCheckers>;

export const CHECKERS_USAGE = [
  "bb lane-pilot checkers score [--tasks 6] [--only id,id] [--classes a,b] [--checkers a,b] [--critic provider/model] [--critic-on escapes|all] [--budget-tokens N] [--check-timeout sec] [--json]",
  "                             (plant known defects in accepted candidates, run the checkers on them, print the checker scorecard; the critics run only with --critic, from scripts/lp-checkers.ts, not inside the plugin)",
  "bb lane-pilot checkers scorecard [run-id] [--json]   (the stored scorecard of a run, newest by default)",
  "bb lane-pilot checkers drill [--blind a,b] [--json]  (the quick drill: code checkers on a fixture; exit 1 when a checker misses its class)",
  "bb lane-pilot checkers diff-hidden [--tasks 6] [--only id,id] [--checkers a,b] [--json]",
  "                                                     (audit checkers with diff hidden: measures blind passes and phantom findings)",
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
    if (sub === "diff-hidden") {
      const { flags } = flagsOf(rest, ["tasks", "only", "checkers", "json"]);
      const checkers = list(flags.checkers, CHECKERS, "checker");
      const report = await api.diffHidden({
        limit: positive("tasks", flags.tasks) ?? 6,
        ...(flags.only ? { only: flags.only.split(",") } : {}),
        ...(checkers ? { checkers } : {}),
      });
      const pct = Math.round(report.sensitivityRate * 100);
      const text = `DIFF-HIDDEN AUDIT (${report.runId}): ${report.candidatesCount} candidates, ${report.totalChecks} checks\n` +
        `  Blind passes: ${report.blindPassCount} (${report.blindPassCount === 0 ? "clean" : "warning: checks passed with empty diff"})\n` +
        `  Phantom findings: ${report.phantomCount} (${report.phantomCount === 0 ? "clean" : "warning: findings reproduced without diff"})\n` +
        `  Diff sensitivity: ${report.diffSensitiveCount}/${report.totalChecks} (${pct}%)\n`;
      return flags.json === "true" ? json(report) : { exitCode: report.blindPassCount > 0 ? 1 : 0, stdout: text };
    }
    if (sub === "defects") {
      return json(DEFECT_CLASSES.map((defectClass) => ({ defectClass, designedCatchers: EXPECTED_CATCHERS[defectClass] })));
    }
    return { exitCode: 1, stderr: CHECKERS_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
