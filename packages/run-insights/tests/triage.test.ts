import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { codeVerdict, ruleMigrations, ruleTrialMigrations, saveTriage, splitRejectedPaths, triageQuestions, triageState, triageSummary, untriagedAttempts, writerGroups, type FailedAttempt } from "../src/index";
import { triageMigrations } from "../src/triage";

function openDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lane_pilot_run (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, settings_scopes_json TEXT);
    CREATE TABLE lane_pilot_task (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, contract_json TEXT NOT NULL);
    CREATE TABLE lane_pilot_attempt (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, thread_id TEXT, updated_at INTEGER NOT NULL);
  `);
  for (const statement of [...ruleMigrations, ...triageMigrations, ...ruleTrialMigrations]) db.exec(statement);
  db.prepare("INSERT INTO lane_pilot_run(id,project_id) VALUES('r1','p')").run();
  return db;
}

function seed(db: Database.Database, task: string, state: string, reason: string, at = 10) {
  db.prepare("INSERT OR IGNORE INTO lane_pilot_task VALUES(?, 'r1', ?)").run(task, JSON.stringify({ expected_outputs: [`${task}.md`], owns_paths: ["docs/**"] }));
  db.prepare("INSERT INTO lane_pilot_attempt VALUES(?, 'r1', ?, ?, ?, ?, ?)").run(`a-${task}-${at}`, task, state, reason, `thr-${task}`, at);
}

const attempt = (reason: string, contract: Record<string, unknown> = {}): FailedAttempt =>
  ({ attemptId: "a", runId: "r1", taskId: "t", state: "validation_failed", reason, contractJson: JSON.stringify(contract), threadId: null, failedAt: 1 });

describe("triage state", () => {
  it("settles in code what code can: bookkeeping paths, internal codes, prose outputs", () => {
    const bookkeeping = triageState(attempt("writer changed paths outside owns_paths or inside never_touch: .agents/PROGRESS.md, .bb/chats/x/README.md"));
    expect(bookkeeping.facts_computed_by_code).toMatchObject({ all_rejected_paths_are_lane_pilot_bookkeeping: true, reason_is_an_internal_error_code_of_the_orchestrator: false });
    expect((triageState(attempt("owns_paths rejected apps/api/a.ts")).facts_computed_by_code as Record<string, unknown>).all_rejected_paths_are_lane_pilot_bookkeeping).toBe(false);
    expect((triageState(attempt("attempt_worktree_provision_timeout:provisioning")).facts_computed_by_code as Record<string, unknown>).reason_is_an_internal_error_code_of_the_orchestrator).toBe(true);
    expect((triageState(attempt("missing expected_outputs: x", { expected_outputs: ["The page shows a keyword"] })).facts_computed_by_code as Record<string, unknown>).expected_outputs_written_as_prose_not_paths).toBe(true);
  });

  it("lets code decide when the gate rejected the task's own files or only bookkeeping files", () => {
    const owns = (path: string) => path.startsWith("apps/api/");
    const ownFiles = splitRejectedPaths("writer changed paths outside owns_paths or inside never_touch: apps/api/a.ts, apps/web/b.ts", owns);
    expect(ownFiles).toEqual({ owned: ["apps/api/a.ts"], bookkeeping: [], outside: ["apps/web/b.ts"] });
    expect(codeVerdict(ownFiles)).toEqual({ origin: "orchestrator", detail: "code:gate_rejected_owned_paths" });
    expect(codeVerdict(splitRejectedPaths("owns_paths rejected .agents/PROGRESS.md", owns))).toEqual({ origin: "orchestrator", detail: "code:bookkeeping_only" });
    const outside = splitRejectedPaths("writer changed paths outside owns_paths or inside never_touch: .agents/x.md, apps/web/b.ts", owns);
    expect(codeVerdict(outside)).toBeNull();
    expect((triageState(attempt("x"), outside).facts_computed_by_code as Record<string, unknown>).rejected_paths_outside_this_task_scope).toEqual(["apps/web/b.ts"]);
    expect(codeVerdict(splitRejectedPaths("missing expected_outputs: a.md", owns))).toBeNull();
  });

  it("asks about known rules only when there are some", () => {
    expect(Object.keys(triageQuestions([]))).toEqual(["origin", "category"]);
    const questions = triageQuestions([{ rule: "No network in verification." }, { rule: "Create every expected file." }]);
    expect(Object.keys(questions.same_rule!.criteria)).toEqual(["r1", "r2", "none"]);
  });
});

describe("triage store", () => {
  it("asks once per attempt and again only when its reason changes; skips retry-limit and owner questions", () => {
    const db = openDb();
    seed(db, "t1", "validation_failed", "missing expected_outputs: t1.md");
    seed(db, "t2", "blocked", "retry limit 2 exhausted");
    seed(db, "t3", "blocked", "needs_human: which plan?");
    seed(db, "t4", "accepted", "fine");
    const [first, ...rest] = untriagedAttempts(db, "p", 0);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ taskId: "t1", threadId: "thr-t1" });
    saveTriage(db, "p", first!, { status: "ok", origin: "writer", originConfidence: 0.9, category: "missing_output" });
    expect(untriagedAttempts(db, "p", 0)).toEqual([]);
    db.prepare("UPDATE lane_pilot_attempt SET reason='missing expected_outputs: other.md' WHERE id=?").run(first!.attemptId);
    expect(untriagedAttempts(db, "p", 0)).toHaveLength(1);
    saveTriage(db, "p", { ...first!, reason: "x" }, { status: "error", detail: "timeout" });
    expect(untriagedAttempts(db, "p", 0)).toHaveLength(1);
    expect(triageSummary(db, "p", 0)).toMatchObject({ total: 1, errors: 1, byOrigin: {} });
  });

  it("groups writer failures by category, one per task, leaving out rule matches, model rejections and cited tasks", () => {
    const db = openDb();
    const save = (task: string, at: number, extra: Record<string, unknown> = {}) => {
      seed(db, task, "validation_failed", `missing expected_outputs: ${task}.md`, at);
      const row = untriagedAttempts(db, "p", 0).find((item) => item.attemptId === `a-${task}-${at}`)!;
      saveTriage(db, "p", row, { status: "ok", origin: "writer", originConfidence: 0.9, category: "missing_output", ...extra });
    };
    save("t1", 1); save("t1", 2); save("t2", 3);
    expect(writerGroups(db, "p", 0)).toEqual([]);
    save("t3", 4);
    const [group] = writerGroups(db, "p", 0);
    expect(group).toMatchObject({ category: "missing_output", taskCount: 3 });
    expect(group!.failures.map((row) => row.attemptId)).toEqual(["a-t3-4", "a-t2-3", "a-t1-2"]);
    save("t4", 5, { origin: "orchestrator" });
    save("t5", 6, { sameRuleId: "rule_x" });
    save("t6", 7, { originConfidence: 0.3 });
    expect(writerGroups(db, "p", 0)[0]!.taskCount).toBe(3);
    db.prepare("UPDATE lane_pilot_failure_triage SET detail='model:not_writer' WHERE attempt_id='a-t3-4'").run();
    expect(writerGroups(db, "p", 0)).toEqual([]);
    expect(writerGroups(db, "p", 0, { minTasks: 1 }).map((row) => row.taskCount)).toEqual([2]);
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,first_seen_at,last_seen_at,updated_at)
      VALUES ('rule_y','p','model:x','r','model','proposed',1,1,'[]','[{"taskId":"t1"}]',1,1,1)`).run();
    expect(writerGroups(db, "p", 0, { minTasks: 1 }).map((row) => row.taskCount)).toEqual([1]);
  });
});

describe("sections", () => {
  it("gives a section its own rule when its tasks suffice and lifts the rest to the deepest common parent", () => {
    const db = openDb();
    const clients = "section:clients", tent = "section:rich-tent", aura = "section:aura", gas = "section:gas";
    const runs: Record<string, string[]> = { rt: [clients, tent], au: [clients, aura], ga: [clients, gas], root: [] };
    for (const [run, chain] of Object.entries(runs)) db.prepare("INSERT INTO lane_pilot_run(id,project_id,settings_scopes_json) VALUES(?, 'p', ?)").run(run, JSON.stringify(chain));
    let at = 1;
    const fail = (run: string, task: string) => {
      db.prepare("INSERT OR IGNORE INTO lane_pilot_task VALUES(?, ?, '{}')").run(task, run);
      db.prepare("INSERT INTO lane_pilot_attempt VALUES(?, ?, ?, 'validation_failed', ?, NULL, ?)").run(`a-${task}`, run, task, `missing expected_outputs: ${task}.md`, at++);
      const row = untriagedAttempts(db, "p", 0).find((item) => item.attemptId === `a-${task}`)!;
      saveTriage(db, "p", row, { status: "ok", origin: "writer", originConfidence: 0.9, category: "missing_output" });
    };
    for (const task of ["t1", "t2", "t3"]) fail("rt", task);
    fail("au", "a1"); fail("ga", "g1"); fail("root", "r1");
    const groups = writerGroups(db, "p", 0);
    // rich-tent has three of its own; aura, gas and the project root have one each, so they meet at the project level.
    expect(groups.map((group) => ({ scope: group.scope, tasks: group.failures.map((row) => row.taskId).sort() }))).toEqual([
      { scope: [clients, tent], tasks: ["t1", "t2", "t3"] },
      { scope: [], tasks: ["a1", "g1", "r1"] },
    ]);
    fail("au", "a2");
    expect(writerGroups(db, "p", 0).map((group) => group.scope)).toEqual([[clients, tent], [clients]]);
    expect(writerGroups(db, "p", 0, { chains: new Map([["rt", []], ["au", []], ["ga", []], ["root", []]]) }).map((group) => group.scope)).toEqual([[]]);
  });
});
