/**
 * arXiv #25 (Bemula): the unlearning audit. Seed a fact, delete it the way `memory_record_delete` does, then sweep
 * every surface a reader could still see it on: the bm25/trigram indexes, active and cold searches, the conflict
 * register's held pairs. Residual recall must be zero — a deleted note that still surfaces is a leak.
 *
 * Run: node --import tsx scripts/memory-unlearning-audit.ts
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { searchMemoryAllSections, storeMemoryRecords } from "../packages/memory-core/src";
import { coldMatches } from "../src/rooms/memory-tiers/server/tiers";
import { deleteMemoryRecord } from "../src/rooms/self-repair/server/insights";
import { openDatabase } from "../src/rooms/storage/database";

/** Where the deleted record's id or content can still be found. */
export function unlearningResiduals(db: ReturnType<typeof openDatabase>, projectId: string, id: string, content: string): string[] {
  const found: string[] = [];
  const has = (sql: string, ...args: unknown[]) => Boolean(db.prepare(sql).get(...args));
  if (has("SELECT 1 FROM lane_pilot_memory WHERE project_id=? AND id=?", projectId, id)) found.push("table");
  if (has("SELECT 1 FROM lane_pilot_memory_fts WHERE project_id=? AND id=?", projectId, id)) found.push("fts");
  if (has("SELECT 1 FROM sqlite_master WHERE name='lane_pilot_memory_trgm'") && has("SELECT 1 FROM lane_pilot_memory_trgm WHERE project_id=? AND id=?", projectId, id)) found.push("trigram");
  if (searchMemoryAllSections(db, projectId, content.slice(0, 40), 10, "auto", "subagent", "", { includeObserved: true }).some((row) => row.id === id)) found.push("search");
  if (coldMatches(db, projectId, content.slice(0, 40), 10, { includeObserved: true }).some((row) => row.id === id)) found.push("cold");
  if (has("SELECT 1 FROM lane_pilot_memory_conflict WHERE project_id=? AND state='held' AND (note_a=? OR note_b=?)", projectId, id, id)) found.push("conflict");
  return found;
}

export function audit(db: ReturnType<typeof openDatabase>, projectId = "P"): { residuals: string[] } {
  const content = "Unlearning audit canary: the ephemeral token is zxq-9917.";
  storeMemoryRecords(db, { projectId, audience: "subagent", sourceSha256: "a".repeat(64), coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999,
    entries: [{ kind: "note", content, concepts: ["audit", "canary"] }] });
  const id = (db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND content=?").get(projectId, content) as { id: string }).id;
  deleteMemoryRecord(db, projectId, id);
  return { residuals: unlearningResiduals(db, projectId, id, content) };
}

if (process.argv[1]?.endsWith("memory-unlearning-audit.ts")) {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  const { residuals } = audit(db);
  console.log(residuals.length ? `RESIDUAL LEAK: ${residuals.join(", ")}` : "clean: no residual mentions after delete");
  process.exit(residuals.length ? 1 : 0);
}
