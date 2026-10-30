/**
 * M7: rebinds root-scoped memory of umbrella projects to the section of their work.
 *
 *   npx tsx scripts/memory-section-rebind.ts --db <sqlite>                    dry-run table
 *   npx tsx scripts/memory-section-rebind.ts --db <sqlite> --apply --journal <file>
 *   npx tsx scripts/memory-section-rebind.ts --db <sqlite> --revert <journal>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { isSharedScope, pathsNamed, resolveProjectKind, sharedScope } from "@lane-pilot/memory-core";

type Db = { prepare(sql: string): any; transaction(fn: () => void): (() => void) };
type Row = { id: string; project_id: string; content: string; concepts_json: string; scope_json: string | null; origin_task_id: string | null };
export type RebindProposal = { id: string; projectId: string; before: string[]; after: string[]; action: "section" | "shared" | "review"; note: string };

const SHARED_WORDS = /hub|infra|deploy|backup|владелец|owner|все разделы/i;

/** What a root-scoped record should become: a section (from the task it came from), shared, or kept for review. */
export function rebindProposal(db: Db, row: Row, sectionsByProject: Map<string, Map<string, string[]>>): RebindProposal {
  const before = row.scope_json ? (JSON.parse(row.scope_json) as string[]) : [];
  if (isSharedScope(before)) return { id: row.id, projectId: row.project_id, before, after: before, action: "shared", note: "already marked project-wide" };
  // A record written by a task inherits that task's section chain.
  if (row.origin_task_id) {
    const run = db.prepare(`SELECT r.settings_scopes_json FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id WHERE t.id=?`).get(row.origin_task_id) as { settings_scopes_json: string | null } | undefined;
    const chain = run?.settings_scopes_json ? (JSON.parse(run.settings_scopes_json) as string[]) : [];
    if (chain.length) return { id: row.id, projectId: row.project_id, before, after: chain, action: "section", note: `origin task ${row.origin_task_id}` };
  }
  // A record that names a file goes to the section whose folder holds it (the dry-run map, `folder → chain`).
  const map = sectionsByProject.get(row.project_id);
  if (map) for (const path of pathsNamed(row.content)) {
    const hit = [...map.entries()].find(([folder]) => path === folder || path.startsWith(`${folder}/`) || path.includes(`/${folder}`) || folder.includes(path));
    if (hit) return { id: row.id, projectId: row.project_id, before, after: hit[1], action: "section", note: `names ${path}` };
  }
  // Deliberately project-wide (hub/infra/owner wording) → explicit shared marker.
  if (SHARED_WORDS.test(`${row.content} ${row.concepts_json}`)) return { id: row.id, projectId: row.project_id, before, after: sharedScope("rebind"), action: "shared", note: "worded project-wide" };
  return { id: row.id, projectId: row.project_id, before, after: before, action: "review", note: "no section evidence; stays [] for a person to place" };
}

/** The projects of the base as resolved now: uses-sections → umbrella, unless a project setting overrides. */
export function projectKinds(db: Db, kindOf: (projectId: string) => "auto" | "standalone" | "umbrella"): Map<string, string> {
  const uses = new Map<string, boolean>();
  for (const row of db.prepare("SELECT project_id FROM lane_pilot_run WHERE settings_scopes_json LIKE '%section:%' GROUP BY project_id").all() as Array<{ project_id: string }>) uses.set(row.project_id, true);
  for (const row of db.prepare("SELECT project_id FROM lane_pilot_memory WHERE scope_json LIKE '%section:%' GROUP BY project_id").all() as Array<{ project_id: string }>) uses.set(row.project_id, true);
  const out = new Map<string, string>();
  for (const row of db.prepare("SELECT DISTINCT project_id FROM lane_pilot_memory").all() as Array<{ project_id: string }>)
    out.set(row.project_id, resolveProjectKind(kindOf(row.project_id), uses.get(row.project_id) ?? false));
  return out;
}

export function runRebind(db: Db, opts: { apply?: boolean; journalPath?: string; map?: Map<string, Map<string, string[]>>; kindOf?: (projectId: string) => "auto" | "standalone" | "umbrella" }) {
  const kinds = projectKinds(db, opts.kindOf ?? (() => "auto"));
  const rows = db.prepare(`SELECT id, project_id, content, concepts_json, scope_json, origin_task_id FROM lane_pilot_memory
    WHERE status='active' AND (scope_json IS NULL OR scope_json='[]')`).all() as Row[];
  const update = db.prepare("UPDATE lane_pilot_memory SET scope_json=? WHERE id=?");
  const proposals: RebindProposal[] = [];
  const journal: Array<{ id: string; before: string[]; after: string[] }> = [];
  const work = () => {
    for (const row of rows) {
      if (kinds.get(row.project_id) !== "umbrella") continue;
      const proposal = rebindProposal(db, row, opts.map ?? new Map());
      if (proposal.action === "section" || proposal.action === "shared") {
        if (opts.apply) update.run(JSON.stringify(proposal.after), row.id);
        journal.push({ id: proposal.id, before: proposal.before, after: proposal.after });
      }
      proposals.push(proposal);
    }
  };
  if (opts.apply) db.transaction(work)(); else work();
  if (opts.journalPath) { mkdirSync(dirname(opts.journalPath), { recursive: true }); writeFileSync(opts.journalPath, JSON.stringify(journal, null, 2)); }
  return { kinds, proposals, applied: journal.length };
}

export function revertRebind(db: Db, journalPath: string): number {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Array<{ id: string; before: string[] }>;
  const update = db.prepare("UPDATE lane_pilot_memory SET scope_json=? WHERE id=?");
  db.transaction(() => { for (const entry of journal) update.run(JSON.stringify(entry.before), entry.id); })();
  return journal.length;
}

if (import.meta.main || process.argv[1]?.endsWith("memory-section-rebind.ts")) {
  const flags: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) { const hit = /^--([a-z-]+)(?:=(.*))?$/.exec(process.argv[i]!); if (hit) flags[hit[1]!] = hit[2] ?? (hit[1] === "apply" ? "1" : process.argv[++i] ?? ""); }
  const dbPath = flags.db;
  if (!dbPath) { console.error("usage: --db <sqlite> [--apply --journal <file>] [--revert <journal>] [--map <json>]"); process.exit(1); }
  const db = new Database(dbPath, { readonly: !flags.apply && !flags.revert }) as unknown as Db;
  if (flags.revert) { console.log(`reverted=${revertRebind(db, flags.revert)}`); process.exit(0); }
  const map = flags.map ? new Map(Object.entries(JSON.parse(readFileSync(flags.map, "utf8")).folders as Record<string, Record<string, string[]>>).map(([project, folders]) => [project, new Map(Object.entries(folders))])) : undefined;
  const { kinds, proposals, applied } = runRebind(db, { apply: !!flags.apply, journalPath: flags.journal, map });
  console.log("# project kinds");
  for (const [project, kind] of kinds) console.log(`${project} ${kind}`);
  console.log("# project -> with section / shared / review");
  const byProject = new Map<string, { section: number; shared: number; review: number }>();
  for (const proposal of proposals) { const slot = byProject.get(proposal.projectId) ?? { section: 0, shared: 0, review: 0 }; slot[proposal.action]++; byProject.set(proposal.projectId, slot); }
  for (const [project, counts] of byProject) console.log(`${project} ${counts.section} ${counts.shared} ${counts.review}`);
  for (const proposal of proposals) console.log(`${proposal.id} ${proposal.before.join(",") || "[]"} -> ${proposal.after.join(",")} (${proposal.note})`);
  console.log(`applied=${flags.apply ? applied : 0}`);
}
