import { maskPii } from "../anamnesis/pii";
import { defineJudgment, noul, noulOf, score } from "../jev/registry";
import type { Jev } from "../jev/run";
import { DAY_MS, insertSignal, listSignals, type Db } from "./store";

/**
 * Other things Jev can read from what Lane Pilot already has (T8, the table of section 4 of the design). Each is an observation:
 * a row in `lane_pilot_learning_signal` and a line in `op:"signals"`, and nothing acts on it. They are switched on one at a time by
 * the room once the owner-message hook has proved itself, and each is capped, so the cost stays a few dozen Jev requests a day.
 *
 *  - `unkept_promise`: a writer's accepted final answer that says something was left undone («later», «TODO», «not verified»).
 *    Would feed a follow-up task and the critic.
 *  - `owner_question`: a question an agent put to the owner that another agent, the project's files or its memory could have
 *    answered (the data's example: «ask the copywriter, not me»). Would feed a routing rule for the PM.
 *  - `complexity`: a task contract's size read by Jev (1 trivial … 4 large) against what it took (attempts, minutes). Would calibrate
 *    the quality mode and the choice of writer model; the report shows whether the reading predicts the effort.
 *
 * Not built: searching artifacts and receipts (a retrieval feature, not an observation) and routing Telegram intents (needs the
 * Telegram projects' intake, a separate piece).
 */
export const PROMISE_JUDGMENT_ID = "learning.unkept_promise";
export const QUESTION_JUDGMENT_ID = "learning.owner_question";
export const COMPLEXITY_JUDGMENT_ID = "learning.complexity";

export const unkeptPromise = defineJudgment<{ answer: string }, number>({
  id: PROMISE_JUDGMENT_ID, version: 1, defaultMode: "active", timeoutMs: 8_000,
  stateBuilder: (input) => ({ final_answer: input.answer }),
  questions: () => ({
    unkept: noul(
      "Does `final_answer`, a coding agent's report of finished work, admit or promise that something was left undone, postponed or not checked?",
      { true: "«I will do it later», «TODO», «not verified», «skipped the migration», «left for a follow-up»", false: "a report that says the work is done and checked, or lists only what was done" },
    ),
  }),
  thresholds: { min_p: { default: 0.6, min: 0.3, max: 0.95, about: "least p(yes) to record the answer as holding an unkept promise" } },
  decide: (answers) => ({ decision: noulOf(answers, "unkept") ?? 0 }),
  fallback: () => 0,
  describe: (decision) => String(Math.round(decision * 100) / 100),
});

export const ownerQuestion = defineJudgment<{ question: string; detail: string }, number>({
  id: QUESTION_JUDGMENT_ID, version: 1, defaultMode: "active", timeoutMs: 8_000,
  stateBuilder: (input) => ({ question_to_owner: input.question, detail: input.detail }),
  questions: () => ({
    routable: noul(
      "An AI agent asked its owner `question_to_owner`. Could the answer have been found without the owner: by another agent (a copywriter, a designer, a reviewer), from the project's files, its memory or the code, or by choosing the obvious default?",
      { true: "«which wording do you prefer for the button», «is the build command npm test», «should I check the file first»", false: "a decision only the owner can take: money, scope, priorities, access, taste that no one else knows" },
    ),
  }),
  thresholds: { min_p: { default: 0.6, min: 0.3, max: 0.95, about: "least p(yes) to record the question as one another agent could have answered" } },
  decide: (answers) => ({ decision: noulOf(answers, "routable") ?? 0 }),
  fallback: () => 0,
  describe: (decision) => String(Math.round(decision * 100) / 100),
});

export const complexity = defineJudgment<{ contract: Record<string, unknown> }, number | null>({
  id: COMPLEXITY_JUDGMENT_ID, version: 1, defaultMode: "active", timeoutMs: 8_000,
  stateBuilder: (input) => ({ task_contract: input.contract }),
  questions: () => ({
    size: score("How large is the work in `task_contract` for one coding agent, counting files to change, decisions to make and checks to pass?",
      ["trivial: one small change in one place", "small: a few related changes", "medium: several files or a design choice", "large or risky: many files, migration, or unclear interfaces"]),
  }),
  thresholds: {},
  decide: (answers) => {
    const answer = answers.size;
    return { decision: answer?.type === "score" ? Math.round((answer.score + 1) * 100) / 100 : null };
  },
  fallback: () => null,
  describe: (decision) => String(decision),
});

const clipTail = (text: string, chars: number) => (text.length <= chars ? text : text.slice(-chars));

export type SignalDeps = {
  db: Db; jev(): Jev | null;
  /** The final answer of a writer thread; null when it cannot be read. */
  finalAnswer?(threadId: string): Promise<string | null>;
  now?(): number;
  log?(line: string): void;
};

/** Accepted attempts of the last two days whose final answer has not been read yet, up to `limit`. */
export async function scanPromises(deps: SignalDeps, limit = 20): Promise<{ read: number; found: number }> {
  const jev = deps.jev(), now = deps.now?.() ?? Date.now();
  if (!jev || !jev.enabled() || !deps.finalAnswer) return { read: 0, found: 0 };
  const rows = deps.db.prepare(`SELECT a.id, a.thread_id AS threadId, r.project_id AS projectId FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state='accepted' AND a.thread_id IS NOT NULL AND a.updated_at>=? AND NOT EXISTS (SELECT 1 FROM lane_pilot_learning_signal s WHERE s.kind='unkept_promise' AND s.ref=a.id)
    ORDER BY a.updated_at DESC LIMIT ?`).all(now - 2 * DAY_MS, limit) as Array<{ id: string; threadId: string; projectId: string }>;
  let read = 0, found = 0;
  for (const row of rows) {
    const answer = await deps.finalAnswer(row.threadId).catch(() => null);
    if (!answer || answer.trim().length < 40) { insertSignal(deps.db, { kind: "unkept_promise", projectId: row.projectId, ref: row.id, p: null, detail: "no answer", at: now }); continue; }
    const text = maskPii(clipTail(answer, 2_500)).text;
    const verdict = await jev.judge(unkeptPromise, { answer: text }, { projectId: row.projectId, subject: row.id });
    read += 1;
    if (verdict.by !== "jev") continue;
    const hit = verdict.decision >= 0.6;
    insertSignal(deps.db, { kind: "unkept_promise", projectId: row.projectId, ref: row.id, p: verdict.decision, detail: hit ? text.slice(-220) : null, at: now });
    if (hit) found += 1;
  }
  return { read, found };
}

/** A question an agent put to the owner, judged at once (the caller does not wait for it). */
export async function noteOwnerQuestion(deps: SignalDeps, input: { projectId: string; threadId: string; question: string; detail?: string | undefined }): Promise<number | null> {
  const jev = deps.jev(), now = deps.now?.() ?? Date.now();
  if (!jev || !jev.enabled()) return null;
  const question = maskPii(input.question.slice(0, 600)).text, detail = maskPii((input.detail ?? "").slice(0, 800)).text;
  const ref = `${input.threadId}:${now}`;
  const verdict = await jev.judge(ownerQuestion, { question, detail }, { projectId: input.projectId, subject: ref });
  if (verdict.by !== "jev") return null;
  insertSignal(deps.db, { kind: "owner_question", projectId: input.projectId, ref, p: verdict.decision, detail: verdict.decision >= 0.6 ? question.slice(0, 220) : null, at: now });
  return verdict.decision;
}

/** Task contracts of the last week that have their attempts finished and have not been read, up to `limit`. */
export async function scanComplexity(deps: SignalDeps, limit = 20): Promise<{ read: number }> {
  const jev = deps.jev(), now = deps.now?.() ?? Date.now();
  if (!jev || !jev.enabled()) return { read: 0 };
  const rows = deps.db.prepare(`SELECT t.id, t.contract_json AS contract, r.project_id AS projectId, count(a.id) AS attempts, min(a.created_at) AS first, max(a.updated_at) AS last
    FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id JOIN lane_pilot_attempt a ON a.run_id=t.run_id AND a.task_id=t.id
    WHERE t.created_at>=? AND NOT EXISTS (SELECT 1 FROM lane_pilot_learning_signal s WHERE s.kind='complexity' AND s.ref=t.id)
      AND EXISTS (SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=t.run_id AND b.task_id=t.id AND b.state='accepted')
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt c WHERE c.run_id=t.run_id AND c.task_id=t.id AND c.state IN ('queued','spawn_requested','running','cancel_requested'))
    GROUP BY t.id ORDER BY t.created_at DESC LIMIT ?`).all(now - 7 * DAY_MS, limit) as Array<{ id: string; contract: string; projectId: string; attempts: number; first: number; last: number }>;
  let read = 0;
  for (const row of rows) {
    let contract: Record<string, unknown> = {};
    try { contract = JSON.parse(row.contract) as Record<string, unknown>; } catch { /* a contract that is not JSON has no size to read */ }
    const brief = { title: contract.title, objective: typeof contract.objective === "string" ? contract.objective.slice(0, 1_200) : null, owns_paths: contract.owns_paths, expected_outputs: contract.expected_outputs, acceptance: contract.acceptance, risk: contract.risk };
    const verdict = await jev.judge(complexity, { contract: brief }, { projectId: row.projectId, subject: row.id });
    if (verdict.by !== "jev" || verdict.decision === null) continue;
    read += 1;
    insertSignal(deps.db, { kind: "complexity", projectId: row.projectId, ref: row.id, p: verdict.decision, detail: JSON.stringify({ attempts: row.attempts, minutes: Math.round((row.last - row.first) / 60_000) }), at: now });
  }
  return { read };
}

/** Does Jev's reading of a contract predict the effort? The mean attempts and minutes per size, and the rank correlation with attempts. */
export function complexityReport(db: Db, since = 0) {
  const rows = listSignals(db, { kind: "complexity", since, limit: 500 }).flatMap((signal) => {
    try { const effort = JSON.parse(signal.detail ?? "{}") as { attempts?: number; minutes?: number }; return signal.p === null || effort.attempts === undefined ? [] : [{ size: signal.p, attempts: effort.attempts, minutes: effort.minutes ?? 0 }]; } catch { return []; }
  });
  const levels = new Map<number, { n: number; attempts: number; minutes: number }>();
  for (const row of rows) {
    const key = Math.min(4, Math.max(1, Math.round(row.size)));
    const level = levels.get(key) ?? { n: 0, attempts: 0, minutes: 0 };
    levels.set(key, { n: level.n + 1, attempts: level.attempts + row.attempts, minutes: level.minutes + row.minutes });
  }
  return {
    tasks: rows.length,
    bySize: [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([size, level]) => ({ size, tasks: level.n, meanAttempts: Math.round((level.attempts / level.n) * 100) / 100, meanMinutes: Math.round(level.minutes / level.n) })),
    rankCorrelationWithAttempts: rows.length >= 5 ? Math.round(spearman(rows.map((row) => row.size), rows.map((row) => row.attempts)) * 1000) / 1000 : null,
  };
}

function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1;
    for (let k = i; k <= j; k++) out[order[k]!.index] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
export function spearman(a: number[], b: number[]): number {
  const x = ranks(a), y = ranks(b), n = a.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i]! - mx) * (y[i]! - my); dx += (x[i]! - mx) ** 2; dy += (y[i]! - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
