import { createHash } from "node:crypto";
import type { WorkflowEngine } from "./engine";

/**
 * The reducers of the joins in the built-in chains: pure functions from what the branches returned to the fields the join
 * declares (`join.uses: "reduce.<workflow>.<node>"`). Counting, filtering and sorting is code, never a model's reading of a
 * list. A tolerant join also hands over the branches that failed (`failed`, with their item and error) and every branch in order
 * (`rows`), so an id that never finished lands in the right list instead of vanishing.
 */
type Row = Record<string, unknown>;
export type JoinInput = {
  results: Row[];
  failed: Array<{ branch: number; item: unknown; error: string; blocked: boolean }>;
  rows: Array<{ branch: number; item: unknown; ok: boolean; data?: Row; error?: string; blocked?: boolean }>;
  items: unknown[];
};
export type Reducer = (input: JoinInput) => Record<string, unknown>;

const rec = (value: unknown): Row => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const idOf = (item: unknown, branch: number): string => str(rec(item).id) || (typeof item === "string" ? item : `#${branch}`);
const flat = (rows: JoinInput["results"], field: string): unknown[] => rows.flatMap((row) => list(row[field]));
const unique = <T,>(values: T[]): T[] => [...new Set(values)];
const sev = (findings: unknown[], level: string) => findings.filter((finding) => str(rec(finding).severity) === level).length;
/** Rows that finished, with their item, in branch order. */
const done = (input: JoinInput) => input.rows.filter((row) => row.ok).map((row) => ({ branch: row.branch, item: row.item, data: row.data ?? {} }));
const lost = (input: JoinInput) => input.rows.filter((row) => !row.ok);

/** A stable id for a finding the reviewer did not number: dimension, place and a hash of the evidence. */
const findingId = (finding: Row): string => str(finding.id) || `${str(finding.dimension) || "f"}:${str(finding.file)}:${finding.line ?? 0}:${createHash("sha256").update(str(finding.evidence) + str(finding.impact)).digest("hex").slice(0, 6)}`;

export const REDUCERS: Record<string, Reducer> = {
  "reduce.insights-post.posts": (input) => {
    const ok = done(input).filter((row) => row.data.status === "ok");
    return { ok_folders: ok.map((row) => str(row.data.post_folder)), summary_paths: ok.map((row) => str(row.data.summary_path)), ok_count: ok.length, failed_count: input.rows.length - ok.length };
  },
  "reduce.issue-discover.scan": (input) => { const findings = flat(input.results, "findings"); return { findings, count: findings.length }; },
  "reduce.lp.brainstorm.designs": (input) => {
    const ok = done(input).filter((row) => row.data.ok !== false);
    const failedRoles = [...lost(input).map((row) => str(row.item)), ...done(input).filter((row) => row.data.ok === false).map((row) => str(row.data.role) || str(row.item))];
    return { digests: ok.map((row) => row.data.digest), ok_count: ok.length, failed_roles: failedRoles.filter(Boolean) };
  },
  "reduce.lp.build.run_tasks": (input) => {
    const accepted: string[] = [], failedIds: string[] = [], blocked: string[] = [], findings: unknown[] = [], commits: string[] = [];
    for (const row of input.rows) {
      const id = idOf(row.item, row.branch);
      if (!row.ok) { (row.blocked ? blocked : failedIds).push(id); continue; }
      const data = row.data ?? {};
      const state = str(data.state);
      if (state === "accepted") { accepted.push(id); if (str(data.merge_commit)) commits.push(str(data.merge_commit)); }
      else if (state === "blocked" || state === "needs_human") blocked.push(id);
      else { failedIds.push(id); findings.push(...list(rec(data.verdict).findings)); }
    }
    return { accepted_ids: accepted, failed_ids: failedIds, blocked_ids: blocked, failed_findings: findings, accepted_count: accepted.length, failed_count: failedIds.length, blocked_count: blocked.length, merged_commits: unique(commits) };
  },
  "reduce.lp.review.dims": (input) => {
    // Most severe first: the majority check takes the first findings when there are more than it can check.
    const rank = (finding: Row) => ["critical", "high", "medium", "low", "info"].indexOf(str(finding.severity));
    const findings = flat(input.results, "findings").map((finding) => { const row = rec(finding); return { ...row, id: findingId(row) }; })
      .map((finding, at) => ({ finding, at })).sort((a, b) => (rank(a.finding) === -1 ? 9 : rank(a.finding)) - (rank(b.finding) === -1 ? 9 : rank(b.finding)) || a.at - b.at).map((entry) => entry.finding);
    return { findings, critical_count: sev(findings, "critical"), high_count: sev(findings, "high"), unchecked: lost(input).map((row) => str(row.item)).filter(Boolean) };
  },
  "reduce.lp.review.confirm": (input) => {
    const confirmed: string[] = [], dropped: string[] = [];
    for (const row of input.rows) {
      // The branch is the finding it was given: its own id wins over what the critic echoes back.
      const id = str(rec(row.item).id) || str(row.data?.finding_id) || findingId(rec(row.item));
      // A check that could not run drops nothing: only a majority of "not a defect" does.
      if (row.ok && row.data?.confirmed === false) dropped.push(id); else confirmed.push(id);
    }
    return { confirmed_ids: confirmed, dropped_ids: dropped };
  },
  "reduce.reels.render": (input) => {
    const ok = done(input).filter((row) => row.data.ok !== false);
    return { files: ok.map((row) => str(row.data.file)), ok_count: ok.length, failed_ids: [...lost(input).map((row) => idOf(row.item, row.branch)), ...done(input).filter((row) => row.data.ok === false).map((row) => str(row.data.clip_id) || idOf(row.item, row.branch))] };
  },
  "reduce.reels.verify": (input) => {
    const ok = done(input).filter((row) => row.data.ok !== false);
    return { ok_count: ok.length, bad_files: [...lost(input).map((row) => str(row.item)), ...done(input).filter((row) => row.data.ok === false).map((row) => str(row.data.clip_file) || str(row.item))].filter(Boolean), issues: flat(done(input).map((row) => row.data), "issues") };
  },
  "reduce.roadmap-driven.sessions": (input) => {
    const doneIds: string[] = [], blocked: string[] = [];
    for (const row of input.rows) (row.ok && row.data?.status === "done" ? doneIds : blocked).push(idOf(row.item, row.branch));
    return { done_ids: doneIds, blocked_ids: blocked, done_count: doneIds.length, blocked_count: blocked.length };
  },
  "reduce.security-audit.scan": (input) => {
    const findings = flat(input.results, "findings");
    return { findings, warnings: flat(input.results, "warnings"), critical_count: sev(findings, "critical"), high_count: sev(findings, "high") };
  },
  "reduce.seo-cocoon.evidence": (input) => {
    const ok = done(input).filter((row) => row.data.skipped !== true);
    return {
      findings_paths: ok.map((row) => str(row.data.findings_path)).filter(Boolean), sources: flat(input.results, "sources"),
      skipped_branches: [...done(input).filter((row) => row.data.skipped === true).map((row) => str(row.data.branch) || str(row.item)), ...lost(input).map((row) => str(row.item))].filter(Boolean),
    };
  },
  "reduce.seo-cocoon.briefs": (input) => { const ok = done(input).filter((row) => str(row.data.brief_path)); return { brief_paths: ok.map((row) => str(row.data.brief_path)), ok_count: ok.length }; },
  "reduce.web-research.search": (input) => {
    const seen = new Set<string>(), sources: unknown[] = [];
    for (const source of flat(input.results, "sources")) { const url = str(rec(source).url); if (url && seen.has(url)) continue; if (url) seen.add(url); sources.push(source); }
    const empty = done(input).filter((row) => !list(row.data.sources).length).map((row) => str(row.data.subquestion) || str(row.item));
    return { sources, source_count: sources.length, unavailable: [...lost(input).map((row) => str(row.item)), ...empty].filter(Boolean) };
  },
  // The score child answers per post of its batch; the answer names the post (`item`) or follows the batch order.
  "reduce.x-to-telegram-digest.score": (input) => {
    const kept: unknown[] = [], topics: string[] = [];
    for (const row of done(input)) {
      const batch = list(row.item);
      list(row.data.scores).forEach((raw, at) => {
        const score = rec(raw);
        if (score.keep === false) return;
        kept.push(score.item ?? score.post ?? batch[typeof score.index === "number" ? score.index : at] ?? raw);
        if (str(score.topic)) topics.push(str(score.topic));
      });
    }
    return { kept, topics: unique(topics), kept_count: kept.length };
  },
};

/** Registers every reducer on an engine (reentrant: they are pure). */
export function registerReducers(engine: WorkflowEngine): void {
  for (const [key, reduce] of Object.entries(REDUCERS)) {
    engine.register(key, { reentrant: true, run: async (ctx) => ({ output: reduce({
      results: (ctx.input.with.results as Row[] | undefined) ?? [], failed: (ctx.input.with.failed as JoinInput["failed"] | undefined) ?? [],
      rows: (ctx.input.with.rows as JoinInput["rows"] | undefined) ?? [], items: (ctx.input.with.items as unknown[] | undefined) ?? [],
    }) }) });
  }
}
