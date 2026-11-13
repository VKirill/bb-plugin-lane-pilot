import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { EMBED_DIM, addToIndexes, searchMemoryRecords, storeMemoryRecords, storeVectors } from "@lane-pilot/memory-core";
import type { MemoryCandidate, MemoryDatabase } from "@lane-pilot/memory-core";
import { migrations, openDatabase } from "../src/rooms/plugin-db";
import { registerCli } from "../src/rooms/tools/server/cli";
import { createCore } from "../src/rooms/core/server/core";
import { applyMoveSection, planMoveSection, rewriteSectionScope, runMemoryMoveSectionCli } from "../src/rooms/memory/server/memory-move-section";
import type { Services } from "../server";

const BUDGETS = { coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const S = "section:fld_roblox", C = "section:fld_lava", OTHER = "section:fld_other", ROOT_PARENT = "section:fld_my";

function harness(threads: Record<string, { projectId: string }> = {}) {
  const host = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host.bb);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads[threadId] ? { id: threadId, projectId: threads[threadId]!.projectId } : null);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => null);
  registerCli(createCore(host.bb, db), { memoryConflicts: { detect: () => {}, sweepMoot: () => {} } } as unknown as Services, migrations);
  const run = (argv: string[], threadId?: string) => host.harness.behavior.runCli(argv, threadId ? { threadId } : {});
  return { db, run };
}

const put = (db: MemoryDatabase, project: string, scope: string[], content: string, more: Partial<MemoryCandidate> = {}, kind: "note" | "core" = "note") =>
  storeMemoryRecords(db, { projectId: project, sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", scope, ...(more.concepts?.includes("rule") ? { origin: "rule" as const } : {}), entries: [{ kind, content, concepts: ["area"], ...more }], ...BUDGETS }).insertedIds[0]!;

const count = (db: MemoryDatabase, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const inProject = (db: MemoryDatabase, project: string) => count(db, "SELECT count(*) AS n FROM lane_pilot_memory WHERE project_id=?", project);
const backups: string[] = [];
const writer = (json: string) => { const dir = mkdtempSync(join(tmpdir(), "lp-move-")); backups.push(dir); const path = join(dir, "backup.json"); writeFileSync(path, json); return path; };
afterEach(() => { while (backups.length) rmSync(backups.pop()!, { recursive: true, force: true }); delete process.env.LANE_PILOT_BACKUP_DIR; });

/** Project P: notes of the moved section (and a child), of a sibling section, of an ancestor, of the root, and a shared note. */
function seed(db: MemoryDatabase) {
  const ids = {
    own: put(db, "P", [S], "Roblox section: the obby spawns checkpoints every twenty studs (src/obby/spawn.lua)."),
    child: put(db, "P", [S, C], "Lava child: lava rises one stud per second after the countdown (src/lava/rise.lua)."),
    inChain: put(db, "P", [ROOT_PARENT, S], "Chain under an ancestor: leaderboard resets weekly on Monday (src/board/reset.lua)."),
    archived: put(db, "P", [S], "Old Roblox note: the first obby used red parts only (src/obby/old.lua)."),
    sibling: put(db, "P", [OTHER], "Other section: the Telegram bot answers within two seconds (bot/answer.ts)."),
    ancestor: put(db, "P", [ROOT_PARENT], "Ancestor section: all games share the publishing checklist (docs/publish.md)."),
    root: put(db, "P", [], "Root note: the Roblox games are built with Rojo and Studio MCP (docs/build.md)."),
    shared: put(db, "P", ["project:root"], "Shared note: every section releases on the second Thursday (docs/release.md)."),
  };
  db.prepare("UPDATE lane_pilot_memory SET status='expired', expired_reason='budget' WHERE id=?").run(ids.archived);
  Object.entries(ids).forEach(([key, id], axis) => {
    const row = db.prepare("SELECT content FROM lane_pilot_memory WHERE id=?").get(id) as { content: string };
    const vector = new Float32Array(EMBED_DIM); vector[axis] = 1;
    if (key !== "archived") storeVectors(db, [{ id, projectId: "P", content: row.content, vector }]);
  });
  // a rule of the section, its event, a learning item that points at a note, a setting of the section and one of the sibling
  const rule = put(db, "P", [S], "Rule: never edit the Studio place file by hand (docs/rules.md).", { concepts: ["rule"] }, "core");
  db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,scope_json)
    VALUES ('rule_a','P','sig','never edit the place file by hand','owner','accepted',1,1,'[]',?,1,1,1,?)`).run(rule, JSON.stringify([S]));
  db.prepare("INSERT INTO lane_pilot_rule_event(project_id,rule_id,action,at) VALUES ('P','rule_a','accepted',1)").run();
  db.prepare(`INSERT INTO lane_pilot_learning_obs (id,thread_id,project_id,at,judged_at,source,chars,state) VALUES ('obs_a','thr_a','P',1,1,'owner',10,'extracted'),('obs_z','thr_z','P',1,1,'owner',10,'extracted')`).run();
  db.prepare(`INSERT INTO lane_pilot_learning_item (id,obs_id,project_id,thread_id,kind,text,reach,state,target,evidence,created_at) VALUES
    ('item_a','obs_a','P','thr_a','fact','spawn rule','project','noted',?,'e',1), ('item_z','obs_z','P','thr_z','fact','telegram','project','noted',?,'e',1)`).run(`memory:${ids.own}`, `memory:${ids.sibling}`);
  db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,updated_at) VALUES ('P',?,'memory.scope','\"project\"',1),('P',?,'memory.scope','\"section\"',1),('P','','memory.enabled','true',1)").run(S, OTHER);
  db.prepare("INSERT INTO lane_pilot_memory_miss(project_id,query,at,kind,note_id) VALUES ('P','how do checkpoints spawn',1,'reminded',?),('P','unrelated question',1,'miss',NULL)").run(ids.own);
  addToIndexes(db, "P", rule, "x", ["rule"]);
  return { ...ids, rule };
}

describe("memory move-section", () => {
  it("rewrites the scope: keeps the chain from the section on, renames it, or lifts it to the root", () => {
    const moved = new Set([S, C]);
    expect(rewriteSectionScope([S], moved, S, {})).toEqual([S]);
    expect(rewriteSectionScope([ROOT_PARENT, S, C], moved, S, {})).toEqual([S, C]);
    expect(rewriteSectionScope([S, C], moved, S, { toSection: "fld_new" })).toEqual(["section:fld_new", C]);
    expect(rewriteSectionScope([S], moved, S, { root: true })).toEqual(["project:root"]);
    expect(rewriteSectionScope([S, C], moved, S, { root: true })).toEqual([C]);
    expect(rewriteSectionScope([OTHER], moved, S, {})).toBeNull();
    expect(rewriteSectionScope([], moved, S, {})).toBeNull();
    expect(rewriteSectionScope(["project:root"], moved, S, {})).toBeNull();
  });

  it("a dry run reads and changes nothing, and prints the counts per table", () => {
    const { db } = harness();
    seed(db);
    const before = JSON.stringify(db.prepare("SELECT * FROM lane_pilot_memory ORDER BY id").all());
    const out = runMemoryMoveSectionCli(db, ["--from-project", "P", "--section", S, "--to-project", "Q", "--section-name", "Roblox"], writer);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/would move section:fld_roblox: P -> Q/);
    expect(out.stdout).toMatch(/lane_pilot_memory: 5\b/); // own, child, inChain, archived and the rule note
    expect(out.stdout).toMatch(/lane_pilot_rule_proposal: 1/);
    expect(out.stdout).toMatch(/lane_pilot_learning_item: 1/);
    expect(out.stdout).toMatch(/lane_pilot_learning_obs: 1/);
    expect(out.stdout).toMatch(/lane_pilot_project_settings: 1/);
    expect(out.stdout).toMatch(/lane_pilot_memory_miss: 1/);
    expect(out.stdout).toMatch(/hint: 1 active notes of the root of P mention the section's name/);
    expect(out.stdout).toMatch(/dry run \(nothing changed/);
    expect(JSON.stringify(db.prepare("SELECT * FROM lane_pilot_memory ORDER BY id").all())).toBe(before);
    expect(inProject(db, "Q")).toBe(0);
    expect(backups).toEqual([]);
  });

  it("--apply moves the section's rows in one step, with vectors, indexes, a rule and its learning rows, and leaves everything else", () => {
    const { db } = harness();
    const ids = seed(db);
    const plan = planMoveSection(db, { fromProject: "P", toProject: "Q", sections: [S] });
    const done = applyMoveSection(db, plan, writer);
    expect(done.backup).not.toBeNull();
    const backup = JSON.parse(readFileSync(done.backup!, "utf8")) as { kind: string; from: string; to: string; rows: Array<{ table: string; before: Record<string, unknown> }> };
    expect(backup).toMatchObject({ kind: "lane-pilot-move-section-backup", from: "P", to: "Q" });
    expect(backup.rows.filter((row) => row.table === "lane_pilot_memory")).toHaveLength(plan.moves.lane_pilot_memory!);
    expect(backup.rows.every((row) => row.before !== undefined)).toBe(true);
    const row = (id: string) => db.prepare("SELECT project_id, scope_json, status FROM lane_pilot_memory WHERE id=?").get(id) as { project_id: string; scope_json: string; status: string };
    expect(row(ids.own)).toMatchObject({ project_id: "Q", scope_json: JSON.stringify([S]) });
    expect(row(ids.child)).toMatchObject({ project_id: "Q", scope_json: JSON.stringify([S, C]) });
    expect(row(ids.inChain)).toMatchObject({ project_id: "Q", scope_json: JSON.stringify([S]) }); // the ancestor above the section is cut
    expect(row(ids.archived)).toMatchObject({ project_id: "Q", status: "expired" }); // every status moves
    // nothing leaks from other sections: sibling, ancestor, root and the shared note stay
    for (const id of [ids.sibling, ids.ancestor, ids.root, ids.shared]) expect(row(id).project_id).toBe("P");
    expect(row(ids.sibling).scope_json).toBe(JSON.stringify([OTHER]));
    // vectors and word indexes follow their note
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_memory_vec WHERE project_id='Q'")).toBe(3);
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_memory_vec WHERE project_id='P'")).toBe(4);
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_memory_fts WHERE project_id='Q'")).toBeGreaterThan(0);
    expect(searchMemoryRecords(db, "Q", "obby checkpoints spawn", 5, "auto", "subagent", "", { chain: [S] }).map((r) => r.id)).toContain(ids.own);
    expect(searchMemoryRecords(db, "P", "obby checkpoints spawn", 5, "auto", "subagent", "", { chain: [S] })).toEqual([]);
    // rule, event, learning rows, setting, miss
    expect(db.prepare("SELECT project_id, scope_json FROM lane_pilot_rule_proposal WHERE id='rule_a'").get()).toEqual({ project_id: "Q", scope_json: JSON.stringify([S]) });
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_rule_event WHERE project_id='Q'")).toBe(1);
    expect(db.prepare("SELECT project_id FROM lane_pilot_learning_item WHERE id='item_a'").get()).toEqual({ project_id: "Q" });
    expect(db.prepare("SELECT project_id FROM lane_pilot_learning_item WHERE id='item_z'").get()).toEqual({ project_id: "P" });
    expect(db.prepare("SELECT project_id FROM lane_pilot_learning_obs WHERE id='obs_a'").get()).toEqual({ project_id: "Q" });
    expect(db.prepare("SELECT project_id FROM lane_pilot_learning_obs WHERE id='obs_z'").get()).toEqual({ project_id: "P" });
    expect(db.prepare("SELECT project_id, binding_id FROM lane_pilot_project_settings WHERE binding_id=?").get(S)).toEqual({ project_id: "Q", binding_id: S });
    expect(db.prepare("SELECT project_id FROM lane_pilot_project_settings WHERE binding_id=?").get(OTHER)).toEqual({ project_id: "P" });
    expect(db.prepare("SELECT project_id FROM lane_pilot_project_settings WHERE binding_id=''").get()).toEqual({ project_id: "P" });
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_memory_miss WHERE project_id='Q'")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_memory_miss WHERE project_id='P'")).toBe(1);
  });

  it("is idempotent: a second run finds nothing, writes no backup and changes nothing", () => {
    const { db } = harness();
    seed(db);
    const args = ["--from-project", "P", "--section", S, "--to-project", "Q", "--apply"];
    const first = runMemoryMoveSectionCli(db, args, writer);
    expect(first.stdout).toMatch(/^moved /);
    const snapshot = JSON.stringify([db.prepare("SELECT * FROM lane_pilot_memory ORDER BY id").all(), db.prepare("SELECT * FROM lane_pilot_project_settings ORDER BY project_id, binding_id, key").all()]);
    const dirs = backups.length;
    const second = runMemoryMoveSectionCli(db, args, writer);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/nothing to move/);
    expect(second.stdout).toMatch(/nothing changed/);
    expect(backups.length).toBe(dirs);
    expect(JSON.stringify([db.prepare("SELECT * FROM lane_pilot_memory ORDER BY id").all(), db.prepare("SELECT * FROM lane_pilot_project_settings ORDER BY project_id, binding_id, key").all()])).toBe(snapshot);
  });

  it("merges instead of copying: a moved note that duplicates one the target has moves expired as a duplicate, an extension supersedes", () => {
    const { db } = harness();
    const text = "The obby spawns a checkpoint every twenty studs and saves the stage in the player profile (src/obby/spawn.lua).";
    const dup = put(db, "P", [S], text);
    const kept = put(db, "Q", [S], text);
    const older = put(db, "Q", [S], "Lava rises one stud per second after the countdown ends in the arena (src/lava/rise.lua).");
    const longer = put(db, "P", [S], "Lava rises one stud per second after the countdown ends in the arena (src/lava/rise.lua), and the arena resets when the last player leaves.");
    const unique = put(db, "P", [S], "The shop sells speed coils for forty coins each (src/shop/items.lua).");
    const out = runMemoryMoveSectionCli(db, ["--from-project", "P", "--section", S, "--to-project", "Q"], writer);
    expect(out.stdout).toMatch(/1 duplicate a note of Q and move expired as duplicate/);
    expect(out.stdout).toMatch(/1 extend a note of Q and supersede it/);
    runMemoryMoveSectionCli(db, ["--from-project", "P", "--section", S, "--to-project", "Q", "--apply"], writer);
    const row = (id: string) => db.prepare("SELECT project_id, status, expired_reason, superseded_by FROM lane_pilot_memory WHERE id=?").get(id);
    expect(row(dup)).toMatchObject({ project_id: "Q", status: "expired", expired_reason: "duplicate", superseded_by: kept });
    expect(row(kept)).toMatchObject({ project_id: "Q", status: "active" });
    expect(row(older)).toMatchObject({ status: "superseded", superseded_by: longer });
    expect(row(longer)).toMatchObject({ project_id: "Q", status: "active" });
    expect(row(unique)).toMatchObject({ project_id: "Q", status: "active" });
    // the kept note remembers where the copy came from, and Q now holds one active note per fact
    expect(count(db, "SELECT count(*) AS n FROM lane_pilot_memory WHERE project_id='Q' AND status='active' AND content LIKE 'The obby spawns%'")).toBe(1);
    expect(JSON.parse((db.prepare("SELECT verification_json FROM lane_pilot_memory WHERE id=?").get(kept) as { verification_json: string }).verification_json)).toEqual(expect.arrayContaining([expect.objectContaining({ by: "move-section", duplicate: dup })]));
  });

  it("--to-section renames the section; --root lifts it to the target's root and leaves the section's settings behind", () => {
    const { db } = harness();
    const ids = seed(db);
    runMemoryMoveSectionCli(db, ["--from-project", "P", "--section", `${S},${C}`, "--to-project", "Q", "--to-section", "fld_new", "--apply"], writer);
    expect(db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE id=?").get(ids.own)).toEqual({ scope_json: JSON.stringify(["section:fld_new"]) });
    expect(db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE id=?").get(ids.child)).toEqual({ scope_json: JSON.stringify(["section:fld_new", C]) });
    expect(db.prepare("SELECT binding_id FROM lane_pilot_project_settings WHERE project_id='Q'").get()).toEqual({ binding_id: "section:fld_new" });

    const other = harness();
    const rootIds = seed(other.db);
    const out = runMemoryMoveSectionCli(other.db, ["--from-project", "P", "--section", S, "--to-project", "Q", "--root", "--apply"], writer);
    expect(out.stdout).toMatch(/stays: 1 section settings \(would become project-wide/);
    expect(other.db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE id=?").get(rootIds.own)).toEqual({ scope_json: JSON.stringify(["project:root"]) });
    expect(other.db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE id=?").get(rootIds.child)).toEqual({ scope_json: JSON.stringify([C]) });
    expect(count(other.db, "SELECT count(*) AS n FROM lane_pilot_project_settings WHERE project_id='Q'")).toBe(0);
  });

  it("a rule the target already has stays with its note", () => {
    const { db } = harness();
    const ids = seed(db);
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at) VALUES ('rule_a','Q','sig','x','owner','accepted',1,1,'[]',1,1,1)`).run();
    const out = runMemoryMoveSectionCli(db, ["--from-project", "P", "--section", S, "--to-project", "Q", "--apply"], writer);
    expect(out.stdout).toMatch(/stays: 1 rules whose id the target already has/);
    expect(db.prepare("SELECT project_id FROM lane_pilot_memory WHERE id=?").get(ids.rule)).toEqual({ project_id: "P" });
    expect(db.prepare("SELECT project_id FROM lane_pilot_rule_proposal WHERE id='rule_a' AND project_id='P'").get()).toEqual({ project_id: "P" });
  });

  it("the CLI: --apply is refused from a thread, a dry run only for the thread's own project, the owner may apply", async () => {
    process.env.LANE_PILOT_BACKUP_DIR = mkdtempSync(join(tmpdir(), "lp-backup-"));
    backups.push(process.env.LANE_PILOT_BACKUP_DIR);
    const h = harness({ thr_p: { projectId: "P" }, thr_q: { projectId: "Q" } });
    const ids = seed(h.db);
    const move = ["memory", "move-section", "--from-project", "P", "--section", S, "--to-project", "Q"];
    const refused = await h.run([...move, "--apply"], "thr_p");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/owner's alone/);
    expect(inProject(h.db, "Q")).toBe(0);
    expect((await h.run(move, "thr_q")).stderr).toMatch(/only a move out of that thread's own project/);
    const dry = await h.run(move, "thr_p");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toMatch(/would move/);
    expect(inProject(h.db, "Q")).toBe(0);
    const applied = await h.run([...move, "--apply"]);
    expect(applied.exitCode).toBe(0);
    const path = /backup of the \d+ changed rows: (.+)\n/.exec(applied.stdout ?? "")?.[1];
    expect(path && existsSync(path)).toBe(true);
    expect(h.db.prepare("SELECT project_id FROM lane_pilot_memory WHERE id=?").get(ids.own)).toEqual({ project_id: "Q" });
    expect((await h.run(["memory", "move-section", "--from-project", "P", "--to-project", "P", "--section", S])).stderr).toMatch(/same project/);
    expect((await h.run(["memory", "move-section", "--from-project", "P", "--section", S])).stderr).toMatch(/needs --from-project/);
  });
});
