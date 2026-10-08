import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import { storeMemoryRecords } from "../../packages/memory-core/src/store";
import { exportedFileName, laneMemoryFileToCandidate, parseLaneMemoryFile, renderLaneMemoryFile } from "../../packages/memory-core/src/files";
import { exportFileMemory, importFileMemory } from "../../src/rooms/memory/server/memory-sync";
import type { ServerCore } from "../../src/server/core";

const dir = "/w/.agents/memory";

function setup(files:Record<string, string>) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ files:{
    listPaths: async () => ({ paths:Object.keys(files).map((name) => ({ kind:"file", name, path:name })) }),
    read: async ({ path }:{ path:string }) => ({ content:files[path.slice(dir.length + 1)] }),
    write: async ({ path, content }:{ path:string; content:string }) => { files[path.slice(dir.length + 1)] = content; return {}; },
    remove: async ({ path }:{ path:string }) => { delete files[path.slice(dir.length + 1)]; return {}; },
  } } as never });
  const db = openDatabase(bb);
  saveProjectSetting(db, "P", "memory.enabled", "true");
  const ctx = { bb, db, configForRun: async () => ({ hostId:"h", writerWorkspacePath:"/w" }) } as unknown as ServerCore;
  return { ctx, db, files };
}

const store = (db:ReturnType<typeof openDatabase>, content:string, concepts:string[] = ["x"]) => storeMemoryRecords(db, { projectId:"P", audience:"subagent", sourceSha256:"a".repeat(64),
  coreBudget:99_999, noteBudget:99_999, indexBudget:999_999, entries:[{ kind:"core", content, concepts }] }).insertedIds[0]!;

describe("memory sync: the database is the source of truth, files mirror it", () => {
  it("export writes new records and removes lp- files whose record is gone; hand-written files stay", async () => {
    const { ctx, db, files } = setup({ "hand.md":"---\nid: hand\n---\n", "lp-0000000000000000.md":"stale revoked rule" });
    const id = store(db, "Run npm ci, never npm install.", ["rule", "owner-confirmed"]);
    const result = await exportFileMemory(ctx, { projectId:"P", runId:"r" });
    expect(result).toMatchObject({ written:1, removed:1 });
    expect(Object.keys(files).sort()).toEqual(["hand.md", exportedFileName({ id })].sort());
    expect(files[exportedFileName({ id })]).toMatch(/truth_mode: normative[\s\S]*authority: owner-instruction/);
  });

  it("import never takes Lane Pilot's own exports back, nor expired records", async () => {
    const { ctx } = setup({
      "lp-1234567890abcdef.md":"---\nid: lp-1234567890abcdef\nstatus: active\nclaim: \"revoked rule\"\n---\n",
      "old.md":"---\nid: old\nstatus: active\nclaim: \"Old fact\"\nvalid_until: 2020-01-01\n---\n",
      "fresh.md":"---\nid: fresh\nstatus: active\nclaim: \"Fresh fact\"\n---\n",
    });
    const result = await importFileMemory(ctx, { projectId:"P", runId:"r" });
    expect(result.imported).toBe(1);
    expect(result.skipped.map((row) => row.file).sort()).toEqual(["lp-1234567890abcdef.md", "old.md"]);
  });

  it("a maintainer note stays observed and agent-authored", () => {
    const text = renderLaneMemoryFile({ id:"b".repeat(64), projectId:"P", personalBot:"", kind:"note", content:"Contract lives in src/a.", concepts:["a"], sourceSha256:"c".repeat(64), createdAt:0 }, "subagent");
    expect(text).toMatch(/truth_mode: observed[\s\S]*authority: agent/);
    expect(laneMemoryFileToCandidate(parseLaneMemoryFile(text)!)).not.toBeNull();
  });
});

describe("0.1.91 cleanup migration", () => {
  it("removes failure lessons and orphaned index rows, keeps facts and rules", async () => {
    const { migrations } = await import("../../src/rooms/storage/database");
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    const facts = store(db, "Contract lives in src/site-tool-card-page.", ["contracts"]);
    const lessonContent = "A writer attempt failed: tests failed";
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES('les','P','','note','subagent',?,'[\"lesson\",\"attempt\",\"failed\"]','x',0)").run(lessonContent);
    db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES('les','P',?,'lesson')").run(lessonContent);
    db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES('ghost','P','gone','x')").run();
    for (const statement of migrations.filter((sql) => sql.startsWith("DELETE FROM lane_pilot_memory"))) db.prepare(statement).run();
    expect((db.prepare("SELECT id FROM lane_pilot_memory").all() as Array<{ id:string }>).map((row) => row.id)).toEqual([facts]);
    expect((db.prepare("SELECT id FROM lane_pilot_memory_fts").all() as Array<{ id:string }>).map((row) => row.id)).toEqual([facts]);
  });
});
