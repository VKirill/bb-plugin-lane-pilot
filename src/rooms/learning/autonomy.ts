import { z } from "zod";
import type { Decisions } from "./decide";
import type { LearningConfig } from "./config";
import { REVIEW_CASES } from "./ops";
import { labelObservation, listItems, reviewSample, startOfDay, type Db, type Observation } from "./store";

/**
 * Learning without the owner (owner out of the loop, 2026-10-22). Two steps the owner used to do by hand:
 *
 *  - the check of the judges (op "review"/"label"): a strong model of its own — the project's rules analyzer, not Jev and not the
 *    second opinion — reads a sample of judged messages and says whether each decision (learn from it or not) was right. Its labels
 *    are the evidence `status` counts (REVIEW_CASES at REVIEW_ACCURACY); once that and the days of observation hold, learning
 *    switches itself to `active`. Below the accuracy it keeps observing: the judges need fixing, not a person;
 *  - the «yes» to an item (a date, a global preference, a statement that contradicts one in force): the owner said it himself, so it
 *    is accepted. A reminder is set, a contradicting rule goes on trial (and is retired by the trial if it does not help), and a
 *    global preference is written by the server itself (`bb memory add` argv from decide.ts); the outcome lands on the item.
 */
export const MODEL_REVIEW_BATCH = 25;
export const MODEL_REVIEW_RUNS_PER_DAY = 4;
const EXCERPT = 500;

export function modelReviewPrompt(cases: readonly Observation[]): string {
  const rows = cases.map((row) => JSON.stringify({
    id: row.id,
    owner_message: (row.excerpt ?? "").slice(0, EXCERPT),
    agent_said_before: (row.prev ?? "").slice(-300),
    decided: row.finalRoute ?? row.route ?? "none",
    judged_kind: row.kind,
  }));
  return [
    "You check the decisions of an automatic judge that reads the owner's messages to his coding agents.",
    'For each message the judge decided "learn" (it states something lasting: a rule or preference for future work, a decision, a date or',
    'promise, a fact about the owner or the project) or "none" (a one-off instruction for the current task, a question, chat, a reaction).',
    "Say for each message whether the decision is right. Judge only from the message and the agent's words before it.",
    'Answer with JSON only, no prose: [{"id": "<id>", "correct": true|false}, …], one entry per message.',
    "",
    ...rows,
  ].join("\n");
}

const answerSchema = z.array(z.object({ id: z.string(), correct: z.boolean() }).passthrough());

/** The labels a reply carries for the asked ids; a reply that is not that JSON gives none. */
export function parseModelReview(text: string, asked: ReadonlySet<string>): Array<{ id: string; correct: boolean }> {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const answer = answerSchema.safeParse(parsed);
  if (!answer.success) return [];
  const seen = new Set<string>();
  return answer.data.filter((row) => asked.has(row.id) && !seen.has(row.id) && seen.add(row.id)).map((row) => ({ id: row.id, correct: row.correct }));
}

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
type Status = { mode: LearningConfig["mode"]; enabled: boolean; readyForActive: boolean; review: { reviewed: number; accuracy: number | null } };

export type AutonomyDeps = {
  db: Db;
  kv: Kv;
  config(): LearningConfig;
  status(): Promise<Status>;
  configure(words: string[]): Promise<unknown>;
  runModel(prompt: string, projectId: string, label: string): Promise<string>;
  decisions: Pick<Decisions, "accept">;
  pmThread(projectId: string): string | null;
  sendToPm(threadId: string, text: string): Promise<void>;
  /** The project asks for the owner's word (owner.words = on): its waiting items stay for him (SMA: Draft awaits a person, Person applies the draft). */
  ownerWords?(projectId: string): boolean;
  now?(): number;
  log(line: string): void;
};

export function createAutonomy(deps: AutonomyDeps) {
  const now = deps.now ?? Date.now;
  const runsKey = () => `learning:model-review-runs:${new Date(startOfDay(now())).toISOString().slice(0, 10)}`;

  /** One run of the reviewer on unlabelled judged messages; it asks the analyzer of the first project that has one. */
  async function review(limit = MODEL_REVIEW_BATCH) {
    const cases = reviewSample(deps.db, limit);
    if (!cases.length) return { state: "nothing" as const, asked: 0, labelled: 0, wrong: 0 };
    const prompt = modelReviewPrompt(cases);
    let reply: string | null = null, reason = "";
    for (const projectId of [...new Set(cases.map((row) => row.projectId))]) {
      try { reply = await deps.runModel(prompt, projectId, "review of the judges"); break; }
      catch (cause) { reason = cause instanceof Error ? cause.message : String(cause); }
    }
    if (reply === null) return { state: "no_model" as const, asked: cases.length, labelled: 0, wrong: 0, reason };
    const labels = parseModelReview(reply, new Set(cases.map((row) => row.id)));
    for (const label of labels) labelObservation(deps.db, label.id, label.correct, now());
    return { state: "ran" as const, asked: cases.length, labelled: labels.length, wrong: labels.filter((label) => !label.correct).length };
  }

  /** While observing: label more cases (a few runs a day) until there is enough evidence, then act on it. */
  async function reviewTick() {
    const config = deps.config();
    if (!config.enabled || config.mode !== "observe") return null;
    let status = await deps.status();
    if (status.review.reviewed < REVIEW_CASES) {
      const runs = (await deps.kv.get<number>(runsKey()).catch(() => 0)) ?? 0;
      if (runs < MODEL_REVIEW_RUNS_PER_DAY) {
        const result = await review();
        if (result.state !== "nothing") await deps.kv.set(runsKey(), (runs + 1) as never);
        if (result.state !== "nothing") deps.log(`learning: model review ${JSON.stringify(result)}`);
        status = await deps.status();
      }
    }
    if (!status.readyForActive) return { activated: false, review: status.review };
    await deps.configure(["mode=active"]);
    deps.log(`learning: switched to active on evidence (${status.review.reviewed} cases checked by the model, accuracy ${status.review.accuracy})`);
    return { activated: true, review: status.review };
  }

  /** Accepts what waited for the owner's «yes»; a global preference goes to the project's PM to save. */
  async function settleWaiting() {
    const settled: Array<{ id: string; state: string }> = [];
    for (const item of listItems(deps.db, { states: ["pending_owner"], limit: 50 })) {
      // Approval path (SMA): with owner.words on, an item that waits for the owner is applied only by his word, not settled here.
      if (deps.ownerWords?.(item.projectId)) continue;
      try {
        const decided = await deps.decisions.accept(item.id);
        settled.push({ id: item.id, state: decided.item.state });
        if (decided.note) deps.log(`learning: ${item.id}: ${decided.note}`);
      } catch (cause) {
        deps.log(`learning: could not settle ${item.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return settled;
  }

  return { review, reviewTick, settleWaiting };
}
export type Autonomy = ReturnType<typeof createAutonomy>;
