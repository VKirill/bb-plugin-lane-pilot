import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase, saveProjectSetting, createRun } from "../src/rooms/plugin-db";
import { threadMemoryBlock, THREAD_MEMORY_RULE } from "../src/rooms/memory/server/thread-block";

/**
 * M2: the L1 showcase every ordinary BB thread gets through contributeInstructions — facts of the project's core shelf
 * plus the two lane-memory lines, nothing for a PM thread or a thread the plugin spawned for itself.
 */
const limits = { sourceSha256: "b".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

function core(db: ReturnType<typeof setup>, projectId: string, content: string, scope?: string[]) {
  return storeMemoryRecords(db, { projectId, personalBot: "", ...limits, entries: [{ kind: "core", content, concepts: ["convention"] }], ...(scope ? { scope } : {}) }).insertedIds[0]!;
}

describe("threadMemoryBlock", () => {
  it("gives an ordinary thread the project's core facts and the two lane-memory lines", () => {
    const db = setup();
    core(db, "P", "Writers keep one port per service.");
    core(db, "P", "Deploys go through the CDN.");
    const block = threadMemoryBlock(db, { projectId: "P", threadId: "thr_plain" });
    expect(block).toContain("Writers keep one port per service.");
    expect(block).toContain("Deploys go through the CDN.");
    expect(block).toContain(THREAD_MEMORY_RULE[0]);
    expect(block).toContain(THREAD_MEMORY_RULE[1]);
    expect(block!.length).toBeLessThanOrEqual(1200);
  });

  it("returns only the two rule lines when the project has no core facts", () => {
    const db = setup();
    expect(threadMemoryBlock(db, { projectId: "P", threadId: "thr_plain" })).toBe(THREAD_MEMORY_RULE.join("\n"));
  });

  it("gives a PM thread nothing (the learning room's resume block stays the PM path)", () => {
    const db = setup();
    core(db, "P", "Writers keep one port per service.");
    createRun(db, "run-1", "P");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run-1'").run();
    expect(threadMemoryBlock(db, { projectId: "P", threadId: "thr_pm" })).toBeNull();
  });

  it("gives a hidden analyzer nothing (it must not run tools) and a pilot working thread the rule alone", () => {
    const db = setup();
    core(db, "P", "Writers keep one port per service.");
    db.prepare("INSERT INTO lane_pilot_wf_effect(id,run_id,step_key,effect_key,kind,state,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("e1", "wf-1", "step-1", "spawn:rules-analyzer", "night.spawn", "done", JSON.stringify({ threadId: "thr_analyzer" }), 1, 1);
    expect(threadMemoryBlock(db, { projectId: "P", threadId: "thr_analyzer" })).toBeNull();
    // A writer of an attempt and an errand helper work in the pilot: the rule reaches them, the facts come in their brief.
    createRun(db, "run-2", "P");
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,?,?,?)").run("t1", "run-2", "bb", "{}", 1);
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at,thread_id) VALUES(?,?,?,?,?,?,?)").run("a1", "run-2", "t1", "running", 1, 1, "thr_writer");
    expect(threadMemoryBlock(db, { projectId: "P", threadId: "thr_writer" })).toBe(THREAD_MEMORY_RULE.join("\n"));
    db.prepare("INSERT INTO lane_pilot_wf_effect(id,run_id,step_key,effect_key,kind,state,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("e2", "wf-2", "work", "spawn:errand", "errand.spawn", "done", JSON.stringify({ threadId: "thr_helper" }), 1, 1);
    expect(threadMemoryBlock(db, { projectId: "P", threadId: "thr_helper" })).toBe(THREAD_MEMORY_RULE.join("\n"));
  });

  it("never carries a fact of another project", () => {
    const db = setup();
    core(db, "P2", "Only project two knows this secret convention.");
    const block = threadMemoryBlock(db, { projectId: "P1", threadId: "thr_plain" });
    expect(block).not.toContain("project two");
    expect(block).toBe(THREAD_MEMORY_RULE.join("\n"));
  });

  it("stays under 1200 characters and cuts each fact to 160 even with a full shelf of long facts", () => {
    const db = setup();
    for (let index = 0; index < 10; index++) core(db, "P", `Convention ${index}: ${"x".repeat(400)}`);
    const block = threadMemoryBlock(db, { projectId: "P", threadId: "thr_plain" })!;
    expect(block.length).toBeLessThanOrEqual(1200);
    const facts = block.split("\n").filter((line) => line.startsWith("- "));
    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(facts.length).toBeLessThanOrEqual(8);
    for (const line of facts) expect(line.length).toBeLessThanOrEqual(163);
  });

  it("shows project-wide shared facts of an umbrella project but not a sibling section's", () => {
    const db = setup();
    core(db, "P", "Shared fact for every section.", ["project:root"]);
    core(db, "P", "Sibling section only.", ["section:other"]);
    const block = threadMemoryBlock(db, { projectId: "P", threadId: "thr_plain" })!;
    expect(block).toContain("Shared fact for every section.");
    expect(block).not.toContain("Sibling section only.");
  });

  it("gives nothing when the project's memory is off", () => {
    const db = setup();
    core(db, "P", "Writers keep one port per service.");
    saveProjectSetting(db, "P", "memory.enabled", false);
    expect(threadMemoryBlock(db, { projectId: "P", threadId: "thr_plain" })).toBeNull();
  });
});
