import { homedir } from "node:os";
import { join } from "node:path";
import { sensitivityFloor, type Source } from "./model";
import type { CollectResponse, HostSource } from "./ops";
import type { Store } from "./store";
import { runGit, type SourceRecord, type SourceScan } from "./sources/common";
import { scanJournals, scanRegistry } from "./sources/docs";
import { scanElba } from "./sources/elba";
import { scanGit } from "./sources/git";
import { scanBbMemory, scanClaudeMemory } from "./sources/memories";
import { scanTelegram } from "./sources/telegram";

/**
 * Collection (A3, M1b): the sources that live on the owner's machine are scanned on the host and come back as raw
 * records; the hub stores them through the same store door as every other write, so the evidence rules cannot differ
 * by path. `scanSources` is the host half, `storeCollectResults` the hub half; `collectSources` composes them for the
 * file store and the tests. `plan` counts what a run would store, by the same rules, and changes nothing.
 */
export type CollectRequest = { mode: "plan" | "run"; sources: readonly HostSource[]; roots?: readonly string[] | undefined; authors?: readonly string[] | undefined; telegramChannels?: readonly string[] | undefined;
  /** The hub's memory catalog for the bb-memory source; when absent the host asks its own `bb` CLI. */
  bbMemories?: readonly { id?: string; name?: string; summary?: string; kind?: string; scope?: string; tags?: string[]; importance?: number; version?: number; updatedAt?: number }[] | undefined;
  since: number; until: number };

async function defaultAuthors(): Promise<string[]> {
  const found: string[] = [];
  for (const key of ["user.email", "user.name"]) {
    try { const value = (await runGit(["config", "--global", key], homedir(), 10_000)).trim(); if (value) found.push(value); } catch { /* not set */ }
  }
  return found;
}

export type CollectSeams = { home?: string; scans?: Partial<Record<HostSource, (request: CollectRequest & { roots: readonly string[]; authors: readonly string[] }) => Promise<SourceScan>>> };

/** What one source's scan handed back: items looked at, the raw records, and a note or an error — no store involved. */
export type SourceScanResult = { source: HostSource; items: number; records: SourceRecord[]; note?: string; error?: string };

/** The host half: read the requested sources on this machine. A failing source is an entry, never a thrown batch. */
export async function scanSources(request: CollectRequest, seams: CollectSeams = {}): Promise<SourceScanResult[]> {
  const home = seams.home ?? homedir();
  const roots = request.roots?.length ? request.roots : [join(home, "Documents")];
  const authors = request.authors?.length ? request.authors : await defaultAuthors();
  const full = { ...request, roots, authors };
  const scanners: Record<HostSource, NonNullable<CollectSeams["scans"]>[HostSource]> = {
    git: async () => await scanGit({ roots, authors, since: request.since, until: request.until, home }),
    journal: async () => await scanJournals(roots, 0, request.until),
    registry: async () => await scanRegistry(roots, request.until),
    "claude-memory": async () => await scanClaudeMemory(home),
    "bb-memory": async () => await scanBbMemory(undefined, roots[0] ?? "", request.bbMemories),
    // Off until the owner switches them on (the caller skips a source that is off): the owner's own channels, and the deal files of the Elba skill.
    telegram: async () => await scanTelegram({ channels: request.telegramChannels ?? [], since: request.since, until: request.until, home }),
    elba: async () => await scanElba(roots),
    ...seams.scans,
  };
  const out: SourceScanResult[] = [];
  for (const source of request.sources) {
    let scan: SourceScan;
    try { scan = await scanners[source]!(full); } catch (cause) {
      out.push({ source, items: 0, records: [], error: cause instanceof Error ? cause.message.slice(0, 200) : String(cause) });
      continue;
    }
    out.push({ source, items: scan.items, records: scan.records, ...(scan.note ? { note: scan.note } : {}) });
  }
  return out;
}

/** The hub half: store each enabled source's raw records through the store door and shape the collect answer. */
export function storeCollectResults(store: Store, request: CollectRequest, scans: readonly SourceScanResult[]): CollectResponse["sources"] {
  const bySource = new Map(scans.map((scan) => [scan.source, scan]));
  const out: CollectResponse["sources"] = [];
  for (const source of request.sources) {
    const enabled = store.sourceEnabled(source);
    const scan = bySource.get(source);
    if (!enabled) { out.push({ source, enabled, items: 0, records: 0, outcome: {}, reasons: {}, byKind: {}, bySensitivity: {}, note: "switched off" }); continue; }
    if (!scan) continue;
    if (scan.error !== undefined) { out.push({ source, enabled, items: 0, records: 0, outcome: {}, reasons: {}, byKind: {}, bySensitivity: {}, error: scan.error }); continue; }
    const apply = () => store.upsertMany(scan.records, { actor: `auto:${source}`, reason: `initial load of ${source}`, now: request.until });
    const results = request.mode === "run"
      ? store.transaction(() => { const stored = apply(); store.setCheckpoint(source as Source, request.until, { items: scan.items }, request.until); return stored; })
      : store.dryRun(apply);
    const outcome: Record<string, number> = {}, reasons: Record<string, number> = {};
    results.forEach((result) => { outcome[result.action] = (outcome[result.action] ?? 0) + 1; if (result.reason) reasons[result.reason.split(":")[0]!] = (reasons[result.reason.split(":")[0]!] ?? 0) + 1; });
    out.push({ source, enabled, items: scan.items, records: scan.records.length, outcome, reasons, ...tally(scan.records), ...(scan.note ? { note: scan.note } : {}) });
  }
  return out;
}

/** Scan and store in one call — the file store's path (tests, the legacy single-machine world). */
export async function collectSources(request: CollectRequest, store: Store, seams: CollectSeams = {}): Promise<CollectResponse> {
  const wanted = request.sources.filter((source) => store.sourceEnabled(source));
  const scans = await scanSources({ ...request, sources: wanted }, seams);
  return { mode: request.mode, sources: storeCollectResults(store, request, scans) };
}

/** What the records are, by kind and by the sensitivity the store will give them (never `public`). */
function tally(records: readonly SourceRecord[]): { byKind: Record<string, number>; bySensitivity: Record<string, number> } {
  const byKind: Record<string, number> = {}, bySensitivity: Record<string, number> = {};
  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    const floor = sensitivityFloor({ kind: record.kind, title: record.title, statement: record.statement ?? "", attributes: record.attributes ?? {} });
    const level = floor === "sensitive" || record.sensitivity === "sensitive" ? "sensitive" : "private";
    bySensitivity[level] = (bySensitivity[level] ?? 0) + 1;
  }
  return { byKind, bySensitivity };
}
