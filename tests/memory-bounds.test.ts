import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { applyScopeMigration, planScopeMigration } from "../scripts/memory-scope-dry-run";
import { describe, expect, it } from "vitest";
import { searchMemoryAllSections, searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { assertRuleScope, scopeApplies, upsertLessonProposal } from "@lane-pilot/run-insights";
import { demoteUnusedPromotions, enrichMemoryContext } from "../src/rooms/memory-tiers/server";
import { createMemoryConflicts } from "../src/rooms/memory/server/memory-conflicts";
import { sessionMemoryRpc } from "../src/rooms/memory/server/session-memory";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import type { ServerCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const PORT_A = "Service deployment uses port 3000 for the API gateway.";
const PORT_B = "Service deployment uses port 4000 for the API gateway.";

function dbOf() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("F03: write identity stays inside one section", () => {
  it("a note in section B does not supersede the same subject in section A, and the same text is stored for both", () => {
    const db = dbOf();
    const put = (content: string, scope: string[]) => storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content, concepts: ["deployment", "port"] }], scope });
    const a = put(PORT_A, ["section:A"]);
    const b = put(PORT_B, ["section:B"]);
    expect(b.supersededIds).toEqual([]);
    expect(searchMemoryRecords(db, "P", "deployment", 10, "auto", "subagent", "", { chain: ["section:A"] }).map((row) => row.content)).toEqual([PORT_A]);
    expect(searchMemoryRecords(db, "P", "deployment", 10, "auto", "subagent", "", { chain: ["section:B"] }).map((row) => row.content)).toEqual([PORT_B]);
    createMemoryConflicts({ db, deferrals: () => ({ close() { /* held pairs only */ } }) as never }).detect("P");
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(a.insertedIds[0])).toEqual({ status: "active" });
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(b.insertedIds[0])).toEqual({ status: "active" });
    const same = put(PORT_A, ["section:B"]);
    expect(same.insertedIds).toHaveLength(1);
    const copies = db.prepare("SELECT scope_json, status FROM lane_pilot_memory WHERE content=?").all(PORT_A) as Array<{ scope_json: string; status: string }>;
    expect(copies.map((row) => `${row.scope_json} ${row.status}`).sort()).toEqual(['["section:A"] active', '["section:B"] active']);
    expect(searchMemoryRecords(db, "P", "deployment", 10, "auto", "subagent", "", { chain: ["section:A"] }).map((row) => row.content)).toEqual([PORT_A]);
  });

  it("does not widen an existing fact when the same words are written at the project root", () => {
    const db = dbOf();
    const section = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: PORT_A, concepts: ["deployment", "port"] }], scope: ["section:A"] });
    const root = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: PORT_A, concepts: ["deployment", "port"] }] });
    expect(root.insertedIds).toHaveLength(1);
    expect(root.supersededIds).toEqual([]);
    expect(db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE id=?").get(section.insertedIds[0])).toEqual({ scope_json: '["section:A"]' });
  });
});

describe("F02: cold tier uses the read context and does not promote", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-10-23T10:00:00Z");

  function coldWorld() {
    const db = dbOf();
    const put = (content: string, extra: Record<string, unknown> = {}) => storeMemoryRecords(db, {
      projectId: "P", ...limits, entries: [{ kind: "note", content, concepts: ["deployment", "port"] }], now: now - 100 * day, ...extra,
    });
    put("Private billing deployment uses port 9000.", { audience: "owner", trust: "observed", scope: ["section:billing"] });
    put("Sibling deployment uses port 5000.", { scope: ["section:sibling"] });
    put("Root deployment uses port 3000.");
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: "A fresh note about caching layers.", concepts: ["cache"] }], now });
    return db;
  }

  it("hides another audience, bot, section, and fresh observed note, and leaves matches expired", () => {
    const db = coldWorld();
    const result = enrichMemoryContext(db, { projectId: "P", query: "deployment port", activeCount: 0, now, chain: ["section:billing"], audience: "subagent", personalBot: "", role: "pm", budget: 400, activeTokens: 0 });
    expect(result.text).not.toMatch(/9000|5000/);
    expect(result.text).toContain("port 3000");
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE content LIKE '%9000%'").get()).toEqual({ status: "expired" });
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE content LIKE '%3000%'").get()).toEqual({ status: "expired" });
    const tight = enrichMemoryContext(db, { projectId: "P", query: "deployment port", activeCount: 0, now, budget: 10, activeTokens: 0 });
    expect(tight.text).toBe("");
    expect(tight.addedTokens).toBeLessThanOrEqual(10);
    expect(db.prepare("SELECT expired_reason FROM lane_pilot_memory WHERE content LIKE '%3000%'").get()).toEqual({ expired_reason: "idle" });
  });

  it("drops a cold note that does not fit beside the active pack, and skips a held note", () => {
    const db = coldWorld();
    const root = db.prepare("SELECT id FROM lane_pilot_memory WHERE content LIKE '%3000%'").get() as { id: string };
    db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,personal_bot,note_a,note_b,kind,subject,state,detected_at) VALUES('held-1','P','',?,'other','value','port','held',?)").run(root.id, now);
    const held = enrichMemoryContext(db, { projectId: "P", query: "deployment port", activeCount: 0, now, budget: 400, activeTokens: 0 });
    expect(held.text).not.toContain("port 3000");
    const packed = enrichMemoryContext(db, { projectId: "P", query: "deployment port", activeCount: 1, now, chain: ["section:sibling"], budget: 30, activeTokens: 30 });
    expect(packed.promoted).toEqual([]);
    expect(packed.addedTokens).toBe(0);
  });

  it("a child reader gets the root episode and not a sibling run", () => {
    const db = dbOf();
    createRun(db, "run-root", "P", "cli", "/repo");
    createRun(db, "run-bill", "P", "cli", "/repo");
    db.prepare("UPDATE lane_pilot_run SET settings_scopes_json=? WHERE id='run-bill'").run(JSON.stringify(["section:billing"]));
    for (const [id, runId, title] of [["task-root", "run-root", "Root deployment port"], ["task-bill", "run-bill", "Billing deployment port"]] as const) {
      createTask(db, { id, runId, kind: "bb", contract: { title, objective: "deployment port" } });
      createAttempt(db, { id: `a-${id}`, runId, taskId: id });
      transitionAttempt(db, `a-${id}`, "spawn_requested");
      transitionAttempt(db, `a-${id}`, "running", { threadId: "thr" });
      transitionAttempt(db, `a-${id}`, "validation_failed", { reason: "failed" });
    }
    const child = enrichMemoryContext(db, { projectId: "P", query: "deployment port", activeCount: 0, now, chain: ["section:billing"] });
    expect(child.text).toContain("task-root");
    expect(child.text).toContain("task-bill");
    const root = enrichMemoryContext(db, { projectId: "P", query: "deployment port", activeCount: 0, now, chain: [] });
    expect(root.text).toContain("task-root");
    expect(root.text).not.toContain("task-bill");
  });
});

describe("F04: section chain and path selectors", () => {
  const chain = ["section:467f7397-8fbb-4bc6-9470-3442dc430d41", "section:481b8b80-9d9d-48c5-894f-ec3a79a7f2b3"];

  it("a legacy label matches no run, and a path selector matches only a task that owns the file", () => {
    expect(scopeApplies(["bb-plugin-lane-pilot", "verification"], chain)).toBe(false);
    expect(scopeApplies(["bb-plugin-lane-pilot", "verification"], chain, ["src/rooms/verification/check.ts"])).toBe(true);
    expect(scopeApplies(["bb-plugin-lane-pilot", "verification"], chain, ["src/rooms/memory/store.ts"])).toBe(false);
    expect(scopeApplies(["db/store.ts"], chain)).toBe(false);
    expect(scopeApplies(["db/store.ts"], chain, ["packages/db/store.ts"])).toBe(true);
    expect(scopeApplies(["section:parent"], ["section:parent", "section:child"])).toBe(true);
    expect(scopeApplies([], ["section:child"])).toBe(true);
    expect(scopeApplies(["section:sibling"], ["section:parent", "section:child"])).toBe(false);
    expect(() => assertRuleScope(["bb-plugin-lane-pilot", "verification"])).toThrow(/neither a section id nor a path/);
    const db = dbOf();
    const stored = upsertLessonProposal(db, "P", { rule: "Read db/store.ts before changing the memory write path in this section.", scope: ["section:A", "db/store.ts"] });
    const row = db.prepare("SELECT scope_json FROM lane_pilot_rule_proposal WHERE id=?").get(stored.id) as { scope_json: string };
    expect(JSON.parse(row.scope_json)).toEqual(["section:A", "path:db/store.ts"]);
    expect(scopeApplies(JSON.parse(row.scope_json) as string[], ["section:A", "section:B"], ["src/db/store.ts"])).toBe(true);
    expect(scopeApplies(JSON.parse(row.scope_json) as string[], ["section:A", "section:B"])).toBe(false);
    db.prepare("UPDATE lane_pilot_rule_proposal SET state='accepted', scope_json=? WHERE id=?").run(JSON.stringify(["bb-plugin-lane-pilot", "verification"]), stored.id);
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "core", content: "Project-wide deployment convention: one port per service.", concepts: ["deployment"] }] });
    const plan = planScopeMigration(db, "fixture");
    expect(plan.applied).toBe(false);
    expect(plan.rules.map((rule) => rule.proposal.action)).toEqual(["split-path"]);
    expect(plan.rootCore.map((row) => row.proposal.action)).toEqual(["keep-root"]);
  });

  it("keeps a root convention and marks a file-named root core for a section", () => {
    const db = dbOf();
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "core", content: "Theme build writes themes/pokecut.css and checks it.", concepts: ["theme"] }] });
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "core", content: "The shared convention lives in themes/pokecut.css for every section.", concepts: ["convention"] }] });
    const plan = planScopeMigration(db, "fixture");
    expect(plan.rootCore.find((row) => row.content.includes("Theme build"))?.proposal.action).toBe("assign-section");
    expect(plan.rootCore.find((row) => row.concepts.includes("convention"))?.proposal.action).toBe("keep-root");
  });

  it("assigns a mapped file core and leaves an unmapped one at the root", () => {
    const db = dbOf();
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "core", content: "Theme build writes themes/pokecut.css and checks it.", concepts: ["theme"] }] });
    expect(applyScopeMigration(db, {}).applied).toBe(0);
    expect(applyScopeMigration(db, { "themes/pokecut.css": ["section:pokecut"] }).applied).toBe(1);
    expect(planScopeMigration(db, "fixture").rootCore.some((row) => row.content.includes("Theme build"))).toBe(false);
    const scoped = db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE content LIKE '%pokecut.css%'").get() as { scope_json: string };
    expect(JSON.parse(scoped.scope_json)).toEqual(["section:pokecut"]);
  });
});

describe("F05: a missing chain is the project root", () => {
  it("working readers omit sibling notes, and the admin search still lists every section", async () => {
    const db = dbOf();
    const put = (content: string, scope?: string[]) => storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content, concepts: ["deployment", "port"] }], ...(scope ? { scope } : {}) });
    put("Root deployment uses port 3000.");
    put("Private sibling subsystem deployment uses port 5000.", ["section:B"]);
    put("Parent deployment uses port 1000.", ["section:parent"]);
    expect(searchMemoryRecords(db, "P", "deployment", 10, "auto").map((row) => row.content)).toEqual(["Root deployment uses port 3000."]);
    expect(searchMemoryRecords(db, "P", "deployment", 10, "auto", "subagent", "", { chain: ["section:parent", "section:child"] }).map((row) => row.content).sort()).toEqual(["Parent deployment uses port 1000.", "Root deployment uses port 3000."]);
    expect(searchMemoryAllSections(db, "P", "deployment", 10, "auto").map((row) => row.content)).toHaveLength(3);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const rpc = sessionMemoryRpc({ bb, db } as unknown as ServerCore, {} as unknown as Services);
    expect((await rpc.session_memory_search({ projectId: "P", query: "deployment" })).records.map((row) => row.content)).toEqual(["Root deployment uses port 3000."]);
    expect((await rpc.session_memory_search({ projectId: "P", query: "deployment", chain: ["section:B"] })).records.map((row) => row.content).sort()).toEqual(["Private sibling subsystem deployment uses port 5000.", "Root deployment uses port 3000."]);
  });

  it("session core hides a fresh observed fact and another bot's core", async () => {
    const db = dbOf();
    storeMemoryRecords(db, { projectId: "P", ...limits, personalBot: "codex", entries: [{ kind: "core", content: "Codex core fact about deployment ports.", concepts: ["deployment"] }] });
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const rpc = sessionMemoryRpc({ bb, db } as unknown as ServerCore, {} as unknown as Services);
    await rpc.session_memory_write({ projectId: "P", kind: "core", content: "Session core fact about deployment ports.", concepts: ["deployment"] });
    expect((await rpc.session_memory_core({ projectId: "P" })).records).toEqual([]);
    db.prepare("UPDATE lane_pilot_memory SET trust='confirmed' WHERE personal_bot=''").run();
    expect((await rpc.session_memory_core({ projectId: "P" })).records.map((row) => row.content)).toEqual(["Session core fact about deployment ports."]);
  });
});

describe("cold tier demotion", () => {
  it("a promoted note nobody was given goes back to the cold tier; a used one stays", () => {
    const db = dbOf();
    const now = Date.now(), old = now - 91 * 86_400_000;
    const [a, b] = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [
      { kind: "note", content: "Unused promoted fact", concepts: ["demote"] },
      { kind: "note", content: "Used promoted fact", concepts: ["demote"] },
    ] }).insertedIds;
    db.prepare("UPDATE lane_pilot_memory SET status='expired', expired_reason='idle'").run();
    // Both were re-activated through promotion; only `a` stayed untouched since.
    for (const id of [a!, b!]) {
      db.prepare("UPDATE lane_pilot_memory SET status='active', last_used_at=? WHERE id=?").run(old, id);
      db.prepare("INSERT INTO lane_pilot_memory_promotion(project_id,memory_id,query,at) VALUES(?,?,?,?)").run("P", id, "q", old);
    }
    db.prepare("UPDATE lane_pilot_memory SET last_used_at=? WHERE id=?").run(now - 86_400_000, b); // used after promotion
    expect(demoteUnusedPromotions(db, now)).toBe(1);
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(a)).toEqual({ status: "expired" });
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(b)).toEqual({ status: "active" });
  });
});

describe("audience boundary (regression)", () => {
  it("searchMemoryRecords as subagent never returns an owner-audience record", () => {
    const db = dbOf();
    storeMemoryRecords(db, { projectId: "P", ...limits, audience: "owner" as const, entries: [
      { kind: "note", content: "Owner fact about deployment port.", concepts: ["deploy"] },
    ] });
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [
      { kind: "note", content: "Subagent fact about deployment port.", concepts: ["deploy"] },
    ] });
    for (const engine of ["auto", "fts5", "bm25"] as const) {
      const found = searchMemoryRecords(db, "P", "deployment port", 10, engine, "subagent", "", {}).map((row) => row.content).join("\n");
      expect(found).toContain("Subagent fact");
      expect(found).not.toContain("Owner fact");
    }
  });
});

describe("maintainer recurrence gate (arXiv #5)", () => {
  it("is due once every-N accepted receipts piled up since the last real maintenance", async () => {
    const { memoryRecurrenceDue } = await import("../src/rooms/memory/server/memory");
    const { createRun, createTask, openDatabase } = await import("../src/rooms/storage/database");
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const run = (id: string) => { createRun(db, id, "P", "bb", "/w"); createTask(db, { id: `t-${id}`, runId: id, kind: "bb", contract: {} as never }); };
    const stage = (id: string, stageId: string, state: string, at: number) =>
      db.prepare("INSERT OR REPLACE INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,contract_version,state,input_sha256,attempt,updated_at) VALUES(?,?,?,1,?,?,0,?)")
        .run(id, `t-${id}`, stageId, state, `${stageId}-${id}`, at);
    const accepted = (id: string, at: number) => stage(id, "acceptance-receipt", "passed", at);
    const maintained = (id: string, at: number) => stage(id, "memory-maintenance", "passed", at);
    run("r1"); run("r2"); run("r3"); run("r4");
    accepted("r1", 100); accepted("r2", 200);
    expect(memoryRecurrenceDue(db, "P", 3)).toEqual({ due: false, acceptedSince: 2 });
    accepted("r3", 300);
    expect(memoryRecurrenceDue(db, "P", 3).due).toBe(true);
    maintained("r3", 400);
    expect(memoryRecurrenceDue(db, "P", 3)).toEqual({ due: false, acceptedSince: 0 });
  });
});
