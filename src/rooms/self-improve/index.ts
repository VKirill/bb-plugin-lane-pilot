import type Database from "better-sqlite3";

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
  const rows = db.prepare("SELECT project_id AS projectId, query FROM lane_pilot_memory_miss WHERE at >= ?").all(now - days * 86_400_000) as Array<{ projectId: string; query: string }>;
  const by = new Map<string, { projectId: string; query: string; count: number }>();
  for (const row of rows) {
    const key = `${row.projectId}\n${row.query.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const entry = by.get(key) ?? { projectId: row.projectId, query: row.query.slice(0, 200), count: 0 };
    entry.count += 1;
    by.set(key, entry);
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, 50);
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
  const tokens = db.prepare("SELECT project_id AS projectId, SUM(total_tokens) AS tokens FROM lane_pilot_token_daily WHERE day >= ? GROUP BY project_id").all(new Date(since).toISOString().slice(0, 10)) as Array<{ projectId: string; tokens: number }>;
  const accepted = db.prepare(`SELECT r.project_id AS projectId, COUNT(DISTINCT a.task_id) AS n FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state='accepted' AND a.updated_at >= ? GROUP BY r.project_id`).all(since) as Array<{ projectId: string; n: number }>;
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
