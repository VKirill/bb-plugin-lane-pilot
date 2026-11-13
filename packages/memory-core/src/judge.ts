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

export const JUDGE_DEFAULTS = { enabled: true, model: "agy/gemini-3.8-flash-low", fallbackModel: "gemini-3.8-flash", timeoutMs: 12_000, candidates: 12 } as const;
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

/** What was read from a reply: the notes named in order, how many number-like answers fell outside the list (lost, counted), and whether it said none. */
export type ReadReply = { numbers: number[]; dropped: number; none: boolean };

const BARE_LIST = /^[\s,;"'`\[\]()\d.-]*$/;
const ARRAY_SPAN = /\[[\s,"'`\[\]\d]*\]/g;

/**
 * Reads a reply that names notes by number, in any of the shapes models answer in: `[1,2]`, `["1","2"]`, `["[1]","[2]"]` (also over several lines or
 * inside a code fence), `1, 2`, `1 2`, a numbered list («1. note 3»), or prose that thinks aloud and puts the answer on its last line. Numbers outside
 * 1..count are not used but counted (`dropped`), so a reply that lost answers does not do it silently. `null`: nothing readable and not «none».
 */
export function readJudgeReply(reply: string, count: number): ReadReply | null {
  const text = reply.replace(/```[a-z]*/gi, "").trim();
  if (!text) return null;
  const ints = (part: string) => [...part.matchAll(/\d+/g)].map((hit) => Number(hit[0]));
  let found: number[] | null = null;
  if (BARE_LIST.test(text)) found = ints(text);
  if (!found) {
    // A JSON-looking array anywhere in the text: the one that names the most numbers (the last on a tie).
    let best: number[] = [];
    for (const span of text.match(ARRAY_SPAN) ?? []) { const got = ints(span); if (got.length >= best.length) best = got; }
    if (best.length) found = best;
  }
  const lines = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (!found && text.length <= 60) found = ints(text);
  if (!found) {
    // A numbered list: «1. [3]», «2) note 1»: the number after the ordinal is the note.
    const listed = lines.map((line) => /^\s*\d+\s*[.):]\s*(?:note\s*|#)?\[?(\d+)\]?/i.exec(line)?.[1]).filter((value): value is string => value !== undefined).map(Number);
    if (listed.length >= 2) found = listed;
  }
  if (!found) found = ints(last);
  const numbers = [...new Set(found.filter((n) => Number.isInteger(n) && n >= 1 && n <= count))];
  const dropped = found.filter((n) => !(Number.isInteger(n) && n >= 1 && n <= count)).length;
  if (numbers.length) return { numbers, dropped, none: false };
  if (/\bnone\b/i.test(last) || /\bnone\b/i.test(text.length <= 60 ? text : "")) return { numbers, dropped, none: true };
  return null;
}

/**
 * The numbers the judge named (1-based, in the order it gave them), `[]` for none, `null` for a reply that is neither (an error of the judge,
 * handled like a timeout). The reading is `readJudgeReply`.
 */
export function parseJudgeReply(reply: string, count: number): number[] | null {
  const read = readJudgeReply(reply, count);
  return read ? read.numbers : null;
}

/** The reranker's system prompt: it only orders, it never drops a note and never says none. */
export const RERANK_SYSTEM = "You order a project's memory notes by how useful they are for answering a question. Every note stays in the list; you only change the order.";

/** The reranker's user message: the question, then every note by number and text only (no ids, no file names), in the order the search gave them. */
export function rerankUserPrompt(query: string, notes: ReadonlyArray<Pick<MemoryRecord, "content">>): string {
  const blocks = notes.map((note, index) => `[${index + 1}]\n${maskSecretsForJudge(note.content).slice(0, JUDGE_NOTE_CHARS)}`);
  return `Question: ${query}\n\nNotes:\n\n${blocks.join("\n\n")}\n\nReorder ALL ${notes.length} notes from the most useful for answering the question to the least useful. Reply with only the numbers of all ${notes.length} notes in the new order, separated by commas. Do not leave any note out and do not answer none.`;
}

/**
 * The full order a rerank reply makes: the numbers it gave (valid, once each, in its order), then every number it left out in the previous order.
 * No reply (`null`: a timeout, an error, an unreadable answer) is the previous order. The result always has `count` numbers.
 */
export function permutationOf(named: readonly number[] | null, count: number): number[] {
  const out: number[] = [], seen = new Set<number>();
  for (const n of named ?? []) if (Number.isInteger(n) && n >= 1 && n <= count && !seen.has(n)) { seen.add(n); out.push(n); }
  for (let n = 1; n <= count; n++) if (!seen.has(n)) out.push(n);
  return out;
}

/** The keyword translation of a question for the door lock (`memory.door_lock = translated`): one cheap call, English keywords only. */
export const TRANSLATE_SYSTEM = "You turn a question about a software project into English search keywords for the project's notes, which are mostly in English.";
export const translateUserPrompt = (query: string): string => `Question: ${maskSecretsForJudge(query).slice(0, 1500)}\n\nWrite 3 to 8 English keywords or short technical terms that notes answering this question would contain (translate Russian words into English; keep identifiers, file names and product names as written). Reply with only the keywords, separated by commas.`;
/** The keywords of a reply: words of three letters or more, lower case, at most twelve. */
export function parseKeywords(reply: string): string[] {
  const words = reply.replace(/```[a-z]*/gi, " ").toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [];
  return [...new Set(words.filter((word) => !/^(?:keywords?|english|terms?)$/.test(word)))].slice(0, 12);
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
  /** `rerank`: the judge only reordered the candidates; absent or `filter`: it named the helpful ones. */
  mode?: "filter" | "rerank";
  /** Answers in the reply that could not be used (a number outside the list), or 1 for a reply nothing could be read from. Absent on a clean read. */
  unparsed?: number;
  /** The answer gate's probability for the same search, kept for analysis. Nothing shown to a reader depends on it. */
  gate?: number | null;
};
