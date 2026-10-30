import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev, type JevClient } from "@lane-pilot/jev";
import { judgeRulesOnDiff, ruleDiffJudgment, ruleViolationRemark, writerDiffRules } from "../../src/rooms/learning/rule-diff";

function jevWith(noul: number) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      return { ok: true, model: "jev-test", usage: { input_tokens: 800, output_tokens: 30 }, latencyMs: 80, attempts: 1,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul }])) };
    },
  };
  return { db, jev: createJev({ client, db }) };
}

function rulesDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  let n = 0;
  for (const [rule, audience] of [["never edit a lockfile", "writer"], ["answer in the owner's language", "both"], ["plan before code", "pm"]] as const) {
    n += 1;
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience,always_on)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`r${n}`, "p1", `s${n}`, rule, "owner", "accepted", 1, 1, "[]", `m${n}`, 1, 1, 1, 1, audience, 0);
  }
  return db;
}

describe("learning.rule_diff: accepted writer rules judged against the diff", () => {
  it("writerDiffRules keeps writer and both rules, drops pm ones", () => {
    const rules = writerDiffRules(rulesDb() as never, "p1");
    expect(rules).toContain("never edit a lockfile");
    expect(rules).toContain("answer in the owner's language");
    expect(rules).not.toContain("plan before code");
  });

  it("decide marks a rule broken only at or above min_p; fallback marks none", () => {
    const input = { diff: "d", rules: ["a", "b"] };
    const answers = { r1: { type: "noul" as const, noul: 0.9 }, r2: { type: "noul" as const, noul: 0.2 } };
    expect(ruleDiffJudgment.decide(answers, { min_p: 0.7 }, input)).toEqual({ decision: [true, false] });
    expect(ruleDiffJudgment.fallback(input)).toEqual([false, false]);
  });

  it("shadow (the default): asks and records, reports no violation", async () => {
    const db = rulesDb();
    const { db: jevDb, jev } = jevWith(0.95);
    expect(await judgeRulesOnDiff(jev, db as never, "p1", "diff --git a/package-lock.json b/package-lock.json\n+lock\n", { settings: {} })).toEqual([]);
    const row = jevDb.prepare("SELECT judgment, mode, decided_by FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(row).toMatchObject({ judgment: "learning.rule_diff", mode: "shadow", decided_by: "fallback" });
  });

  it("active: a broken rule is named, a clean diff stays quiet", async () => {
    const db = rulesDb();
    const { jev } = jevWith(0.95);
    const broken = await judgeRulesOnDiff(jev, db as never, "p1", "diff --git a/x b/x\n+x\n", { settings: { "jev.modes": "learning.rule_diff=active" } });
    expect(broken).toContain("never edit a lockfile");
    const remark = ruleViolationRemark(broken);
    expect(remark).toContain("not a block");
    expect(remark).toContain("never edit a lockfile");
    expect(ruleViolationRemark([])).toBe("");
    const quiet = jevWith(0.1);
    expect(await judgeRulesOnDiff(quiet.jev, db as never, "p1", "diff --git a/x b/x\n+x\n", { settings: { "jev.modes": "learning.rule_diff=active" } })).toEqual([]);
  });

  it("no diff and no Jev are both a no-op", async () => {
    const db = rulesDb();
    const { jev } = jevWith(0.95);
    expect(await judgeRulesOnDiff(null, db as never, "p1", "d", { settings: {} })).toEqual([]);
    expect(await judgeRulesOnDiff(jev, db as never, "p1", "  ", { settings: {} })).toEqual([]);
  });
});
