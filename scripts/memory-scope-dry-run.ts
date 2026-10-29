/**
 * Read-only listing of rule scopes and root CORE rows the current reader cannot place.
 * Prints a proposed mapping. Does not update the database.
 *
 *   npx tsx scripts/memory-scope-dry-run.ts --db <sqlite> --out <report.json>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { splitRuleScope } from "@lane-pilot/run-insights";

type ScopeDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

type RuleRow = { id: string; project_id: string; audience: string; scope_json: string; rule: string };
type CoreRow = { id: string; project_id: string; content: string; concepts_json: string };

export type ScopeDryRun = {
  generatedAt: string;
  db: string;
  applied: false;
  rules: Array<{ id: string; projectId: string; audience: string; scope: string[]; proposal: { sectionChain: string[]; pathSelectors: string[]; legacy: string[]; action: "split-path" | "hold"; note: string } }>;
  rootCore: Array<{ id: string; projectId: string; content: string; concepts: string[]; proposal: { action: "keep-root-pending-owner"; note: string } }>;
};

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 160);

export function planScopeMigration(db: ScopeDb, dbPath: string): ScopeDryRun {
  const rules = db.prepare("SELECT id, project_id, audience, scope_json, rule FROM lane_pilot_rule_proposal WHERE state='accepted'").all() as RuleRow[];
  const incompatible = rules.flatMap((row) => {
    let scope: string[] = [];
    try { const value = JSON.parse(row.scope_json) as unknown; scope = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { scope = []; }
    const split = splitRuleScope(scope);
    if (!split.legacy.length && !split.pathSelectors.length) return [];
    const action = split.legacy.length ? "hold" as const : "split-path" as const;
    const note = split.legacy.length
      ? "Legacy labels match no section chain. Leave the rule undisclosed until the owner names a section id. Do not map the scope to []."
      : "Path selectors apply when a task owns the file. Section chain stays as stored; do not widen a path-only rule to every section.";
    return [{ id: row.id, projectId: row.project_id, audience: row.audience, scope, proposal: { sectionChain: split.sectionChain, pathSelectors: split.pathSelectors, legacy: split.legacy, action, note } }];
  });
  const cores = db.prepare("SELECT id, project_id, content, concepts_json FROM lane_pilot_memory WHERE kind='core' AND status='active' AND scope_json='[]'").all() as CoreRow[];
  return {
    generatedAt: new Date().toISOString(),
    db: dbPath,
    applied: false,
    rules: incompatible,
    rootCore: cores.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      content: clip(row.content),
      concepts: (() => { try { const value = JSON.parse(row.concepts_json) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : []; } catch { return []; } })(),
      proposal: { action: "keep-root-pending-owner" as const, note: "Active core at the project root. The owner confirms it is a project-wide convention or assigns a section. This dry-run does not move it." },
    })),
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("memory-scope-dry-run.ts")) {
  const dbPath = arg("--db");
  const out = arg("--out");
  if (!dbPath || !out) {
    console.error("usage: npx tsx scripts/memory-scope-dry-run.ts --db <sqlite> --out <report.json>");
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const report = planScopeMigration(db, dbPath);
  db.close();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${out} rules=${report.rules.length} rootCore=${report.rootCore.length}`);
}
