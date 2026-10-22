import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyRuleForm, classifyUnformed, getRuleProposal, listRuleForms, markMechanized, ruleAudienceMigrations, ruleFormMigrations, ruleMechanismMigrations, ruleMigrations,
  ruleTrialMigrations, setRuleForm, upsertLessonProposal,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  for (const statement of [...ruleMigrations, ...ruleTrialMigrations, ...ruleAudienceMigrations, ...ruleFormMigrations, ...ruleMechanismMigrations]) db.exec(statement);
  return db;
}

/** The 118 accepted and proposed rules of the hub on 2026-10-22, each with the form a reader of the rule chose (tests/fixtures/hub-rules-2026-10-22.json). */
const hub = JSON.parse(readFileSync(new URL("../../../tests/fixtures/hub-rules-2026-10-22.json", import.meta.url), "utf8")) as Array<{ id: string; state: string; occurrences: number; rule: string; gold: string }>;

describe("the rule form classifier", () => {
  it("places the rules of the hub the way a reader would, and leaves few undecided", () => {
    const verdicts = hub.map((row) => ({ row, verdict: classifyRuleForm(row.rule) }));
    const right = verdicts.filter(({ row, verdict }) => verdict.form === row.gold).length;
    const undecided = verdicts.filter(({ verdict }) => !verdict.decided).length;
    // Measured 100/118 (0.85) when it was written; the floor leaves room for a rule or two without hiding a regression.
    expect(right / hub.length).toBeGreaterThanOrEqual(0.8);
    expect(undecided).toBeLessThanOrEqual(12);
    // A rule it could not place is `always` and says so: the text stays, which is what it was before.
    for (const { verdict } of verdicts.filter((entry) => !entry.verdict.decided)) {
      expect(verdict.form).toBe("always");
      expect(verdict.reason).toMatch(/^undecided/);
    }
  });

  it.each([
    ["Never read `$?` after a pipe (`cmd | tail` always exits 0): redirect output to a file and check the real exit code.", "check", "contract_lint"],
    ["In a verification command, name a test folder with a trailing slash (`npx vitest run tests/server/`), never a bare prefix.", "check", "contract_lint"],
    ["Every lane_pilot_dispatch_writer task must carry display_title and kind; contract lint rejects tasks without them.", "check", "contract_lint"],
    ["In Content Factory db/store.ts only append new entries at the end of MIGRATIONS; never insert, reorder or edit an existing migration.", "check", "static_test"],
    ["Never wake another BB thread (bb thread tell, relay ask, notices) with an informational note that needs no action.", "hook", "tool_guard"],
    ["When a SelfyStudio release includes a Prisma migration, apply it with db-migrate.sh deploy, then collect the receipt in the deploy worktree.", "skill", null],
    ["The owner does not take part in editorial decisions of Content Factory: design scenarios so the AI chief editor decides.", "memory", null],
    ["Never end a turn by asking the owner whether to fix a technical defect you found; diagnose it and dispatch the fix in the same turn.", "always", null],
  ])("routes «%s» to %s", (rule, form, mechanism) => {
    const verdict = classifyRuleForm(rule);
    expect(verdict.form).toBe(form);
    expect(verdict.mechanism).toBe(mechanism);
    expect(verdict.decided).toBe(true);
    expect(verdict.reason).toContain(form);
  });

  it("calls a sentence with no signal undecided instead of guessing", () => {
    const verdict = classifyRuleForm("Be careful with the thing near the other thing.");
    expect(verdict).toMatchObject({ form: "always", decided: false, confidence: "low", mechanism: null });
  });

  it("reads a Russian rule that names a contract field, and sends the path-comparing ones to an ownership check", () => {
    expect(classifyRuleForm("Перед ответом сверяй все изменённые пути с `owns_paths` и `never_touch`; если путь не разрешён, не меняй его.")).toMatchObject({ form: "check", mechanism: "ownership_check" });
    expect(classifyRuleForm("Put the tests of an owned file into owns_paths of the same task, or into never_touch.")).toMatchObject({ form: "check", mechanism: "contract_lint" });
  });
});

describe("rule forms in the database", () => {
  const seed = () => {
    const db = openDb();
    const a = upsertLessonProposal(db, "p", { rule: "Never read `$?` after a pipe (`cmd | tail` always exits 0): check the real exit code." }, 1);
    const b = upsertLessonProposal(db, "p", { rule: "Be careful with the thing near the other thing, always, in every case where it comes up." }, 2);
    const c = upsertLessonProposal(db, "p", { rule: "Add a check that fails when a changed composable has no spec in the diff.", form: "skill" }, 3);
    return { db, a: a.id, b: b.id, c: c.id };
  };

  it("gives every rule without a form one, keeps a form that was already set and records the reason", () => {
    const { db, a, b, c } = seed();
    const results = classifyUnformed(db, "p", { states: ["proposed"] }, 10);
    expect(results.map((entry) => entry.row.id).sort()).toEqual([a, b].sort());
    expect(getRuleProposal(db, "p", a)).toMatchObject({ form: "check", formBy: "heuristic", formReason: expect.stringContaining("check/contract_lint") });
    expect(getRuleProposal(db, "p", b)).toMatchObject({ form: "always", formBy: "heuristic", formReason: expect.stringMatching(/^undecided/) });
    expect(getRuleProposal(db, "p", c)).toMatchObject({ form: "skill", formBy: null });
  });

  it("writes nothing on a dry run", () => {
    const { db, a } = seed();
    const results = classifyUnformed(db, "p", { states: ["proposed"], dry: true });
    expect(results.every((entry) => !entry.written)).toBe(true);
    expect(getRuleProposal(db, "p", a)!.form).toBeNull();
  });

  it("lets Jev or a re-run move a heuristic form, but never overwrites the owner's", () => {
    const { db, a } = seed();
    classifyUnformed(db, "p", { states: ["proposed"] });
    expect(setRuleForm(db, "p", a, { form: "hook", reason: "jev: p=0.7 hook", by: "jev" })).toBe(true);
    expect(setRuleForm(db, "p", a, { form: "skill", reason: "the owner said so", by: "owner" })).toBe(true);
    expect(setRuleForm(db, "p", a, { form: "check", reason: "heuristic", by: "heuristic" })).toBe(false);
    expect(setRuleForm(db, "p", a, { form: "memory", reason: "jev", by: "jev" })).toBe(false);
    expect(getRuleProposal(db, "p", a)).toMatchObject({ form: "skill", formBy: "owner" });
  });

  it("records the mechanism that enforces a rule", () => {
    const { db, a } = seed();
    expect(markMechanized(db, "p", a, "contract lint verification_masked_exit (tests/contract-lint-exit-status.test.ts)", 99)).toBe(true);
    expect(getRuleProposal(db, "p", a)).toMatchObject({ mechanizedBy: expect.stringContaining("verification_masked_exit"), mechanizedAt: 99 });
    expect(listRuleForms(db, "p", ["proposed"]).find((row) => row.id === a)!.mechanizedBy).toContain("contract lint");
  });
});
