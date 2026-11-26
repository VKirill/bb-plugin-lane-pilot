import { runDrill, type DrillReport } from "../../drill";
import type { LoadedCandidate, ModelPort } from "./checkers";
import { runScore, type ScoreReport } from "./score-service";
import { buildScorecard, renderScorecard, type Scorecard } from "../../models/score";
import { getRun, latestRun, listRows, listRuns, type CheckerDb, type CheckerRun } from "../repositories/checker-repository";
import { type CheckerId, type DefectClass } from "../../models/types";

export type { LoadedCandidate };

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

  return {
    score,
    scorecard,
    runs: (limit = 10) => listRuns(deps.db, limit),
    drill: (options: Parameters<typeof runDrill>[0] = {}): Promise<DrillReport> => runDrill(options),
  };
}

export type CheckersApi = ReturnType<typeof createCheckers>;
