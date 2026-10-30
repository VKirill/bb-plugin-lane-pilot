import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ruleAudienceMigrations, ruleFormMigrations, ruleMechanismMigrations, ruleMigrations, ruleTrialMigrations, upsertLessonProposal, decideRuleProposal } from "@lane-pilot/run-insights";
import { promotionDigest, promotionMorningLine, promotionWeeklyLines, proposePromotions, runRulesCli } from "../src/rooms/rule-forms";
import { acceptPromotion, dismissPromotion } from "../src/rooms/rule-forms";
import { crossProjectRuleCandidates } from "../src/rooms/rule-forms/promotion-service";

import { migrations } from "../src/rooms/storage/database";

function openDb() {
  const db = new Database(":memory:");
  for (const statement of [...migrations, ...ruleMigrations, ...ruleTrialMigrations, ...ruleAudienceMigrations, ...ruleFormMigrations, ...ruleMechanismMigrations]) db.exec(statement);
  return db;
}
const LINT = "In a task contract, list every file in expected_outputs that the change must create; verification must name a file that is missing on the base commit.";
const accept = (db: Database.Database, projectId: string, rule: string, occurrences: number) => {
  const made = upsertLessonProposal(db, projectId, { rule, form: "check" as never }, 1);
  decideRuleProposal(db, projectId, made.id, { from: "proposed", to: "accepted", memoryId: `m_${made.id}` }, 2);
  db.prepare("UPDATE lane_pilot_rule_proposal SET occurrences=?, decided_by=? WHERE project_id=? AND id=?").run(occurrences, "auto", projectId, made.id);
  return made.id;
};

describe("promotion digest (weekly top-10 + text/mechanism counter)", () => {
  it("counts rules held as text vs held by a mechanism, and lists open candidates", () => {
    const db = openDb();
    accept(db, "p", LINT, 4);
    const held = accept(db, "p", "In a contract, name the migration first, then the receipt script, always.", 5);
    db.prepare("UPDATE lane_pilot_rule_proposal SET mechanized_by='lint_x' WHERE project_id='p' AND id=?").run(held);
    proposePromotions(db, "p", { repoPath: "/tmp/repo", now: 5 });
    const digest = promotionDigest(db, "p");
    expect(digest.mechanismRules).toBe(1);
    expect(digest.textRules).toBe(1);
    expect(digest.openPromotions).toBe(1);
    expect(digest.top[0]!.ruleId).toBeTruthy();
    expect(promotionWeeklyLines(db, "p")!.join("\n")).toContain("текстом 1, механизмом 1");
    expect(promotionMorningLine(db)).toContain("кандидатов на механизацию 1");
  });

  it("accept marks the candidate dispatched and returns its contract; dismiss hides it; re-accept refuses", async () => {
    const db = openDb();
    const id = accept(db, "p", LINT, 4);
    proposePromotions(db, "p", { repoPath: "/tmp/repo" });
    const out = await runRulesCli({ db, repoPath: "/tmp/repo", retire: () => {} }, ["promote", "accept", "p", id]);
    expect(out.exitCode).toBe(0);
    const accepted = JSON.parse(out.stdout!) as { state: string; task: { title: string } };
    expect(accepted.state).toBe("dispatched");
    expect(accepted.task.title).toBeTruthy();
    expect(acceptPromotion(db, "p", id)).toBeNull();
    const digest = promotionDigest(db, "p");
    expect(digest.openPromotions).toBe(0);
    // A dismissed candidate leaves the weekly list too.
    const dismissed = dismissPromotion(db, "p", id);
    expect(dismissed).toMatchObject({ state: "dismissed" });
    expect(promotionDigest(db, "p").openPromotions).toBe(0);
    const missing = dismissPromotion(db, "p", "no-such-rule");
    expect(missing).toBeNull();
  });
});

import { claimActivation, createRun, getRun, setRunThread } from "../src/rooms/storage";
import { deliverPromotionDigests, dispatchPromotion, settlePromotionTask } from "../src/rooms/rule-forms";

const pmSetup = (db: Database.Database, projectId: string) => {
  createRun(db, `run_${projectId}`, projectId);
  setRunThread(db, `run_${projectId}`, "thr_pm");
  claimActivation(db, { projectId, pmThreadId: "thr_pm", runId: `run_${projectId}` });
};

describe("the weekly digest reaches the PM", () => {
  it("sends the top-10 block to the PM chat of each project with open candidates; quiet when none", async () => {
    const db = openDb();
    accept(db, "p", LINT, 4);
    proposePromotions(db, "p", { repoPath: "/tmp/repo" });
    pmSetup(db, "p");
    const sent: Array<{ threadId: string; text: string }> = [];
    let updatedAt = Date.now();
    const bb = { sdk: { threads: { get: async () => ({ updatedAt }), send: async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return {}; } } }, log: { warn: () => {} } };
    // A PM chat idle for days is not woken for the digest.
    updatedAt = Date.now() - 3 * 24 * 3_600_000;
    expect(await deliverPromotionDigests(bb as never, db as never)).toEqual({ sent: 0, skipped: 1 });
    expect(sent).toEqual([]);
    updatedAt = Date.now();
    const result = await deliverPromotionDigests(bb as never, db as never);
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sent[0]!.threadId).toBe("thr_pm");
    expect(sent[0]!.text).toContain("кандидатов на механизацию 1");
    // A project with nothing open sends nothing.
    expect(promotionWeeklyLines(db, "empty-project")).toBeNull();
  });
});

describe("accept creates a real task through the dispatch path", () => {
  it("dispatchWriter gets the promotion contract; the row leaves proposed", async () => {
    const db = openDb();
    const id = accept(db, "p", LINT, 4);
    proposePromotions(db, "p", { repoPath: "/tmp/repo" });
    pmSetup(db, "p");
    const calls: Array<{ threadId: string; projectId: string; task: { id: string } }> = [];
    const services = { dispatchWriter: async (args: { threadId: string; projectId: string; task: { id: string } }) => { calls.push(args); return { state: "queued", taskId: args.task.id }; } };
    const result = await dispatchPromotion({ db: db as never, bb: {} as never }, services as never, { projectId: "p", ruleId: id });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.threadId).toBe("thr_pm");
    expect(calls[0]!.task.id).toBe(result.row!.task.id);
    expect(promotionDigest(db, "p").openPromotions).toBe(0);
  });

  it("a refused dispatch rolls the candidate back to proposed with the reason", async () => {
    const db = openDb();
    const id = accept(db, "p", LINT, 4);
    proposePromotions(db, "p", { repoPath: "/tmp/repo" });
    pmSetup(db, "p");
    const services = { dispatchWriter: async () => ({ state: "rejected", reason: "lint:owns_paths" }) };
    const result = await dispatchPromotion({ db: db as never, bb: {} as never }, services as never, { projectId: "p", ruleId: id });
    expect(result.ok).toBe(false);
    const row = db.prepare("SELECT state, task_json FROM lane_pilot_rule_promotion WHERE rule_id=?").get(id) as { state: string; task_json: string };
    expect(row.state).toBe("proposed");
    expect(JSON.parse(row.task_json).fail_reason).toContain("dispatch_rejected");
  });
});

describe("the task's end settles the promotion", () => {
  it("accepted task -> promotion done + rule mechanized -> the counter flips", () => {
    const db = openDb();
    const id = accept(db, "p", LINT, 4);
    const created = proposePromotions(db, "p", { repoPath: "/tmp/repo" }).created[0]!;
    const taskId = created.task.id;
    acceptPromotion(db, "p", id);
    const settled = settlePromotionTask(db as never, { taskId, outcome: "accepted" });
    expect(settled!.state).toBe("done");
    const rule = db.prepare("SELECT mechanized_by FROM lane_pilot_rule_proposal WHERE id=?").get(id) as { mechanized_by: string | null };
    expect(rule.mechanized_by).toBe("promotion:contract_lint");
    const digest = promotionDigest(db, "p");
    expect(digest.mechanismRules).toBe(1);
    expect(digest.textRules).toBe(0);
  });

  it("failed task -> promotion back to proposed with the reason", () => {
    const db = openDb();
    const id = accept(db, "p", LINT, 4);
    const created = proposePromotions(db, "p", { repoPath: "/tmp/repo" }).created[0]!;
    acceptPromotion(db, "p", id);
    const settled = settlePromotionTask(db as never, { taskId: created.task.id, outcome: "failed", reason: "writer_blocked" });
    expect(settled!.state).toBe("proposed");
    expect(settlePromotionTask(db as never, { taskId: "no-such", outcome: "accepted" })).toBeNull();
  });
});

describe("cross-project rule transfer (arXiv #19)", () => {
  it("a rule confirmed in two projects is proposed to the others, once", () => {
    const db = openDb();
    for (const projectId of ["p1", "p2", "p3"]) db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,updated_at) VALUES (?,?,?,?,1)").run(projectId, "", "k", "v");
    const rule = "Run migrations only through scripts/migrate.sh, never by hand.";
    for (const projectId of ["p1", "p2"]) {
      const made = upsertLessonProposal(db, projectId, { rule }, 1);
      decideRuleProposal(db, projectId, made.id, { from: "proposed", to: "accepted", memoryId: `m_${made.id}` }, 2);
      db.prepare("UPDATE lane_pilot_rule_proposal SET trial_state='confirmed' WHERE project_id=? AND id=?").run(projectId, made.id);
    }
    expect(crossProjectRuleCandidates(db, 10)).toBe(1);
    const proposed = db.prepare("SELECT * FROM lane_pilot_rule_proposal WHERE project_id='p3'").all() as Array<{ author: string; state: string }>;
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.author).toBe("sweep");
    expect(proposed[0]!.state).toBe("proposed");
    expect(crossProjectRuleCandidates(db, 20)).toBe(0);
  });
});
