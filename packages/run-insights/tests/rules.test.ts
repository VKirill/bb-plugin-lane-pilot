import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ruleTrialMigrations,
  ruleAudienceMigrations,
  setRuleAudience,
  upsertLessonProposal,
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
  for (const statement of [...ruleMigrations, ...ruleTrialMigrations, ...ruleAudienceMigrations]) db.exec(statement);
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
    expect(acceptedRules(db, "p")).toEqual([{ id, rule: "No network in verification.", memoryId: "mem-1", scope: [], audience: "writer", always: false }]);

    db.prepare("DELETE FROM lane_pilot_memory WHERE id='mem-1'").run();
    expect(acceptedRules(db, "p")).toEqual([]);
  });
});

describe("rule relevance", () => {
  it("asks one yes/no question per rule and keeps a rule from the threshold up or when unanswered", async () => {
    const { pickRelevantRules, ruleRelevanceQuestions, ruleRelevanceState } = await import("../src/index");
    const rules = [{ rule: "Run every verification command." }, { rule: "Check the healthcheck after a deploy." }, { rule: "Unanswered" }, { rule: "Unsure no" }];
    expect(Object.keys(ruleRelevanceQuestions(rules))).toEqual(["r1", "r2", "r3", "r4"]);
    expect(ruleRelevanceQuestions(rules).r2!.criteria.yes).toContain("healthcheck");
    const picked = pickRelevantRules(rules, { r1: "yes", r2: "no", r4: "no" }, { r1: 0.9, r2: 0.95, r4: 0.65 });
    expect(picked.map((row) => row.rule)).toEqual(["Run every verification command.", "Unanswered", "Unsure no"]);
    const state = ruleRelevanceState({ title: "Release", invariants: ["rollback-safe"], interfaces: ["scripts/deploy.sh"], verification: [{ command: "npm test" }] });
    expect(state.task).toMatchObject({ invariants: ["rollback-safe"], interfaces: ["scripts/deploy.sh"], verification_commands: ["npm test"] });
  });
});

describe("rule audience", () => {
  it("decides by System One's probability of yes when the host returns it, not by its confidence", async () => {
    const { pickRelevantRules, RULE_RELEVANCE_THRESHOLD } = await import("../src/index");
    const rules = [{ rule: "a" }, { rule: "b" }, { rule: "c" }];
    // Live answer of 2026-10-03: choice no, confidence 0.97, probabilities.yes 0.51 — the rule is relevant.
    const picked = pickRelevantRules(rules, { r1: "no", r2: "no", r3: "yes" }, { r1: 0.97, r2: 0.5, r3: 0.9 }, RULE_RELEVANCE_THRESHOLD,
      { r1: { yes: 0.51, no: 0.49 }, r2: { yes: 0.02, no: 0.98 } });
    expect(picked.map((row) => row.rule)).toEqual(["a", "c"]);
  });

  it("stores who a lesson is for and lets the owner change it on a live rule", () => {
    const db = openDb();
    const pm = upsertLessonProposal(db, "p", { rule: "Write owns_paths to cover sibling tests and snapshots.", audience: "pm" }, 1);
    const shell = upsertLessonProposal(db, "p", { rule: "Never read the exit code after a pipe; use pipefail.", audience: "writer", always: true }, 2);
    const old = upsertLessonProposal(db, "p", { rule: "Older clients send no audience at all here." }, 3);
    const byId = Object.fromEntries(listRuleProposals(db, "p").map((row) => [row.id, row]));
    expect([byId[pm.id]!.audience, byId[pm.id]!.always]).toEqual(["pm", false]);
    expect([byId[shell.id]!.audience, byId[shell.id]!.always]).toEqual(["writer", true]);
    expect(byId[old.id]!.audience).toBe("both");
    expect(setRuleAudience(db, "p", old.id, "writer", true)).toBe(true);
    expect(listRuleProposals(db, "p").find((row) => row.id === old.id)).toMatchObject({ audience: "writer", always: true });
    expect(setRuleAudience(db, "p", "missing", "pm", false)).toBe(false);
  });
});

describe("rule scope and trial", () => {
  it("gives a section's rule only to runs in that section or below it", async () => {
    const { scopeApplies } = await import("../src/index");
    expect(scopeApplies([], ["section:a"])).toBe(true);
    expect(scopeApplies(["section:a"], ["section:a", "section:b"])).toBe(true);
    expect(scopeApplies(["section:a", "section:b"], ["section:a"])).toBe(false);
    expect(scopeApplies(["section:a", "section:b"], ["section:a", "section:c"])).toBe(false);
    const db = openDb();
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id) VALUES('m1','p'),('m2','p')").run();
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,scope_json)
      VALUES ('r-tent','p','a','tent rule','model','accepted',3,3,'[]','m1',1,1,1,1,'["section:clients","section:tent"]'), ('r-all','p','b','project rule','model','accepted',3,3,'[]','m2',1,1,1,2,'[]')`).run();
    expect(acceptedRules(db, "p", ["section:clients", "section:aura"]).map((row) => row.id)).toEqual(["r-all"]);
    expect(acceptedRules(db, "p", ["section:clients", "section:tent"]).map((row) => row.id)).toEqual(["r-tent", "r-all"]);
  });

  it("confirms a rule its writers stopped breaking, rewrites one they keep breaking, then retires it; unused rules leave", async () => {
    const { decideRuleTrial, RULE_TRIAL } = await import("../src/index");
    const day = 86_400_000, now = 100 * day;
    const rule = { trialState: "trial" as const, revision: 1, revisionStartedAt: now - day, decidedAt: now - day };
    const stats = (applied: number, recurrences: number, lastAppliedAt: number | null = now) =>
      ({ applied, appliedAccepted: applied - recurrences, recurrences: Array.from({ length: recurrences }, (_, i) => ({ attemptId: `a${i}`, taskId: `t${i}`, reason: "x" })), lastAppliedAt });
    expect(decideRuleTrial(rule, stats(4, 0), now)).toEqual({ action: "keep" });
    expect(decideRuleTrial(rule, stats(RULE_TRIAL.confirmAfterApplied, 0), now)).toEqual({ action: "confirm" });
    expect(decideRuleTrial(rule, stats(6, 1), now)).toEqual({ action: "keep" });
    expect(decideRuleTrial(rule, stats(6, 2), now)).toEqual({ action: "revise" });
    expect(decideRuleTrial({ ...rule, revision: RULE_TRIAL.maxRevisions }, stats(6, 2), now)).toEqual({ action: "retire", reason: "kept_recurring" });
    expect(decideRuleTrial({ ...rule, trialState: "confirmed" }, stats(9, 0), now)).toEqual({ action: "keep" });
    expect(decideRuleTrial(rule, stats(0, 0, null), now + RULE_TRIAL.unusedAfterMs)).toEqual({ action: "retire", reason: "unused" });
  });

  it("counts attempts given a rule and the mistakes they repeated from what is recorded, once each", async () => {
    const { ruleTrialStats } = await import("../src/index");
    const { triageMigrations } = await import("../src/triage");
    const db = openDb();
    for (const statement of triageMigrations) db.exec(statement);
    db.exec(`CREATE TABLE lane_pilot_attempt_reasoning (attempt_id TEXT PRIMARY KEY, trace_json TEXT NOT NULL);
      CREATE TABLE lane_pilot_attempt2 (x INTEGER)`);
    db.exec("ALTER TABLE lane_pilot_attempt ADD COLUMN created_at INTEGER");
    db.prepare("INSERT INTO lane_pilot_run(id,project_id) VALUES('r1','p')").run();
    const attempt = (id: string, state: string, picked: string[], at: number) => {
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,updated_at,created_at) VALUES(?,?,?,?,?,?,?)").run(id, "r1", `t-${id}`, state, null, at, at);
      db.prepare("INSERT INTO lane_pilot_attempt_reasoning VALUES(?,?)").run(id, JSON.stringify({ dispatchContext: { rulesPicked: { total: 2, picked } } }));
    };
    attempt("a1", "accepted", ["rule-x"], 10); attempt("a2", "validation_failed", ["rule-x"], 20); attempt("a3", "validation_failed", [], 30); attempt("a0", "accepted", ["rule-x"], 1);
    const triage = (id: string, rule: string | null) => db.prepare(`INSERT INTO lane_pilot_failure_triage (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,same_rule_id,status,failed_at,triaged_at)
      VALUES ('p',?,'r1',?,'h','missing',?, ?, 'ok', 25, 26)`).run(id, `t-${id}`, "writer", rule);
    triage("a2", "rule-x"); triage("a3", "rule-x");
    const stats = ruleTrialStats(db, "p", "rule-x", 5);
    expect(stats).toMatchObject({ applied: 2, appliedAccepted: 1, lastAppliedAt: 20 });
    // a3 repeated the mistake but was never given the rule: a miss of the picker, not of the rule.
    expect(stats.recurrences.map((row) => row.attemptId)).toEqual(["a2"]);
  });
});
