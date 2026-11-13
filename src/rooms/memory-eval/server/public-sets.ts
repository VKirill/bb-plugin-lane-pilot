import Database from "better-sqlite3";
import { addToIndexes, insertMemoryRecord, memoryRecordId, parseMemorySettings, pendingVectors, rememberQueryVector, searchMemoryRecords, storeMemoryRecords, storeVectors, trigramReady, weakAnswer } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../storage";
import { pmMemoryContext } from "../../memory/server";
import { standInEmbedding } from "./suite";

/**
 * Loaders for two public benchmarks, from files the operator downloads first (nothing here touches the network, and no test downloads):
 *
 *   LongMemEval-S (ICLR 2025): the 30 abstention questions (ids ending `_abs`) of `longmemeval_s_cleaned.json`.
 *     huggingface-cli download xiaowu0162/longmemeval-cleaned longmemeval_s_cleaned.json --repo-type dataset --local-dir /tmp/public-sets/longmemeval
 *   MemoryAgentBench (ICLR 2026) FactConsolidation: the HF dataset ships parquet; convert the FactConsolidation rows to JSON lines first,
 *   one row per line with `context` (numbered facts, one per line), `questions` and `answers`:
 *     huggingface-cli download ai-hyz/MemoryAgentBench --repo-type dataset --local-dir /tmp/public-sets/mab
 *     python3 -I -c "import pandas as pd,sys; pd.read_parquet(sys.argv[1]).to_json(sys.argv[2], orient='records', lines=True)" <file>.parquet /tmp/public-sets/mab/factconsolidation.jsonl
 *
 * Then `bb lane-pilot memory-eval --longmemeval <file>` / `--factcons <file>`. The dataset layouts above are as published when this was written
 * and were not checked against a downloaded copy: a file that does not match fails with a message naming the missing field.
 * The numbers use the suite's stand-in embedding, so they say whether the path is stable from version to version, not how it ranks against the papers.
 */
export type LongMemEvalCase = { id: string; question: string; rounds: string[] };
export type FactCase = { id: string; question: string; answers: string[]; facts: string[] };

const ROUND_CHARS = 700;

/** Reads a file as text: handed in, because a room's server code reads no files itself (the script and the tests pass `node:fs`). */
export type ReadText = (path: string) => string;

function readJson(path: string, read: ReadText): unknown[] {
  const text = read(path);
  if (path.endsWith(".jsonl")) return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}
const text = (value: unknown, where: string): string => { if (typeof value !== "string") throw new Error(`${where} is not text`); return value; };

/** The abstention questions of LongMemEval-S with their haystack: every user turn and the reply after it become one round. */
export function loadLongMemEvalAbstention(path: string, read: ReadText, limit = 30): LongMemEvalCase[] {
  const out: LongMemEvalCase[] = [];
  readJson(path, read).forEach((raw, index) => {
    const item = raw as Record<string, unknown>;
    const id = text(item.question_id, `item ${index} question_id`);
    if (!id.endsWith("_abs") || out.length >= limit) return;
    const sessions = item.haystack_sessions;
    if (!Array.isArray(sessions)) throw new Error(`item ${id}: haystack_sessions is missing`);
    const rounds: string[] = [];
    for (const session of sessions as Array<Array<{ role: string; content: string }>>) {
      for (let turn = 0; turn < session.length; turn++) {
        if (session[turn]!.role !== "user") continue;
        rounds.push(`${session[turn]!.content}${session[turn + 1]?.role === "assistant" ? ` / ${session[turn + 1]!.content}` : ""}`.replace(/\s+/g, " ").slice(0, ROUND_CHARS));
      }
    }
    out.push({ id, question: text(item.question, `item ${id} question`), rounds });
  });
  return out;
}

/** FactConsolidation rows: each question with the facts of its context in order (a later fact may replace an earlier one) and its accepted answers. */
export function loadFactConsolidation(path: string, read: ReadText, limit = 200): FactCase[] {
  const out: FactCase[] = [];
  readJson(path, read).forEach((raw, index) => {
    const row = raw as Record<string, unknown>;
    const facts = text(row.context, `row ${index} context`).split("\n").map((line) => line.replace(/^\s*\d+\.\s*/, "").trim()).filter((line) => line.length > 5);
    if (!Array.isArray(row.questions) || !Array.isArray(row.answers)) throw new Error(`row ${index}: questions and answers must be lists`);
    (row.questions as unknown[]).forEach((question, at) => {
      if (out.length >= limit) return;
      const answer = (row.answers as unknown[])[at];
      out.push({ id: `fc-${index}-${at}`, question: text(question, `row ${index} question ${at}`), answers: (Array.isArray(answer) ? answer : [answer]).map(String), facts });
    });
  });
  return out;
}

export type PublicReport = { name: string; questions: number; abstained?: { n: number; of: number }; answerInContext?: { n: number; of: number }; meanTokens: number };

const PROJECT = "public-set";
const scratch = (migrations: readonly string[]) => { const db = new Database(":memory:"); for (const statement of migrations) db.exec(statement); trigramReady(db); return db; };
const settings = parseMemorySettings({});

/** Rounds as notes, the question to the PM context: of the abstention questions, how many the stub judge (the answer gate's verdict, as in suite.ts) or the empty list abstains on. The reader is no longer warned; the real judge is measured with the bench. */
export function runLongMemEvalAbstention(migrations: readonly string[], cases: readonly LongMemEvalCase[]): PublicReport {
  let abstained = 0, tokens = 0;
  for (const item of cases) {
    const db = scratch(migrations);
    const now = Date.now();
    db.transaction(() => item.rounds.forEach((round, index) => {
      const id = memoryRecordId(PROJECT, "note", round);
      try { insertMemoryRecord(db, { id, projectId: PROJECT, kind: "note", content: round, conceptsJson: "[\"round\"]", sourceSha256: "public", createdAt: now - index, origin: "public-set" }); addToIndexes(db, PROJECT, id, round, ["round"]); } catch { /* a repeated round */ }
    }))();
    storeVectors(db as never, pendingVectors(db as never, 100_000).map((row) => ({ ...row, vector: standInEmbedding(row.content) })));
    rememberQueryVector(item.question, standInEmbedding(item.question));
    const packed = pmMemoryContext(db as unknown as LanePilotDatabase, PROJECT, settings, item.question, [], "pm");
    if (packed.nothingRelevant || weakAnswer(db as never, PROJECT, item.question, searchMemoryRecords(db as never, PROJECT, item.question, 100, "auto", "subagent", "", { chain: [] }), { audience: "subagent", personalBot: "" })) abstained++;
    tokens += packed.estimatedTokens;
    db.close();
  }
  return { name: "LongMemEval-S abstention", questions: cases.length, abstained: { n: abstained, of: cases.length }, meanTokens: cases.length ? Math.round(tokens / cases.length) : 0 };
}

/** The facts go through the write door in order (so an update replaces the old fact as it does in production); of the questions, how many got a context holding an accepted answer. */
export function runFactConsolidation(migrations: readonly string[], cases: readonly FactCase[]): PublicReport {
  const byContext = new Map<string, FactCase[]>();
  for (const item of cases) { const key = item.facts.join("\n"); byContext.set(key, [...(byContext.get(key) ?? []), item]); }
  let hit = 0, tokens = 0;
  for (const group of byContext.values()) {
    const db = scratch(migrations);
    const now = Date.now();
    group[0]!.facts.forEach((fact, index) => {
      try { storeMemoryRecords(db as never, { projectId: PROJECT, audience: "subagent", sourceSha256: "f".repeat(64), coreBudget: 9_999, noteBudget: 9_999_999, indexBudget: 9_999_999, now: now + index, entries: [{ kind: "note", content: fact, concepts: ["fact"] }] }); } catch { /* a fact the write door refuses */ }
    });
    storeVectors(db as never, pendingVectors(db as never, 100_000).map((row) => ({ ...row, vector: standInEmbedding(row.content) })));
    for (const item of group) {
      rememberQueryVector(item.question, standInEmbedding(item.question));
      const packed = pmMemoryContext(db as unknown as LanePilotDatabase, PROJECT, settings, item.question, [], "pm");
      if (item.answers.some((answer) => answer && packed.text.toLowerCase().includes(answer.toLowerCase()))) hit++;
      tokens += packed.estimatedTokens;
    }
    db.close();
  }
  return { name: "MemoryAgentBench FactConsolidation", questions: cases.length, answerInContext: { n: hit, of: cases.length }, meanTokens: cases.length ? Math.round(tokens / cases.length) : 0 };
}

export function formatPublic(report: PublicReport): string {
  const part = (label: string, value?: { n: number; of: number }) => value ? `, ${label} ${value.n}/${value.of}` : "";
  return `${report.name}: ${report.questions} questions${part("abstained", report.abstained)}${part("answer in context", report.answerInContext)}, ${report.meanTokens} tokens per context (stand-in embedding)`;
}
