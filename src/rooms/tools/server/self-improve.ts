import type Database from "better-sqlite3";
import { acceptedTaskCountsByProject } from "../../storage";
import { projectTokenTotalsSince } from "../../usage";
import { listMemoryMisses } from "@lane-pilot/memory-core";
import { ruleRecurrences } from "@lane-pilot/run-insights";
import { forecastReport } from "../../forecast/server";
import { listClasses } from "../../wall";

/**
 * Self-improvement and measurement (SMA map: Self-improvement and measurement):
 * - miss curriculum: the queries memory failed to answer, grouped, the next lessons to write (sma curriculum, Miss curriculum);
 * - excavation of foreign history: fix commits of another repository as lesson candidates (sma excavate);
 * - approvals suggest: owner decisions that repeat the same way, as candidates for an automatic rule (sma approvals suggest);
 * - cost per verified result: tokens per accepted task, per project and kind;
 * - local HTML report: the SMA map, the spend and the acceptance numbers on one page.
 */
type Db = Pick<Database.Database, "prepare">;

export function missCurriculum(db: Db, days = 30, now = Date.now()) {
  // The curriculum counts the whole window; the owner reader's default page is the tier report's 50.
  const rows = listMemoryMisses(db, now - days * 86_400_000, undefined, 1_000_000_000);
  const by = new Map<string, { projectId: string; query: string; count: number }>();
  for (const row of rows) {
    const key = `${row.projectId}\n${row.query.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const entry = by.get(key) ?? { projectId: row.projectId, query: row.query.slice(0, 200), count: 0 };
    entry.count += 1;
    by.set(key, entry);
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, 50);
}

/** One weak spot: a repeated miss from one of four sources (SMA k_lib_curriculum). */
export type CurriculumCluster = { source: "memory" | "forecast" | "wall" | "rule"; key: string; count: number; sample: string; projectId: string };

/**
 * The four miss sources of the weekly curriculum, each grouped and ranked by count, top 50 per source:
 * memory misses by query, forecast rows whose file or first-try score missed grouped by area, open wall classes by
 * class key, and rules a picked attempt failed on anyway grouped by rule id.
 */
/** Rows any one curriculum source reads: every source is limited to the window and to this many rows (the newest). */
export const CURRICULUM_ROW_BOUND = 5000;

export function curriculumClusters(db: Db, days = 7, now = Date.now()): CurriculumCluster[] {
  const since = now - days * 86_400_000;
  const clusters: CurriculumCluster[] = [];

  const byQuery = new Map<string, CurriculumCluster>();
  for (const row of listMemoryMisses(db as never, since, undefined, CURRICULUM_ROW_BOUND)) {
    const key = row.query.toLowerCase().replace(/\s+/g, " ").trim();
    const hit = byQuery.get(`${row.projectId}\n${key}`) ?? { source: "memory" as const, key: row.query.slice(0, 200), count: 0, sample: row.query.slice(0, 200), projectId: row.projectId };
    hit.count += 1;
    byQuery.set(`${row.projectId}\n${key}`, hit);
  }
  clusters.push(...[...byQuery.values()].sort((a, b) => b.count - a.count).slice(0, 50));

  const byArea = new Map<string, CurriculumCluster>();
  for (const row of forecastReport(db as never, { days, now, limit: CURRICULUM_ROW_BOUND }).scored) {
    const fileMiss = (row.score.paths?.unplanned.length ?? 0) + (row.score.paths?.untouched.length ?? 0) > 0;
    if (!fileMiss && row.score.firstTry.hit) continue;
    const area = row.area ?? "(unknown)";
    const hit = byArea.get(`${row.projectId}\n${area}`) ?? { source: "forecast" as const, key: area, count: 0, sample: row.taskId, projectId: row.projectId };
    hit.count += 1;
    byArea.set(`${row.projectId}\n${area}`, hit);
  }
  clusters.push(...[...byArea.values()].sort((a, b) => b.count - a.count).slice(0, 50));

  for (const wall of listClasses(db as never, { state: "open", since, limit: 50 }))
    clusters.push({ source: "wall", key: wall.classKey, count: wall.total, sample: wall.reasonNorm.slice(0, 200), projectId: "" });

  const rules = ruleRecurrences(db as never, since, CURRICULUM_ROW_BOUND)
    .map((row) => ({ source: "rule" as const, key: row.ruleId, count: row.count, sample: row.sampleTaskId, projectId: row.projectId }));
  clusters.push(...rules.sort((a, b) => b.count - a.count).slice(0, 50));

  return clusters;
}

/** The weekly weak-spots brief (SMA k_v_curriculum): each top cluster as one imperative line — trigger, what failed,
 *  where the fact should live — at most 10 lines. The Monday job stores it at lp.curriculum.latest; nothing injects it. */
export function weakSpotsBrief(clusters: readonly CurriculumCluster[], now = new Date()): string {
  const line = (c: CurriculumCluster) => c.source === "memory"
    ? `WHEN a ${c.projectId} question like «${c.sample}» returns nothing → write the fact to memory (${c.count} misses)`
    : c.source === "forecast"
    ? `WHEN planning in ${c.projectId}/${c.key} → check the file list and the first-try guess against the last merge (${c.count} misses)`
    : c.source === "wall"
    ? `WHEN ${c.key} hits the wall again → fix the class's rail, not the retry (${c.count} hits)`
    : `WHEN rule ${c.key} was picked and the attempt failed anyway (${c.projectId}) → revise the rule's wording (${c.count} recurrences)`;
  return clusters.slice(0, 10).map(line).join("\n");
}
export const CURRICULUM_KV_KEY = "lp.curriculum.latest";

/** The Monday job's body: nothing unless the global setting `curriculum.weekly` is `on`; then the clusters of the last 7 days, the brief, one kv write. Returns the number of lines, or null when it did not run. */
export async function runCurriculumWeekly(db: Db, kv: { set(key: string, value: unknown): Promise<unknown> }, settings: Record<string, unknown>, now = Date.now()): Promise<number | null> {
  if (String(settings["curriculum.weekly"] ?? "off") !== "on") return null;
  const brief = weakSpotsBrief(curriculumClusters(db, 7, now));
  await kv.set(CURRICULUM_KV_KEY, brief);
  return brief.split("\n").filter(Boolean).length;
}

/** Lesson candidates from another repository's history: commits whose subject says it fixed something, with the files they touched. */
export function excavate(gitLog: string): Array<{ commit: string; subject: string; files: string[] }> {
  const out: Array<{ commit: string; subject: string; files: string[] }> = [];
  for (const block of gitLog.split("\n\u0001").map((chunk) => chunk.replace(/^\u0001/, "")).filter(Boolean)) {
    const [head, ...files] = block.split("\n").filter(Boolean);
    const [commit, subject] = (head ?? "").split("\u0002");
    if (commit && subject && /\b(fix|bug|regress|revert|hotfix|crash|broke|repair|исправ|чин)/i.test(subject)) out.push({ commit: commit.slice(0, 12), subject: subject.slice(0, 200), files: files.slice(0, 10) });
  }
  return out.slice(0, 100);
}
export const EXCAVATE_LOG_ARGS = ["log", "--no-merges", "-n", "400", "--name-only", "--format=%x01%H%x02%s"];

/** Owner decisions that came out the same way three times or more, by kind: each a candidate for an automatic rule. */
export function approvalSuggestions(items: ReadonlyArray<{ descriptor?: { kind?: string } & Record<string, unknown>; expected?: string }>) {
  const by = new Map<string, number>();
  for (const item of items) {
    const key = `${item.descriptor?.kind ?? "?"}→${item.expected ?? "?"}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by.entries()].filter(([, n]) => n >= 3).map(([key, n]) => ({ pattern: key, times: n, suggestion: `the owner decided ${key} ${n} times: let the night policy decide it the same way` }));
}

/** Cost per verified result: tokens of a project's writers per accepted task, by kind, over the last days. */
export function costPerVerified(db: Db, days = 30, now = Date.now()) {
  const since = now - days * 86_400_000;
  const tokens = projectTokenTotalsSince(db, new Date(since).toISOString().slice(0, 10));
  const accepted = acceptedTaskCountsByProject(db as never, since);
  return tokens.map((row) => { const n = accepted.find((entry) => entry.projectId === row.projectId)?.n ?? 0; return { projectId: row.projectId, tokens: row.tokens, accepted: n, tokensPerAccepted: n ? Math.round(row.tokens / n) : null }; })
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
}

const esc = (text: unknown) => String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch]!);
/** The local HTML report: one self-contained page. */
export function htmlReport(input: { title: string; sections: Array<{ heading: string; rows: Array<Record<string, unknown>> }> }): string {
  const table = (rows: Array<Record<string, unknown>>) => {
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return `<table><thead><tr>${keys.map((key) => `<th>${esc(key)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${keys.map((key) => `<td>${esc(typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>${esc(input.title)}</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style><h1>${esc(input.title)}</h1>${input.sections.map((section) => `<h2>${esc(section.heading)}</h2>${table(section.rows)}`).join("")}`;
}
