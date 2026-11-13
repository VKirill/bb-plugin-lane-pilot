import { createHash } from "node:crypto";
import { maskCredentials } from "@lane-pilot/kit";
import type { MemoryRecord } from "./settings";

/**
 * The last stage of an explicit memory search: a small model reads the vector's best notes next to the question and names the ones that help
 * answer it, or says none. This file is the pure part (the prompt, the mask, the reading of the reply, the receipt's shape); the HTTP call,
 * the key and the cache are `src/rooms/memory/server/memory-judge.ts`.
 *
 * Measured 2026-11-13 (docs/memory.md, «Round 2»; bench `memory-bench.md` R1): top-12 candidates, «all ids that help», gemini-3.8-flash,
 * secrets masked rather than dropped: 96.7% of the wanted notes delivered, 99.1% silence on questions the notes cannot answer.
 */

export const JUDGE_DEFAULTS = { enabled: true, model: "gemini-3.8-flash", fallbackModel: "gpt-6-luna", timeoutMs: 12_000, candidates: 12 } as const;
/** How much of one note the judge reads. */
export const JUDGE_NOTE_CHARS = 1200;
/** What a failed judge falls back to: the vector's first five, no warning (the reader is a strong model and decides). */
export const JUDGE_FALLBACK_TOP = 5;
export const JUDGE_MASK = "[REDACTED]";

export const JUDGE_SYSTEM = "You check whether a project's memory notes answer a question. Be strict: a note answers only if it states the specific fact the question asks for; a note on a merely related topic does not.";

const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;
const EXTRA_SHAPES = /\b(?:ak_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{10,})/g;
// The key stays and the value goes: «password=…», «passwd: …», «pwd = …».
const PASSWORD = /\b(pass(?:word|wd)|pwd)(\s*[=:]\s*)(?!\[REDACTED\])\S+/gi;

/** A long mixed-case run that carries a digit is a key; a path or an identifier is not (no digit, one case, or mostly slashes). */
const looksLikeBase64Secret = (run: string): boolean => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && (run.match(/\//g)?.length ?? 0) < run.length / 8;

/** A note's text with every secret-looking span replaced by `[REDACTED]`. The note stays in the list; the stored record is not touched. */
export function maskSecretsForJudge(text: string): string {
  let out = maskCredentials(text, JUDGE_MASK).text;
  out = out.replace(EXTRA_SHAPES, JUDGE_MASK).replace(HEX_RUN, JUDGE_MASK).replace(PASSWORD, (_m, key: string, glue: string) => `${key}${glue}${JUDGE_MASK}`);
  return out.replace(BASE64_RUN, (run) => (looksLikeBase64Secret(run) ? JUDGE_MASK : run));
}

export const queryHash = (query: string): string => createHash("sha256").update(query).digest("hex").slice(0, 32);

/** The candidates in an order fixed by the question (a seeded shuffle), so the judge does not read the vector's order as a hint and a repeat reads the same list. */
export function shuffledBy<T>(items: readonly T[], seedText: string): T[] {
  let state = parseInt(queryHash(seedText).slice(0, 8), 16) >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

/** The user message: the question, then the notes numbered from 1. */
export function judgeUserPrompt(query: string, notes: ReadonlyArray<Pick<MemoryRecord, "content">>): string {
  const blocks = notes.map((note, index) => `[${index + 1}]\n${maskSecretsForJudge(note.content).slice(0, JUDGE_NOTE_CHARS)}`);
  return `Question: ${query}\n\nNotes:\n\n${blocks.join("\n\n")}\n\nWhich of these notes contain facts that help answer the question? Reply with only the numbers of ALL notes that help, separated by commas, or the word none if no note helps.`;
}

/**
 * The numbers the judge named (1-based, in the order it gave them), `[]` for none, `null` for a reply that is neither (an error of the judge,
 * handled like a timeout). A reply longer than 40 characters is read by its last line: a model that thinks aloud puts the answer last.
 */
export function parseJudgeReply(reply: string, count: number): number[] | null {
  const text = reply.trim();
  if (!text) return null;
  const line = text.length > 40 ? text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop() ?? "" : text;
  const numbers = [...new Set([...line.matchAll(/\d+/g)].map((hit) => Number(hit[0])).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))];
  if (numbers.length) return numbers;
  return /\bnone\b/i.test(line) ? [] : null;
}

/** Why the judge's answer was not used; absent on a clean call. */
export type JudgeFallback = "disabled" | "no_key" | "timeout" | "http_error" | "unparsed" | "retry_failed";

/** One judge call as the receipt keeps it: no note text, ids and numbers only. */
export type JudgeReceipt = {
  surface: "search" | "pm_tool" | "writer";
  model: string;
  /** The model that answered after the first one failed with an HTTP error. */
  retriedWith?: string;
  candidates: string[];
  chosen: string[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  cached?: boolean;
  fallback?: JudgeFallback;
  /** The answer gate's probability for the same search, kept for analysis. Nothing shown to a reader depends on it. */
  gate?: number | null;
};
