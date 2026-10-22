import {
  judge, judgeModel, lintFindings, ownershipFindings, planFactFindings, planCriticPrompt, codeCriticPrompt, readCodeCritic, readPlanCritic, verificationFindings,
  type CommandRun, type ModelPort, type Subject, type VerificationSession, type Where,
} from "./checkers";
import { plantAll, honestClaim } from "./mutators";
import { buildScorecard, renderScorecard, type ResultRow, type Scorecard } from "./score";
import { finishRun, saveRow, startRun, type CheckerDb, type StoredRow } from "./store";
import { CHECKERS, CODE_CHECKERS, applies, controlId, type CheckerId, type CheckerResult, type DefectClass, type PlantInput, type Planted } from "./types";

export type ScoreDeps = {
  /** Opens the verification session of a candidate (a clone at its base); null or absent: the verification checker is not run. */
  openVerification?: (input: PlantInput) => Promise<VerificationSession | null>;
  /** The model the two critics are asked through; absent: only the code checkers run. */
  model?: ModelPort | null;
  /** Where a candidate's critic threads work. */
  where?: (input: PlantInput) => Where | undefined;
  db?: CheckerDb;
  log?: (line: string) => void;
};

export type ScoreOptions = {
  source: string;
  candidates: readonly PlantInput[];
  classes?: readonly DefectClass[];
  /** Only these checkers run (default: all). */
  checkers?: readonly CheckerId[];
  /** Checkers made blind on purpose: they report nothing. The self-test of the drill (a checker that stopped catching must turn it red). */
  blind?: readonly CheckerId[];
  /** The cap on what the critics may spend, in tokens (default 400 000). */
  budgetTokens?: number;
  /** `escapes` (default): the code critic is asked about the planted defects no code checker caught, as in the pipeline, where it sees only candidates that passed the checks. `all`: about every one. */
  criticOn?: "escapes" | "all";
  /** The code checkers whose miss is a regression (default: the ones that need no test to cover the line). The drill's fixture is covered, so it names all four. */
  guaranteed?: readonly CheckerId[];
};

export const DEFAULT_CHECKER_BUDGET_TOKENS = 400_000;

export type ScoreReport = {
  runId: string | null;
  state: "done" | "stopped_budget";
  candidates: number;
  planted: number;
  spentTokens: number;
  rows: StoredRow[];
  scorecard: Scorecard;
  text: string;
};

/** A rough count when the port does not report one: about four characters a token. */
const estimate = (...texts: string[]) => Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);

/**
 * Plants every defect class that fits each candidate, runs the checkers on the clean candidate (the control: what a false alarm is measured
 * against) and on each planted one, and builds the scorecard. A code checker catches a defect when it raises something the clean candidate did not.
 */
export async function runScore(deps: ScoreDeps, options: ScoreOptions): Promise<ScoreReport> {
  const log = deps.log ?? (() => undefined);
  const enabled = new Set<CheckerId>(options.checkers ?? CHECKERS), blind = new Set(options.blind ?? []);
  const budget = options.budgetTokens ?? DEFAULT_CHECKER_BUDGET_TOKENS;
  const run = deps.db ? startRun(deps.db, { source: options.source, config: { classes: options.classes ?? null, checkers: [...enabled], blind: [...blind], budgetTokens: budget, criticOn: options.criticOn ?? "escapes", model: deps.model ? true : false } }) : null;
  const rows: StoredRow[] = [];
  let spent = 0, planted = 0, stopped = false;

  const record = (taskId: string, defectId: string, defectClass: ResultRow["defectClass"], summary: string, expected: readonly CheckerId[], result: CheckerResult) => {
    const row: StoredRow = { defectId, taskId, defectClass, checker: result.checker, outcome: result.outcome, flagged: result.flagged, expected: expected.includes(result.checker), summary, detail: result.detail, tokens: result.tokens ?? null, costUsd: result.costUsd ?? null };
    rows.push(row);
    if (deps.db && run) saveRow(deps.db, run.id, row);
  };

  let where: Where | undefined;
  /** The files the code critic named on the clean candidate being scored. */
  let controlPaths: string[] = [];
  const ask = async (checker: "code_critic" | "plan_critic", prompt: string, read: typeof readCodeCritic, defect: Planted["defect"] | null): Promise<CheckerResult> => {
    if (!deps.model) return { checker, outcome: "n/a", flagged: false, detail: "no model given" };
    if (spent >= budget) { stopped = true; return { checker, outcome: "skipped_budget", flagged: false, detail: `the cap of ${budget} tokens is spent` }; }
    const started = Date.now();
    try {
      const answer = await deps.model.ask(prompt, checker, where);
      const text = answer.text;
      const tokens = answer.tokens ?? estimate(prompt, text);
      spent += tokens;
      const read_ = read(text);
      if (!defect && checker === "code_critic") controlPaths = read_.paths;
      return judgeModel(checker, read_, defect, { tokens, costUsd: answer.costUsd, ms: Date.now() - started }, controlPaths);
    } catch (cause) {
      return { checker, outcome: "error", flagged: false, detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300), ms: Date.now() - started };
    }
  };

  const deterministic = (subject: Subject, verification: CommandRun[] | null): Partial<Record<CheckerId, string[] | null>> => ({
    ownership: blind.has("ownership") ? [] : ownershipFindings(subject),
    contract_lint: blind.has("contract_lint") ? [] : lintFindings(subject),
    plan_fact: blind.has("plan_fact") ? [] : planFactFindings(subject),
    verification: verification === null ? null : blind.has("verification") ? [] : verificationFindings(verification),
  });

  for (const candidate of options.candidates) {
    where = deps.where?.(candidate);
    controlPaths = [];
    const control: Subject = { contract: candidate.contract, changes: candidate.changes, claim: honestClaim(candidate) };
    let session: VerificationSession | null = null;
    let sessionError: string | null = null;
    if (enabled.has("verification") && deps.openVerification) {
      try { session = await deps.openVerification(candidate); } catch (cause) { sessionError = cause instanceof Error ? cause.message : String(cause); }
    }
    const verify = async (subject: Subject): Promise<{ runs: CommandRun[] | null; error: string | null }> => {
      if (!session) return { runs: null, error: sessionError };
      try { return { runs: await session.run(subject), error: null }; } catch (cause) { return { runs: null, error: cause instanceof Error ? cause.message : String(cause) }; }
    };
    try {
      const clean = await verify(control);
      const base = deterministic(control, clean.runs);
      const cid = controlId(candidate.taskId);
      for (const checker of CODE_CHECKERS) {
        if (!enabled.has(checker)) continue;
        const found = base[checker];
        if (found === null || found === undefined) { record(candidate.taskId, cid, "control", "clean candidate", [], { checker, outcome: clean.error ? "error" : "n/a", flagged: false, detail: clean.error ?? "not run" }); continue; }
        record(candidate.taskId, cid, "control", "clean candidate", [], judge(checker, found, [], "clean candidate"));
      }
      if (deps.model && enabled.has("code_critic")) record(candidate.taskId, cid, "control", "clean candidate", [], await ask("code_critic", codeCriticPrompt(control, clean.runs ?? [], null).prompt, readCodeCritic, null));
      if (deps.model && enabled.has("plan_critic")) record(candidate.taskId, cid, "control", "clean candidate", [], await ask("plan_critic", planCriticPrompt(control.contract), readPlanCritic, null));

      for (const plant of plantAll(candidate, options.classes)) {
        planted++;
        const { defect } = plant, subject: Subject = { contract: plant.contract, changes: plant.changes, claim: plant.claim };
        const checked = await verify(subject);
        const found = deterministic(subject, checked.runs);
        const caught = new Set<CheckerId>();
        for (const checker of CODE_CHECKERS) {
          if (!enabled.has(checker) || !applies(checker, defect.class)) continue;
          const list = found[checker];
          const result: CheckerResult = list === null || list === undefined
            ? { checker, outcome: checked.error ? "error" : "n/a", flagged: false, detail: checked.error ?? "not run" }
            : judge(checker, list, base[checker] ?? []);
          if (result.outcome === "hit") caught.add(checker);
          record(candidate.taskId, defect.id, defect.class, defect.summary, defect.expected, result);
        }
        if (deps.model && enabled.has("code_critic") && applies("code_critic", defect.class)) {
          if (options.criticOn !== "all" && caught.size > 0) { /* the pipeline would never show this candidate to the critic */ }
          else {
            const { prompt, visible } = codeCriticPrompt(subject, checked.runs ?? [], defect);
            record(candidate.taskId, defect.id, defect.class, defect.summary, defect.expected, visible
              ? await ask("code_critic", prompt, readCodeCritic, defect)
              : { checker: "code_critic", outcome: "n/a", flagged: false, detail: "the defect lies beyond the part of the file the critic is shown" });
          }
        }
        if (deps.model && enabled.has("plan_critic") && applies("plan_critic", defect.class)) {
          record(candidate.taskId, defect.id, defect.class, defect.summary, defect.expected, await ask("plan_critic", planCriticPrompt(subject.contract), readPlanCritic, defect));
        }
        log(`${defect.id}: ${[...caught].join(", ") || "no code checker caught it"}`);
      }
    } finally {
      await session?.close().catch(() => undefined);
    }
  }
  const state = stopped ? "stopped_budget" : "done";
  if (deps.db && run) finishRun(deps.db, run.id, state, spent);
  const scorecard = buildScorecard(rows, options.guaranteed ? { guaranteed: options.guaranteed } : {});
  return { runId: run?.id ?? null, state, candidates: options.candidates.length, planted, spentTokens: spent, rows, scorecard, text: renderScorecard(scorecard) };
}
