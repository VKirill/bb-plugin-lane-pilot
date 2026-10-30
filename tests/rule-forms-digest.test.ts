import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ruleAudienceMigrations, ruleFormMigrations, ruleMechanismMigrations, ruleMigrations, ruleTrialMigrations, upsertLessonProposal, decideRuleProposal } from "@lane-pilot/run-insights";
import { acceptPromotion, dismissPromotion, promotionDigest, promotionMorningLine, promotionWeeklyLines, proposePromotions, runRulesCli } from "../src/rooms/rule-forms";

function openDb() {
  const db = new Database(":memory:");
  for (const statement of [...ruleMigrations, ...ruleTrialMigrations, ...ruleAudienceMigrations, ...ruleFormMigrations, ...ruleMechanismMigrations]) db.exec(statement);
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
