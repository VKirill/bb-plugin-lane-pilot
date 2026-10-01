import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  acceptedRules, collectLessonSources, decideRuleProposal, getRuleProposal, lessonSignature, listRuleProposals,
  normalizeLessonText, repeatedLessons, reviseRuleProposal, ruleMigrations, ruleProposalId, upsertRuleProposals,
  type LessonSource,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lane_pilot_run (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE lane_pilot_attempt (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE lane_pilot_stage_receipt (run_id TEXT NOT NULL, task_id TEXT NOT NULL, stage_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
      provider_id TEXT, model TEXT, result_json TEXT, reason TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(run_id, task_id, stage_id));
    CREATE TABLE lane_pilot_memory (id TEXT NOT NULL, project_id TEXT NOT NULL, UNIQUE(project_id,id));
  `);
  for (const statement of ruleMigrations) db.exec(statement);
  return db;
}

const rejection = (task: string, reason: string, at: number): LessonSource => ({ kind: "rejection", runId: "r1", taskId: task, stage: "verification", reason, at });

describe("lesson signatures", () => {
  it("masks paths, numbers, hashes and command lines so the same failure groups together", () => {
    const a = "verification failed (curl -fsS https://selfystudio.art/tools/a): curl: (6) Could not resolve host: selfystudio.art";
    const b = "verification failed (curl -fsS https://example.com/b): curl: (6) Could not resolve host: example.com";
    expect(normalizeLessonText(a)).toBe(normalizeLessonText(b));
    expect(normalizeLessonText("owns_paths rejected .agents/memory/episodes/20260928T151448Z.md"))
      .toBe(normalizeLessonText("owns_paths rejected .agents/memory/episodes/20260929T101010Z.md"));
    expect(normalizeLessonText("writer changed paths outside owns_paths: a/b.ts, c/d.ts, e.md")).toBe("writer changed paths outside owns_paths: <p>");
    expect(lessonSignature(rejection("t", "x", 1))).toBe("x");
    expect(normalizeLessonText("verification failed (false): exit 1")).not.toBe(normalizeLessonText("verification failed (npm test): exit 1"));
  });
});

describe("repeated lessons", () => {
  it("counts a task once however many stages recorded the failure, and needs three tasks", () => {
    const host = (task: string, at: number) => rejection(task, `curl: (6) Could not resolve host: h${at}.example.com`, at);
    const asAttempt = (task: string, at: number): LessonSource => ({ kind: "attempt_failure", runId: "r1", taskId: task, reason: `curl: (6) Could not resolve host: h${at}.example.com`, at });
    expect(repeatedLessons([host("t1", 1), asAttempt("t1", 1), host("t2", 2), asAttempt("t2", 2)])).toEqual([]);
    const [lesson] = repeatedLessons([host("t1", 1), asAttempt("t1", 1), host("t2", 2), host("t3", 3), rejection("t4", "unrelated", 4)]);
    expect(lesson).toMatchObject({ occurrences: 3, taskCount: 3, firstSeenAt: 1, lastSeenAt: 3 });
    expect(lesson!.examples).toHaveLength(3);
  });

  it("leaves out failures of the run machinery and of the PM's plan", () => {
    const many = (reason: string, stage = "verification") => ["t1", "t2", "t3"].map((task, at) => rejection(task, reason, at)).map((source) => ({ ...source, stage }));
    expect(repeatedLessons(many("internal_error: writer spawn was not created after a complete reconcile scan"))).toEqual([]);
    expect(repeatedLessons(many("attempt_worktree_provider_unavailable:This project checkout has no usable git branch."))).toEqual([]);
    expect(repeatedLessons(many("execution_packet_failed:HTTP 404: Path does not exist: /x/y.md"))).toEqual([]);
    expect(repeatedLessons(many("tests are missing", "plan-critique"))).toEqual([]);
    expect(repeatedLessons(many("owns_paths rejected src/a.ts"))).toHaveLength(1);
  });

  it("does not learn from a writer's question to the owner", () => {
    const db = openDb();
    db.prepare("INSERT INTO lane_pilot_run(id,project_id) VALUES('r1','p')").run();
    db.prepare("INSERT INTO lane_pilot_attempt VALUES('a1','r1','t1','blocked','needs_human: which pricing plan should the page show?',10)").run();
    db.prepare("INSERT INTO lane_pilot_attempt VALUES('a2','r1','t2','blocked','owns_paths rejected x.ts',11)").run();
    expect(collectLessonSources(db, { projectId: "p", since: 0 }).map((source) => source.taskId)).toEqual(["t2"]);
  });
});

describe("rule proposals", () => {
  const lesson = { signature: "verification:curl: (…) could not resolve host: <p>", occurrences: 4, taskCount: 3, examples: ["curl: (6) Could not resolve host: a.example"], firstSeenAt: 1, lastSeenAt: 9 };

  it("creates a proposal once and refreshes counts without touching wording or decisions", () => {
    const db = openDb();
    expect(upsertRuleProposals(db, "p", [lesson], 100)).toEqual({ created: 1 });
    const id = ruleProposalId(lesson.signature);
    expect(getRuleProposal(db, "p", id)).toMatchObject({ state: "proposed", author: "sweep", occurrences: 4, rule: expect.stringContaining("Repeated in 4 tasks: curl: (6) Could not resolve host") });

    expect(reviseRuleProposal(db, "p", id, "Verification commands must not use the network.", "pm")).toBe(true);
    expect(upsertRuleProposals(db, "p", [{ ...lesson, occurrences: 6, lastSeenAt: 20 }], 200)).toEqual({ created: 0 });
    expect(getRuleProposal(db, "p", id)).toMatchObject({ rule: "Verification commands must not use the network.", author: "pm", occurrences: 6, lastSeenAt: 20 });
  });

  it("decides by compare-and-swap and lists pending first", () => {
    const db = openDb();
    upsertRuleProposals(db, "p", [lesson, { ...lesson, signature: "attempt:other", occurrences: 3 }]);
    const id = ruleProposalId(lesson.signature);
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id) VALUES('mem-1','p')").run();
    expect(decideRuleProposal(db, "p", id, { from: "proposed", to: "accepted", rule: "No network in verification.", author: "owner", memoryId: "mem-1" })).toBe(true);
    expect(decideRuleProposal(db, "p", id, { from: "proposed", to: "rejected" })).toBe(false);
    expect(reviseRuleProposal(db, "p", id, "late edit", "pm")).toBe(false);

    expect(listRuleProposals(db, "p").map((row) => row.state)).toEqual(["proposed", "accepted"]);
    expect(acceptedRules(db, "p")).toEqual([{ id, rule: "No network in verification.", memoryId: "mem-1" }]);

    db.prepare("DELETE FROM lane_pilot_memory WHERE id='mem-1'").run();
    expect(acceptedRules(db, "p")).toEqual([]);
  });
});
