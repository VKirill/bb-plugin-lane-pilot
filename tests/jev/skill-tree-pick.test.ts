import { describe, expect, it } from "vitest";
import { createJev, type JevAnswer, type JevClient } from "@lane-pilot/jev";
import { skillTreePickJudgment } from "@lane-pilot/jev/judgments/skill-tree-pick";
import { pickSkillTree } from "../../src/rooms/writer/server/skill-tree";

const ch = (top: string) => ({ type: "choice" as const, choice: top, probabilities: { [top]: 0.8 }, confidence: 0.9 });

describe("skills.tree_pick", () => {
  it("takes options over the bar, drops none", () => {
    const d = skillTreePickJudgment.decide({ pick: ch("seo") }, { pick_p: 0.3, take_max: 3 }, { task: "t", level: "section", path: "/", options: {} });
    expect(d.decision?.picked).toEqual(["seo"]);
  });
  it("walks the tree: section → skill names come back", async () => {
    const client: JevClient = {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request) {
        const answers: Record<string, JevAnswer> = {};
        for (const [id] of Object.entries(request.questions)) {
          const probs = Object.fromEntries(Object.keys((request.questions[id] as { criteria?: Record<string, string> }).criteria ?? {}).map((k, i) => [k, i === 0 ? 0.9 : 0.02]));
          answers[id] = { type: "choice", choice: "seo", probabilities: { seo: 0.9, texts: 0.02, none: 0.02, "seo-copy": 0.9 }, confidence: 0.9 };
        }
        return { ok: true, answers, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1 };
      },
    };
    const jev = createJev({ client, db: null });
    const tree = { sections: [{ id: "seo", title: "SEO" }], skills: [{ name: "seo-copy", category: { sectionId: "seo", subsectionId: "" } }] };
    const got = await pickSkillTree(jev, tree, { title: "write seo page", prompt: "" }, { settings: { "jev.modes": "skills.tree_pick=active" } });
    expect(got.skills).toContain("seo-copy");
    expect(got.by).toBe("jev");
  });
  it("whitelist state", () => {
    const state = skillTreePickJudgment.stateBuilder({ task: "t", level: "skill", path: "/x", options: { a: "b" }, extra: "drop" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["level", "options", "path", "task"]);
  });
});
