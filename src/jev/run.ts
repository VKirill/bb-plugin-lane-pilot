import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { redactKnownDeep } from "../redact";
import { MAX_STATE_CHARS, type JevClient } from "./client";
import { MAX_QUESTIONS_PER_JUDGMENT, type Answers, type Decided, type Judgment, type JudgmentMode, type Thresholds } from "./registry";
import { insertReceipt, recordOutcome } from "./receipts";
import { jevEnabled, resolveMode, resolveThresholds, type JevSettings } from "./thresholds";
import type { AnswerSummary, JevBudget, JevCallResult, JevFailure, JevQuestion } from "./types";

/**
 * Runs judgments. `judge` asks one; `judgeMany` asks the same judgment about many inputs in one request (question ids
 * `<i>::<name>`); `judgeBundle` asks different judgments about the same state in one request (fan-out). Questions over the same
 * state share a request because they run in parallel on the model and the extra ones cost only their own tokens (the
 * parallel_questions cookbook: about 12x cheaper than one request each). A request holds at most 48 questions and about 80k
 * characters of state; longer batches are split.
 *
 * The verdict says who decided: `jev` (the decision rule was satisfied), `escalate` (the answers were not clear enough: the caller
 * hands the case to its stronger judge), or `fallback` (off, shadow, no key, a failure: the caller keeps the deterministic
 * behaviour). In `shadow` the judgment is asked and recorded but the verdict is always `fallback`, with `shadow` saying what
 * Jev would have done.
 */
export type JudgeContext = {
  projectId?: string | null;
  runId?: string | null;
  subject?: string | null;
  settings?: JevSettings | undefined;
  budget?: JevBudget | undefined;
  signal?: AbortSignal | undefined;
};

export type Verdict<D> =
  | { by: "jev"; decision: D; receiptId: number | null; answers: Answers }
  | { by: "escalate"; to: string; receiptId: number | null; answers: Answers }
  | { by: "fallback"; decision: D; status: "off" | "shadow" | JevFailure; receiptId: number | null; answers?: Answers; shadow?: Decided<D> };

export type Jev = {
  judge<I, D>(judgment: Judgment<I, D>, input: I, ctx?: JudgeContext): Promise<Verdict<D>>;
  judgeMany<I, D>(judgment: Judgment<I, D>, inputs: I[], ctx?: JudgeContext): Promise<Array<Verdict<D>>>;
  judgeBundle(items: Array<{ judgment: Judgment<any, any>; input: unknown }>, ctx?: JudgeContext): Promise<Array<Verdict<any>>>;
  /** Fills the label of a receipt once the stronger judge has answered (`agree` / `disagree`), for the calibration report. */
  outcome(receiptId: number | null, outcome: string): void;
  enabled(settings?: JevSettings): boolean;
};

type Entry = { judgment: Judgment<any, any>; input: unknown; mode: JudgmentMode; thresholds: Thresholds; state: unknown; stateText: string; questions: Record<string, JevQuestion> };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function summarize(answers: Answers): Record<string, AnswerSummary> {
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
    if (answer.type === "noul") return [id, { kind: "noul", value: Math.round(answer.noul * 1000) / 1000, top: [] } satisfies AnswerSummary];
    const top = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, p]) => [name, Math.round(p * 1000) / 1000] as [string, number]);
    return [id, { kind: answer.type, value: answer.type === "choice" ? answer.choice : Math.round(answer.score * 1000) / 1000, top, confidence: Math.round(answer.confidence * 1000) / 1000 } satisfies AnswerSummary];
  }));
}

export function createJev(deps: { client: JevClient; db?: Database.Database | null; log?: (message: string) => void }): Jev {
  const { client } = deps;

  const prepare = (judgment: Judgment<any, any>, input: unknown, ctx: JudgeContext): Entry => {
    const state = redactKnownDeep(judgment.stateBuilder(input));
    const questions = judgment.questions(input);
    if (Object.keys(questions).length > MAX_QUESTIONS_PER_JUDGMENT) throw new Error(`judgment ${judgment.id} asks more than ${MAX_QUESTIONS_PER_JUDGMENT} questions`);
    return { judgment, input, mode: resolveMode(judgment, ctx.settings), thresholds: resolveThresholds(judgment, ctx.settings), state, stateText: JSON.stringify(state) ?? "null", questions };
  };

  function receipt(entry: Entry, ctx: JudgeContext, call: JevCallResult, batchSize: number, decidedBy: "jev" | "fallback" | "escalated", decision: string | null, escalatedTo: string | null, answers?: Answers): number | null {
    if (!deps.db || entry.mode === "off") return null;
    try {
      return insertReceipt(deps.db, {
        judgment: entry.judgment.id, version: entry.judgment.version, model: call.ok ? call.model : entry.judgment.model ?? null, mode: entry.mode,
        projectId: ctx.projectId ?? null, runId: ctx.runId ?? null, subject: ctx.subject ?? null,
        inputSha256: sha256(entry.stateText), inputChars: entry.stateText.length, questions: Object.keys(entry.questions).length, batchSize,
        status: call.ok ? "ok" : call.status, ...(answers ? { answers: summarize(answers) } : {}), decision, decidedBy, escalatedTo, thresholds: entry.thresholds,
        latencyMs: call.latencyMs, tokensIn: call.ok ? Math.round(call.usage.input_tokens / batchSize) : null, tokensOut: call.ok ? Math.round(call.usage.output_tokens / batchSize) : null,
      });
    } catch (cause) {
      deps.log?.(`jev receipt not stored: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  function verdictFor(entry: Entry, ctx: JudgeContext, call: JevCallResult, batchSize: number, answers: Answers | null): Verdict<any> {
    const fallbackDecision = () => entry.judgment.fallback(entry.input);
    if (!call.ok || !answers) {
      const status = call.ok ? "invalid" as const : call.status;
      return { by: "fallback", decision: fallbackDecision(), status, receiptId: receipt(entry, ctx, call, batchSize, "fallback", null, null) };
    }
    let decided: Decided<unknown>;
    try { decided = entry.judgment.decide(answers, entry.thresholds, entry.input); } catch (cause) {
      deps.log?.(`jev ${entry.judgment.id}: decide failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { by: "fallback", decision: fallbackDecision(), status: "invalid", receiptId: receipt(entry, ctx, { ok: false, status: "invalid", error: "decide failed", latencyMs: call.latencyMs, attempts: call.attempts }, batchSize, "fallback", null, null, answers) };
    }
    const text = decided.escalate !== undefined ? `escalate:${decided.escalate}` : entry.judgment.describe(decided.decision);
    if (entry.mode === "shadow") return { by: "fallback", decision: fallbackDecision(), status: "shadow", shadow: decided, answers, receiptId: receipt(entry, ctx, call, batchSize, "fallback", text, null, answers) };
    if (decided.escalate !== undefined) return { by: "escalate", to: decided.escalate, answers, receiptId: receipt(entry, ctx, call, batchSize, "escalated", text, decided.escalate, answers) };
    return { by: "jev", decision: decided.decision, answers, receiptId: receipt(entry, ctx, call, batchSize, "jev", text, null, answers) };
  }

  async function run(entries: Entry[], ctx: JudgeContext): Promise<Array<Verdict<any>>> {
    const verdicts: Array<Verdict<any>> = new Array(entries.length);
    // Entries with the same state (and model) share requests; each request is cut at 48 questions and the state limit.
    const groups = new Map<string, number[]>();
    entries.forEach((entry, index) => {
      if (entry.mode === "off") { verdicts[index] = { by: "fallback", decision: entry.judgment.fallback(entry.input), status: "off", receiptId: null }; return; }
      const key = `${entry.judgment.model ?? ""}\n${entry.stateText}`;
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    const requests: number[][] = [];
    for (const members of groups.values()) {
      let current: number[] = [], count = 0, chars = 0;
      for (const index of members) {
        const entry = entries[index]!, size = Object.keys(entry.questions).length, extra = JSON.stringify(entry.questions).length;
        if (current.length && (count + size > MAX_QUESTIONS_PER_JUDGMENT || chars + extra > MAX_STATE_CHARS)) { requests.push(current); current = []; count = 0; chars = 0; }
        current.push(index); count += size; chars += extra;
      }
      if (current.length) requests.push(current);
    }
    await Promise.all(requests.map(async (members) => {
      const first = entries[members[0]!]!;
      const questions: Record<string, JevQuestion> = {};
      for (const index of members) for (const [id, question] of Object.entries(entries[index]!.questions)) questions[`${index}::${id}`] = question;
      const call = await client.call({ state: first.state, questions, ...(first.judgment.model ? { model: first.judgment.model } : {}) },
        { timeoutMs: Math.max(...members.map((index) => entries[index]!.judgment.timeoutMs)), budget: ctx.budget, signal: ctx.signal });
      for (const index of members) {
        const own: Answers | null = call.ok ? Object.fromEntries(Object.keys(entries[index]!.questions).map((id) => [id, call.answers[`${index}::${id}`]!])) : null;
        verdicts[index] = verdictFor(entries[index]!, ctx, call, members.length, own);
      }
    }));
    return verdicts;
  }

  return {
    enabled: (settings) => jevEnabled(settings),
    async judge(judgment, input, ctx = {}) { return (await run([prepare(judgment, input, ctx)], ctx))[0]!; },
    async judgeMany(judgment, inputs, ctx = {}) { return await run(inputs.map((input) => prepare(judgment, input, ctx)), ctx); },
    async judgeBundle(items, ctx = {}) { return await run(items.map((item) => prepare(item.judgment, item.input, ctx)), ctx); },
    outcome(receiptId, outcome) {
      if (receiptId === null || !deps.db) return;
      try { recordOutcome(deps.db, receiptId, outcome); } catch { /* a missing label only thins the calibration data */ }
    },
  };
}
