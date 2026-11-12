import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { writerDiffRules } from "../../src/rooms/learning/rule-diff";

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

describe("the accepted writer rules", () => {
  it("writerDiffRules keeps writer and both rules, drops pm ones", () => {
    const rules = writerDiffRules(rulesDb() as never, "p1");
    expect(rules).toContain("never edit a lockfile");
    expect(rules).toContain("answer in the owner's language");
    expect(rules).not.toContain("plan before code");
  });
});
