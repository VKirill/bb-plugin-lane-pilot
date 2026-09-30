import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { collectLessonSources, lessonCandidates, parseGoldenCases, recommendWriter, routingHint, runGoldenEval, writerAcceptanceStats } from "../src/index";

/** The subset of Lane Pilot's tables the package reads, with the same columns. */
function openDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lane_pilot_run (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE lane_pilot_task (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, contract_json TEXT NOT NULL);
    CREATE TABLE lane_pilot_attempt (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE lane_pilot_stage_receipt (run_id TEXT NOT NULL, task_id TEXT NOT NULL, stage_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
      provider_id TEXT, model TEXT, result_json TEXT, reason TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(run_id, task_id, stage_id));
  `);
  return db;
}

function seedTask(db: Database.Database, input: { run: string; task: string; risk: string; provider: string; model: string; acceptance?: { state: string; attempt: number }; at?: number }) {
  const at = input.at ?? 1000;
  db.prepare("INSERT OR IGNORE INTO lane_pilot_run(id,project_id) VALUES(?, 'p')").run(input.run);
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,contract_json) VALUES(?,?,?)").run(input.task, input.run, JSON.stringify({ risk: input.risk }));
  db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,state,attempt,provider_id,model,updated_at) VALUES(?,?,'writer-agent','passed',0,?,?,?)").run(input.run, input.task, input.provider, input.model, at);
  if (input.acceptance) {
    db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,state,attempt,updated_at) VALUES(?,?,'acceptance-receipt',?,?,?)").run(input.run, input.task, input.acceptance.state, input.acceptance.attempt, at);
  }
}

describe("writer acceptance statistics", () => {
  it("counts first-try acceptance per provider, model and risk and recommends the best pair", () => {
    const db = openDb();
    for (let i = 0; i < 6; i++) seedTask(db, { run: "r1", task: `luna-${i}`, risk: "medium", provider: "codex", model: "gpt-6-luna", acceptance: { state: "passed", attempt: i < 5 ? 0 : 1 } });
    for (let i = 0; i < 6; i++) seedTask(db, { run: "r2", task: `astra-${i}`, risk: "medium", provider: "agy", model: "gemini-6-astra", acceptance: { state: i < 3 ? "passed" : "failed", attempt: 0 } });
    seedTask(db, { run: "r3", task: "pending", risk: "medium", provider: "agy", model: "gemini-6-astra" });
    seedTask(db, { run: "r3", task: "high-1", risk: "high", provider: "codex", model: "gpt-6-luna", acceptance: { state: "passed", attempt: 0 } });

    const stats = writerAcceptanceStats(db, { projectId: "p" });
    expect(stats.find((row) => row.model === "gpt-6-luna" && row.risk === "medium")).toMatchObject({ tasks: 6, acceptedFirstTry: 5, accepted: 6, failed: 0 });
    expect(stats.find((row) => row.model === "gemini-6-astra")).toMatchObject({ tasks: 7, acceptedFirstTry: 3, accepted: 3, failed: 3 });

    expect(recommendWriter(stats, { risk: "medium" })).toMatchObject({ providerId: "codex", model: "gpt-6-luna", tasks: 6 });
    expect(recommendWriter(stats, { risk: "high" })).toBeNull();
    expect(routingHint(stats, { providerId: "agy", model: "gemini-6-astra" }, "medium")).toContain("codex/gpt-6-luna reached 83%");
    expect(routingHint(stats, { providerId: "codex", model: "gpt-6-luna" }, "medium")).toContain("the best pair on record");
    expect(routingHint(stats, null, "high")).toBe("");
  });
});

describe("lessons", () => {
  it("turns night findings, rejections and attempt failures into deduplicated notes", () => {
    const db = openDb();
    seedTask(db, { run: "r1", task: "t1", risk: "low", provider: "codex", model: "m" });
    db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,state,attempt,result_json,updated_at) VALUES('r1','t1','night-review','passed',0,?,2000)")
      .run(JSON.stringify({ decision: "findings", summary: "s", findings: [
        { severity: "blocking", path: "apps/api/src/orders/checkout.ts", finding: "Discount applied twice on retry", suggestedFix: "Make applyDiscount idempotent" },
        { severity: "blocking", path: "apps/api/src/orders/checkout.ts", finding: "Discount applied twice on retry", suggestedFix: "Make applyDiscount idempotent" },
      ] }));
    db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,state,attempt,reason,updated_at) VALUES('r1','t1','acceptance-receipt','failed',0,'expected_outputs missing: docs/orders.md',1500)").run();
    db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,state,attempt,reason,updated_at) VALUES('r1','t1','verification','failed',0,'retry limit 2 exhausted',1600)").run();
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,updated_at) VALUES('a1','r1','t1','blocked','owns_paths rejected apps/web/src/App.vue',1700)").run();

    const sources = collectLessonSources(db, { projectId: "p", since: 0 });
    expect(sources.map((source) => source.kind)).toEqual(["night_finding", "night_finding", "attempt_failure", "rejection"]);
    const candidates = lessonCandidates(sources);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ kind: "note", concepts: expect.arrayContaining(["lesson", "night-review", "blocking", "apps", "checkout"]) });
    expect(candidates[0]?.content).toContain("Fix: Make applyDiscount idempotent");
  });
});

describe("golden retrieval checks", () => {
  it("parses both JSON and the lane-memory line form and scores hits", () => {
    expect(parseGoldenCases("[]")).toEqual([]);
    expect(parseGoldenCases("- checkout discount -> m1, m2\n- something else -> m3")).toEqual([
      { query: "checkout discount", mustHit: ["m1", "m2"] },
      { query: "something else", mustHit: ["m3"] },
    ]);
    const cases = parseGoldenCases([{ query: "checkout", mustHit: ["m1"] }, { query: "seo", mustHit: ["m9"] }]);
    const report = runGoldenEval(cases, (query) => (query === "checkout" ? ["m1", "m4"] : []));
    expect(report).toEqual({ cases: 2, hits: 1, hitRate: 0.5, misses: [{ query: "seo", missing: ["m9"] }] });
    expect(() => parseGoldenCases([{ query: "" }])).toThrow();
  });
});
