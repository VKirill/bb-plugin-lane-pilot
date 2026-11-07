/**
 * Read-only listing of rule scopes and root CORE rows the current reader cannot place.
 * Prints a proposed mapping. Does not update the database.
 *
 *   npx tsx scripts/memory-scope-dry-run.ts --db <sqlite> --out <report.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyRuleScopeRebind, planScopeMigration, revertRuleScopeRebind } from "../src/rooms/memory/server/scope-migration";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("memory-scope-dry-run.ts")) {
  const dbPath = arg("--db");
  const out = arg("--out");
  const apply = process.argv.includes("--apply");
  const revert = arg("--revert");
  const mapPath = arg("--map");
  if (!dbPath || (!apply && !revert && !out)) {
    console.error("usage: npx tsx scripts/memory-scope-dry-run.ts --db <sqlite> [--out <report.json> | --apply --map <labels.json> [--journal <journal.json>] | --revert <journal.json>]");
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: !apply && !revert, fileMustExist: true });
  if (revert) {
    const journal = JSON.parse(readFileSync(revert, "utf8")) as { reverted: boolean; rows: Array<{ id: string; projectId: string; before: string[]; after: string[] }> };
    const { reverted } = revertRuleScopeRebind(db, journal);
    if (reverted) writeFileSync(revert, `${JSON.stringify({ ...journal, reverted: true }, null, 2)}\n`);
    db.close();
    console.log(`reverted=${reverted}`);
    process.exit(0);
  }
  const report = planScopeMigration(db, dbPath);
  if (apply) {
    if (!mapPath) { console.error("--apply needs --map <labels.json> ({label: [\"section:<uuid>\"]})"); process.exit(1); }
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string[]>;
    const { applied, journal } = applyRuleScopeRebind(db, map);
    const journalPath = arg("--journal") ?? out;
    if (journalPath && journal.length) writeFileSync(journalPath, `${JSON.stringify({ reverted: false, rows: journal }, null, 2)}\n`);
    db.close();
    for (const row of journal) console.log(`${row.id} ${JSON.stringify(row.before)} -> ${JSON.stringify(row.after)}`);
    console.log(`applied=${applied}`);
    process.exit(0);
  }
  db.close();
  mkdirSync(dirname(out!), { recursive: true });
  writeFileSync(out!, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${out} rules=${report.rules.length} rootCore=${report.rootCore.length}`);
}
