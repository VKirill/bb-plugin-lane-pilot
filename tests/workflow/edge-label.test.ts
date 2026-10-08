import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgeCaption, humanCondition } from "@lane-pilot/workflow-engine/ui";

describe("the words on a connection", () => {
  it("says the owner's examples in plain Russian and English", () => {
    expect(humanCondition("brainstorm.status in ['ok','low_confidence']", "ru")).toBe("если ok или неуверенно");
    expect(humanCondition("build.status == 'partial' && visits('replan') == 0", "ru")).toBe("если частично и ещё не перепланировали");
    expect(humanCondition("brainstorm.status in ['ok','low_confidence']", "en")).toBe("if ok or low confidence");
    expect(humanCondition("build.status == 'partial' && visits('replan') == 0", "en")).toBe("if partial and not re-planned yet");
  });

  it("reads statuses, answers, flags, emptiness and counters", () => {
    expect(humanCondition("qa.status == 'pass'", "ru")).toBe("если пройдено");
    expect(humanCondition("build.status != 'done'", "ru")).toBe("если не готово");
    expect(humanCondition("ask_scope.answer_kind == 'clarify'", "en")).toBe("if answer = clarify");
    expect(humanCondition("!load.found", "ru")).toBe("если не найдено");
    expect(humanCondition("verify_cause.confirmed && $inputs.auto_fix", "en")).toBe("if confirmed and auto fix");
    expect(humanCondition("build.merged_commits.length > 0", "en")).toBe("if merged commits not empty");
    expect(humanCondition("$inputs.incident == ''", "en")).toBe("if incident is empty");
    expect(humanCondition("analyze.confidence < 40 || analyze.recommendation == 'no_go'", "ru")).toBe("если уверенность < 40 или рекомендация = не идти");
    expect(humanCondition("review.status == 'rework' && visits('replan') < 2", "en")).toBe("if needs rework and «replan» ran fewer than 2 times");
  });

  it("names a counted step by its title when it is given, and never throws on an expression it does not know", () => {
    const titles: Record<string, string> = { replan: "Re-plan" };
    expect(humanCondition("visits('replan') == 0", "en", (id) => titles[id] ?? null)).toBe("if «Re-plan» has not run yet");
    expect(humanCondition("foo(bar) ~ 1", "ru")).toBe("если foo(bar) ~ 1");
    expect(humanCondition("", "en")).toBeNull();
    expect(humanCondition(null, "en")).toBeNull();
  });

  it("prefers the author's own label", () => {
    expect(edgeCaption({ label: "gate not met - gather more evidence", when: "x.a == 1" }, "ru")).toBe("gate not met - gather more evidence");
    expect(edgeCaption({ label: null, when: "x.a == 1" }, "en")).toBe("if a = 1");
    expect(edgeCaption({ label: null, when: null }, "en")).toBeNull();
  });

  it("makes words of every condition of every shipped workflow", () => {
    let count = 0;
    for (const file of readdirSync("workflows").filter((name) => name.endsWith(".json"))) {
      const workflow = JSON.parse(readFileSync(`workflows/${file}`, "utf8")) as { edges?: Array<{ when?: unknown }> };
      for (const edge of workflow.edges ?? []) {
        if (typeof edge.when !== "string") continue;
        count += 1;
        for (const lang of ["en", "ru"] as const) {
          const text = humanCondition(edge.when, lang);
          expect(text, edge.when).toMatch(/^(if|если) \S/);
          expect(text, edge.when).not.toContain("undefined");
        }
      }
    }
    expect(count).toBeGreaterThan(50);
  });
});
