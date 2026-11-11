/**
 * SMA k_lib_history: history search across the five Lane Pilot books — journal (past tasks), execution
 * (attempt reasons), transcripts (owner-message observations), lessons (learned items) and work books
 * (phase book parts). Every fragment passes the credential mask and is clipped before it leaves;
 * `episodes()` stays the PM-context path and is unchanged.
 */
import type Database from "better-sqlite3";
import { maskCredentials } from "@lane-pilot/kit";
import { minHits, queryWords, wordHits } from "../logic";
import { episodeCandidates } from "./tiers";
import { listProjectAttemptReasons } from "../../storage";
import { historyItems, historyObservations } from "../../learning";
import { listPhasePartsSince } from "../../phase";

type Db = Database.Database;

export const HISTORY_SOURCES = ["tasks", "execution", "transcripts", "lessons", "books"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];
export type HistoryFragment = { source: HistorySource; id: string; at: number; excerpt: string };

/** A fragment never shows a secret: credentials are masked, whitespace and length are bounded. */
const CLIP = 240;
const clip = (text: string): string => maskCredentials(text.replace(/\s+/g, " ").trim()).text.slice(0, CLIP);

export type HistorySearchOptions = {
  sources?: readonly HistorySource[];
  limit?: number;
  chain?: readonly string[];
};

/** Fragments of the five books whose text shares the query's words, best match first. */
export function historySearch(db: Db, projectId: string, query: string, options: HistorySearchOptions = {}): HistoryFragment[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const wanted = new Set<HistorySource>(options.sources?.length ? options.sources : HISTORY_SOURCES);
  const floor = minHits(words);
  const scored: Array<{ fragment: HistoryFragment; hits: number }> = [];
  const add = (source: HistorySource, id: string, at: number, text: string, searchable?: string) => {
    const hits = wordHits(searchable ?? text, words);
    if (hits >= floor) scored.push({ fragment: { source, id, at, excerpt: clip(text) }, hits });
  };
  if (wanted.has("tasks")) {
    for (const episode of episodeCandidates(db, projectId, query, 50, { chain: options.chain ?? [] })) {
      add("tasks", episode.taskId, episode.at, `${episode.title} (${episode.state})${episode.reason ? ` — ${episode.reason}` : ""}`, `${episode.title} ${episode.reason ?? ""}`);
    }
  }
  if (wanted.has("execution")) {
    for (const row of listProjectAttemptReasons(db, projectId)) {
      add("execution", row.taskId, row.at, `[${row.state}] ${row.reason ?? ""}`);
    }
  }
  if (wanted.has("transcripts")) {
    for (const row of historyObservations(db, projectId)) {
      add("transcripts", row.id, row.at, row.excerpt ?? row.body ?? "", `${row.excerpt ?? ""} ${row.body ?? ""}`);
    }
  }
  if (wanted.has("lessons")) {
    for (const row of historyItems(db, projectId)) {
      add("lessons", row.id, row.at, `[${row.kind}] ${row.text}`);
    }
  }
  if (wanted.has("books")) {
    for (const row of listPhasePartsSince(db, projectId, 0)) {
      add("books", row.phaseId, row.at, `[${row.section}/${row.kind}] ${row.text}`);
    }
  }
  return scored.sort((a, b) => b.hits - a.hits || b.fragment.at - a.fragment.at || a.fragment.id.localeCompare(b.fragment.id))
    .slice(0, options.limit ?? 10).map((row) => row.fragment);
}
