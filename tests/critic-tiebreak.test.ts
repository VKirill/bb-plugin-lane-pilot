import { describe, expect, it } from "vitest";
import { majorityRubric, parseTiebreakVotes, resolveRubricTiebreak, rubricDisagreements, tiebreakPrompt } from "../src/rooms/critique/tiebreak";
import { roleRowOf, roleRow, ROLE_IDS } from "@lane-pilot/models";
import type { Verdict } from "@lane-pilot/workflow-engine";

const verdict = (rubric: Array<{ id: string; result: "ok" | "fail"; evidence?: string }>): Verdict =>
  ({ status: "pass", findings: [], evidence: "test", rubric: rubric.map((item) => ({ evidence: "", ...item })) });

describe("critic tiebreak", () => {
  it("the role is in the table: Gemini 3.8 Flash through 9router by default", () => {
    expect(ROLE_IDS).toContain("critic-tiebreak");
    const row = roleRow("critic-tiebreak");
    expect(row.default.model).toBe("router9/ag/gemini-3.8-flash-high");
    expect(roleRowOf("critic-tiebreak")).toBe("critic-tiebreak");
  });

  it("finds only the items the two critics answered differently", () => {
    const a = verdict([{ id: "acceptance", result: "ok" }, { id: "checks", result: "ok" }, { id: "tests", result: "fail", evidence: "no test file" }]);
    const b = verdict([{ id: "acceptance", result: "fail", evidence: "missing endpoint" }, { id: "checks", result: "ok" }, { id: "tests", result: "ok" }]);
    expect(rubricDisagreements(a, b)).toEqual(["acceptance", "tests"]);
  });

  it("the majority decides: the third vote settles each contested item", async () => {
    const a = verdict([{ id: "acceptance", result: "ok" }, { id: "checks", result: "fail", evidence: "red suite" }]);
    const b = verdict([{ id: "acceptance", result: "fail", evidence: "missing endpoint" }, { id: "checks", result: "ok" }]);
    const votes = new Map([["acceptance", "fail" as const], ["checks", "ok" as const]]);
    const result = await resolveRubricTiebreak({ a, b, vote: async () => votes });
    expect(result.contested).toEqual({ acceptance: "fail", checks: "ok" });
    expect(Object.fromEntries(result.rubric.map((item) => [item.id, item.result]))).toEqual({ acceptance: "fail", checks: "ok" });
    // The fail side's evidence is what the merged rubric quotes.
    expect(result.rubric.find((item) => item.id === "acceptance")?.evidence).toBe("missing endpoint");
    expect(result.rubric.find((item) => item.id === "checks")?.evidence).toBe("");
  });

  it("a contested item the third voice did not answer stays a fail", () => {
    const a = verdict([{ id: "substance", result: "ok" }]);
    const b = verdict([{ id: "substance", result: "fail", evidence: "stub only" }]);
    const merged = majorityRubric(a, b, new Map());
    expect(merged[0]?.result).toBe("fail");
    expect(merged[0]?.evidence).toBe("stub only");
  });

  it("agreed rows are never asked again and keep their result", async () => {
    const a = verdict([{ id: "acceptance", result: "ok" }, { id: "tests", result: "fail", evidence: "no coverage" }]);
    const b = verdict([{ id: "acceptance", result: "ok" }, { id: "tests", result: "fail", evidence: "no coverage" }]);
    let called = false;
    const result = await resolveRubricTiebreak({ a, b, vote: async () => { called = true; return new Map(); } });
    expect(called).toBe(false);
    expect(result.contested).toEqual({});
    expect(result.rubric.map((item) => item.result)).toEqual(["ok", "fail"]);
  });

  it("parses only votes for the contested items out of the model's JSON", () => {
    const votes = parseTiebreakVotes('noise {"votes":[{"id":"checks","result":"ok"},{"id":"alien","result":"fail"},{"id":"tests","result":"maybe"}]} tail', ["checks", "tests"]);
    expect([...votes.entries()]).toEqual([["checks", "ok"]]);
    expect(parseTiebreakVotes("not json", ["checks"]).size).toBe(0);
  });

  it("the prompt carries both critics' results and evidence for the contested items", () => {
    const a = verdict([{ id: "checks", result: "ok", evidence: "suite green" }]);
    const b = verdict([{ id: "checks", result: "fail", evidence: "exit 1" }]);
    const prompt = tiebreakPrompt({ kind: "code", items: ["checks"], a, b });
    expect(prompt).toContain("checks");
    expect(prompt).toContain("suite green");
    expect(prompt).toContain("exit 1");
  });
});
