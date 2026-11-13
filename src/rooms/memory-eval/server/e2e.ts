import Database from "better-sqlite3";
import { NOTHING_RELEVANT, estimateTokens } from "@lane-pilot/memory-core";
import { SUITE_CASES, SUITE_NOTES, type SuiteCase, type SuiteFamily } from "./suite-fixture";
import { plantSuite, runCase, type CaseResult } from "./suite";

/**
 * The end-to-end mode of the suite (`bb lane-pilot memory-eval --e2e`, never in CI): the retrieved context and the question go to a model as the
 * PM would get them, and an LLM judge scores what the model did with them: answered correctly, abstained correctly, or made something up.
 * It measures the last step the retrieval score cannot see: whether the reader obeys the empty list (research of 2026-11-13, item 1; the `weakMatch` warning it once also tested is gone, it cost 4.9 points of accuracy).
 *
 * The model is injected (`ModelCall`): the command hands in the plugin's one-shot analyzer path, a test hands in the stub below.
 */
export type ModelCall = (prompt: string, label: "answer" | "judge", caseId: string) => Promise<string>;

export const E2E_VERDICTS = ["answered-correct", "abstained-correct", "hallucinated", "abstained-wrong"] as const;
export type E2eVerdict = (typeof E2E_VERDICTS)[number];

/** The words the reader must say when memory does not answer; the judge and the stub look for them. */
export const ABSTAIN_PHRASE = "NOT IN MEMORY";

export type E2eRow = { id: string; family: SuiteFamily; kind: string; verdict: E2eVerdict | "unparsed"; answer: string; judgeNone: boolean; nothingRelevant: boolean };
export type E2eReport = {
  rows: E2eRow[];
  counts: Record<E2eVerdict | "unparsed", number>;
  /** Of the cases that have an answer in reach: how many the model answered correctly. */
  answeredCorrect: { n: number; of: number };
  /** Of the cases whose right answer is nothing: how many the model declined. */
  abstainedCorrect: { n: number; of: number };
  hallucinated: { n: number; of: number };
  calls: number; tokensIn: number; tokensOut: number;
};

export function answerPrompt(question: string, context: string, nothingRelevant: boolean): string {
  return [
    "You are the project manager of a software project. Answer the owner's question using only the project memory below.",
    `If the memory does not answer the question, reply with exactly "${ABSTAIN_PHRASE}" and nothing else. Do not guess and do not fill the gap from general knowledge.`,
    "",
    "MEMORY:",
    nothingRelevant ? NOTHING_RELEVANT : context,
    "",
    `QUESTION: ${question}`,
  ].join("\n");
}

export function judgePrompt(question: string, expected: string[], forbidden: string[], answer: string): string {
  return [
    "You grade an answer a project manager gave from project memory. Reply in one line of this form: {\"verdict\":\"<one label>\"}.",
    "Verdicts:",
    "- answered-correct: EXPECTED holds facts and the answer states them correctly, without using any FORBIDDEN fact.",
    "- abstained-correct: EXPECTED is NOTHING and the answer says the memory does not know (or asks to read the code or the owner) without asserting any fact about the question.",
    "- hallucinated: the answer asserts a fact that EXPECTED does not support: details where EXPECTED is NOTHING, a contradiction of EXPECTED, or a FORBIDDEN (outdated or not permitted) fact.",
    "- abstained-wrong: EXPECTED holds facts but the answer declines to answer.",
    "",
    `QUESTION: ${question}`,
    "EXPECTED:",
    ...(expected.length ? expected.map((text) => `- ${text}`) : ["NOTHING"]),
    "FORBIDDEN:",
    ...(forbidden.length ? forbidden.map((text) => `- ${text}`) : ["(none)"]),
    "ANSWER:",
    answer,
  ].join("\n");
}

export function parseVerdict(text: string): E2eVerdict | "unparsed" {
  const named = /"verdict"\s*:\s*"([a-z-]+)"/.exec(text)?.[1];
  const found = E2E_VERDICTS.find((verdict) => verdict === named) ?? E2E_VERDICTS.find((verdict) => text.includes(verdict));
  return found ?? "unparsed";
}

const contentOf = (key: string): string => SUITE_NOTES.find((note) => note.key === key)?.content ?? key;

/** The cases a `--limit` keeps: PM questions only (a writer's brief is not asked a question), taken round-robin over the families so a small limit still touches each. */
export function e2eCases(limit?: number, cases: readonly SuiteCase[] = SUITE_CASES): SuiteCase[] {
  const asked = cases.filter((item) => item.surface === "pm" && !item.notes);
  if (!limit || limit >= asked.length) return asked;
  const lanes = new Map<string, SuiteCase[]>();
  for (const item of asked) lanes.set(item.family, [...(lanes.get(item.family) ?? []), item]);
  const out: SuiteCase[] = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const lane of lanes.values()) if (lane[round] && out.length < limit) { out.push(lane[round]!); took = true; }
    if (!took) break;
  }
  return out;
}

export async function runE2e(migrations: readonly string[], call: ModelCall, options: { limit?: number; cases?: readonly SuiteCase[] } = {}): Promise<E2eReport> {
  const plant = plantSuite(migrations);
  const counts: E2eReport["counts"] = { "answered-correct": 0, "abstained-correct": 0, hallucinated: 0, "abstained-wrong": 0, unparsed: 0 };
  const rows: E2eRow[] = [];
  let calls = 0, tokensIn = 0, tokensOut = 0;
  const ask = async (prompt: string, label: "answer" | "judge", caseId: string) => {
    const reply = await call(prompt, label, caseId);
    calls++; tokensIn += estimateTokens(prompt); tokensOut += estimateTokens(reply);
    return reply;
  };
  try {
    for (const item of e2eCases(options.limit, options.cases)) {
      const got: CaseResult = runCase(plant, item);
      const answer = (await ask(answerPrompt(item.question, got.context, got.nothingRelevant), "answer", item.id)).trim();
      const expected = item.expect === "nothing" ? [] : item.expect.map(contentOf);
      const verdict = parseVerdict(await ask(judgePrompt(item.question, expected, (item.forbid ?? []).map(contentOf), answer), "judge", item.id));
      counts[verdict]++;
      rows.push({ id: item.id, family: item.family, kind: item.kind, verdict, answer, judgeNone: got.judgeNone, nothingRelevant: got.nothingRelevant });
    }
  } finally { (plant.db as unknown as Database.Database).close(); }
  const withAnswer = rows.filter((row) => caseOf(row, options.cases).expect !== "nothing"), without = rows.filter((row) => caseOf(row, options.cases).expect === "nothing");
  return { rows, counts, calls, tokensIn, tokensOut,
    answeredCorrect: { n: withAnswer.filter((row) => row.verdict === "answered-correct").length, of: withAnswer.length },
    abstainedCorrect: { n: without.filter((row) => row.verdict === "abstained-correct").length, of: without.length },
    hallucinated: { n: rows.filter((row) => row.verdict === "hallucinated").length, of: rows.length } };
}
const caseOf = (row: E2eRow, list: readonly SuiteCase[] = SUITE_CASES): SuiteCase => list.find((item) => item.id === row.id)!;

export function formatE2e(report: E2eReport): string {
  const rate = (value: { n: number; of: number }) => `${value.n}/${value.of}${value.of ? ` (${Math.round((value.n / value.of) * 100)}%)` : ""}`;
  const byFamily = new Map<string, E2eRow[]>();
  for (const row of report.rows) byFamily.set(row.family, [...(byFamily.get(row.family) ?? []), row]);
  const lines = [...byFamily].map(([family, rows]) => `${family}  ${E2E_VERDICTS.map((verdict) => `${verdict} ${rows.filter((row) => row.verdict === verdict).length}`).join(", ")}${rows.some((row) => row.verdict === "unparsed") ? `, unparsed ${rows.filter((row) => row.verdict === "unparsed").length}` : ""}`);
  const bad = report.rows.filter((row) => row.verdict === "hallucinated" || row.verdict === "abstained-wrong" || row.verdict === "unparsed").map((row) => `  ${row.id}: ${row.verdict}${row.judgeNone ? " (stub judge: none)" : ""}${row.nothingRelevant ? " (empty list)" : ""}: ${row.answer.replace(/\s+/g, " ").slice(0, 140)}`);
  return [`memory e2e: ${report.rows.length} questions, ${report.calls} model calls`,
    `answered correctly   ${rate(report.answeredCorrect)}`, `abstained correctly  ${rate(report.abstainedCorrect)}`, `hallucinated         ${rate(report.hallucinated)}`,
    ...lines, `cost: ~${report.tokensIn} tokens in, ~${report.tokensOut} tokens out (estimated, 4 characters a token)`, ...(bad.length ? ["to look at:", ...bad] : [])].join("\n");
}

/**
 * A stand-in model for dry runs and tests, no network. As the PM it answers with the memory line sharing most words with the question, or
 * the abstain phrase when fewer than two words are shared; as the judge it compares the answer with EXPECTED and FORBIDDEN by text.
 */
export const stubModel: ModelCall = async (prompt, label) => {
  if (label === "answer") {
    const question = /QUESTION: (.*)$/s.exec(prompt)?.[1] ?? "";
    const memory = (/MEMORY:\n(.*)\n\nQUESTION:/s.exec(prompt)?.[1] ?? "");
    const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const asked = words(question);
    let best = "", bestScore = 0;
    for (const line of memory.split("\n").filter((entry) => entry.startsWith("- ["))) {
      const score = [...words(line)].filter((word) => asked.has(word)).length;
      if (score > bestScore) { best = line.replace(/^- \[[^\]]*\] /, ""); bestScore = score; }
    }
    return bestScore >= 2 ? best : ABSTAIN_PHRASE;
  }
  const part = (name: string, next: string) => new RegExp(`${name}:\\n(.*?)\\n${next}:`, "s").exec(prompt)?.[1] ?? "";
  const expected = part("EXPECTED", "FORBIDDEN"), forbidden = part("FORBIDDEN", "ANSWER");
  const answer = prompt.split("\nANSWER:\n")[1] ?? "";
  const abstained = answer.includes(ABSTAIN_PHRASE);
  const facts = (block: string) => block.split("\n").filter((entry) => entry.startsWith("- ")).map((entry) => entry.slice(2));
  const verdict: E2eVerdict = expected.trim() === "NOTHING" ? (abstained ? "abstained-correct" : "hallucinated")
    : abstained ? "abstained-wrong"
    : facts(forbidden).some((text) => answer.includes(text)) ? "hallucinated"
    : facts(expected).every((text) => answer.includes(text)) ? "answered-correct" : "hallucinated";
  return JSON.stringify({ verdict });
};
