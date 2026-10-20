import { describe, expect, it } from "vitest";
import {
  kindCacheKey, pickWriterSkills, projectFolderSkills, skillCatalog, skillPickState,
  type CatalogEntry, type KindCache, type SkillAnswers, type SkillAsk, type SkillQuestion,
} from "@lane-pilot/jev/judgments/skill-pick";

const entry = (name: string, description = `${name} skill`): CatalogEntry => ({ name, description });
const task = { title: "Add rate limit", objective: "Limit the API", owns_paths: ["src/api.ts"], expected_outputs: ["src/api.ts"], acceptance: ["tests pass"], verification_commands: ["npm test"] };

function memoryCache(): KindCache & { values: Map<string, number> } {
  const values = new Map<string, number>();
  return { values, get: async (key) => values.get(key), set: async (key, p) => { values.set(key, p); } };
}

/**
 * A System One stand-in: `kinds` gives each skill its «domain» probability, `crafts` its «craft» probability (default 0: not a craft),
 * `relevant` its «yes» for the technology question and `judged` its «yes» for the craft question (default 0.05).
 */
function fakeJev(options: { kinds?: Record<string, number>; crafts?: Record<string, number>; relevant?: Record<string, number>; judged?: Record<string, number> } = {}) {
  const calls: Array<{ state: unknown; questions: Record<string, SkillQuestion> }> = [];
  const ask: SkillAsk = async (state, questions) => {
    calls.push({ state, questions });
    const answers: SkillAnswers = {};
    for (const [id, question] of Object.entries(questions)) {
      const name = /^Skill — (.+?): /.exec(question.instructions)![1]!;
      if ("domain" in question.criteria) {
        const domain = options.kinds?.[name] ?? 0.9;
        answers[id] = { domain, agent_ops: 1 - domain };
      } else if ("craft" in question.criteria) {
        const craft = options.crafts?.[name] ?? 0;
        answers[id] = { craft, product: 1 - craft };
      } else if (/judged by/.test(question.instructions)) {
        const yes = options.judged?.[name] ?? 0.05;
        answers[id] = { yes, no: 1 - yes };
      } else {
        const yes = options.relevant?.[name] ?? 0.05;
        answers[id] = { yes, no: 1 - yes };
      }
    }
    return answers;
  };
  const kindCalls = (criterion: string) => calls.filter((call) => criterion in Object.values(call.questions)[0]!.criteria).length;
  return { ask, calls, kindCalls: () => kindCalls("domain"), craftKindCalls: () => kindCalls("craft") };
}

const pickInput = (overrides: Partial<Parameters<typeof pickWriterSkills>[0]>) => ({
  enabled: true, catalog: [] as CatalogEntry[], hints: [] as string[], task, plan: "Make the rate limiter", projectCwd: "/home/ubuntu/work/api",
  ask: fakeJev().ask, kindCache: memoryCache(), ...overrides,
});

describe("skill catalog", () => {
  it("drops the writer's own skills, a plugin copy of a plain name, and a skill with no description", () => {
    const catalog = skillCatalog([
      { name: "writer-practices", description: "base" },
      { name: "bb-global-skills:writer-practices", description: "base copy" },
      { name: "tavily", description: "Web search" },
      { name: "acme:tavily", description: "Web search copy" },
      { name: "empty", description: "  " },
      { name: "plug:only", description: "only a plugin copy" },
    ]);
    expect(catalog.map((row) => row.name)).toEqual(["tavily", "plug:only"]);
  });

  it("keys a kind verdict by the name and the description, so a changed description is asked again", () => {
    expect(kindCacheKey(entry("a", "one"))).not.toBe(kindCacheKey(entry("a", "two")));
  });
});

describe("skill pick", () => {
  it("keeps a skill whose domain probability is at least 0.2 and drops the rest", async () => {
    const jev = fakeJev({ kinds: { a: 0.5, b: 0.1 }, relevant: { a: 0.9, b: 0.9 } });
    const pick = await pickWriterSkills(pickInput({ catalog: [entry("a"), entry("b")], ask: jev.ask }));
    expect(pick.picked.map((row) => row.name)).toEqual(["a"]);
    expect(pick.skills).toEqual(["a"]);
  });

  it("picks a skill at p(yes) 0.4 or more and not one below it", async () => {
    const jev = fakeJev({ relevant: { x: 0.4, y: 0.39 } });
    const pick = await pickWriterSkills(pickInput({ catalog: [entry("x"), entry("y")], ask: jev.ask }));
    expect(pick.picked).toEqual([{ name: "x", p: 0.4 }]);
  });

  it("picks at most five skills, the most probable first", async () => {
    const names = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    const relevant = Object.fromEntries(names.map((name, index) => [name, 0.5 + index / 100]));
    const pick = await pickWriterSkills(pickInput({ catalog: names.map((name) => entry(name)), ask: fakeJev({ relevant }).ask }));
    expect(pick.picked.map((row) => row.name)).toEqual(["s7", "s6", "s5", "s4", "s3"]);
  });

  it("adds the plain skill named in the project folder even when Jev says no", async () => {
    const pick = await pickWriterSkills(pickInput({
      catalog: [entry("selfystudio"), entry("other-skill")], projectCwd: "/home/ubuntu/apps/selfystudio",
    }));
    expect(pick.projectFolder).toEqual(["selfystudio"]);
    expect(pick.skills).toEqual(["selfystudio"]);
  });

  it("does not take a plugin skill for the project folder, or a name shorter than six characters", () => {
    expect(projectFolderSkills("/home/ubuntu/apps/selfystudio", [entry("acme:selfystudio"), entry("apps")])).toEqual([]);
  });

  it("sends the task's plan and project folder with the question about the task", async () => {
    const jev = fakeJev({ relevant: { x: 0.9 } });
    await pickWriterSkills(pickInput({ catalog: [entry("x")], ask: jev.ask }));
    const taskCall = jev.calls[jev.calls.length - 1]!;
    expect(taskCall.state).toEqual(skillPickState(task, "Make the rate limiter", "/home/ubuntu/work/api"));
    expect((taskCall.state as { task: { plan: string } }).task.plan).toBe("Make the rate limiter");
  });

  it("does not ask the kind of a skill again when the cache holds it", async () => {
    const cache = memoryCache();
    const first = fakeJev({ relevant: { x: 0.9 } });
    await pickWriterSkills(pickInput({ catalog: [entry("x")], ask: first.ask, kindCache: cache }));
    const second = fakeJev({ relevant: { x: 0.9 } });
    await pickWriterSkills(pickInput({ catalog: [entry("x")], ask: second.ask, kindCache: cache }));
    expect(first.kindCalls()).toBe(1);
    expect(second.kindCalls()).toBe(0);
    expect(first.craftKindCalls()).toBe(1);
    expect(second.craftKindCalls()).toBe(0);
  });

  it("adds a craft skill the task's result is judged by, after the technology picks, at 0.6 or more and at most three", async () => {
    const catalog = ["vue-lib", "design-taste", "impeccable-ui", "ui-review", "web-design", "copywriter"].map((name) => entry(name));
    const crafts = { "design-taste": 0.9, "impeccable-ui": 0.9, "ui-review": 0.9, "web-design": 0.9, copywriter: 0.9 };
    const judged = { "design-taste": 0.95, "impeccable-ui": 0.9, "ui-review": 0.8, "web-design": 0.7, copywriter: 0.59 };
    const jev = fakeJev({ crafts, relevant: { "vue-lib": 0.8 }, judged });
    const pick = await pickWriterSkills(pickInput({ catalog, ask: jev.ask }));
    expect(pick.picked).toEqual([{ name: "vue-lib", p: 0.8 }]);
    expect(pick.craft).toEqual([{ name: "design-taste", p: 0.95 }, { name: "impeccable-ui", p: 0.9 }, { name: "ui-review", p: 0.8 }]);
    expect(pick.skills).toEqual(["vue-lib", "design-taste", "impeccable-ui", "ui-review"]);
    expect(pick.craftKept).toBe(5);
  });

  it("asks the craft question only to craft skills, and a skill picked for its technology is not repeated as a craft", async () => {
    const jev = fakeJev({ crafts: { "ui-ux-pro-max": 0.9, "vue-lib": 0.1 }, relevant: { "ui-ux-pro-max": 0.5 }, judged: { "ui-ux-pro-max": 0.9, "vue-lib": 0.9 } });
    const pick = await pickWriterSkills(pickInput({ catalog: [entry("vue-lib"), entry("ui-ux-pro-max")], ask: jev.ask }));
    const craftAsks = jev.calls.filter((call) => /judged by/.test(Object.values(call.questions)[0]!.instructions));
    expect(craftAsks.map((call) => Object.values(call.questions).map((q) => /^Skill — (.+?): /.exec(q.instructions)![1]))).toEqual([["ui-ux-pro-max"]]);
    expect(pick.picked).toEqual([{ name: "ui-ux-pro-max", p: 0.5 }]);
    expect(pick.craft).toEqual([]);
    expect(pick.skills).toEqual(["ui-ux-pro-max"]);
  });

  it("asks at most eight questions in one call", async () => {
    const catalog = Array.from({ length: 17 }, (_, index) => entry(`skill-${index}`));
    const jev = fakeJev();
    await pickWriterSkills(pickInput({ catalog, ask: jev.ask }));
    // The kind, the craft kind and the technology question; no skill is a craft, so the craft question is not asked.
    expect(jev.calls.map((call) => Object.keys(call.questions).length)).toEqual([8, 8, 1, 8, 8, 1, 8, 8, 1]);
  });

  it("keeps at most six Jev calls in flight across picks, so a burst of writers does not queue at the provider", async () => {
    let inFlight = 0, peak = 0;
    const slow: SkillAsk = async (state, questions) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return fakeJev().ask(state, questions);
    };
    const catalog = Array.from({ length: 80 }, (_, index) => entry(`skill-${index}`));
    await Promise.all([1, 2, 3].map(() => pickWriterSkills(pickInput({ catalog, ask: slow }))));
    expect(peak).toBe(6);
  });

  it("keeps only the PM's hints that name a skill of the catalog", async () => {
    const pick = await pickWriterSkills(pickInput({ catalog: [entry("tavily")], hints: ["tavily", "not-listed"] }));
    expect(pick.hints).toEqual(["tavily"]);
    expect(pick.skills).toEqual(["tavily"]);
  });

  it("with the pick off gives the hints only and asks Jev nothing", async () => {
    const jev = fakeJev({ relevant: { x: 0.9 } });
    const pick = await pickWriterSkills(pickInput({ enabled: false, catalog: [entry("x"), entry("tavily")], hints: ["tavily"], ask: jev.ask }));
    expect(pick.skills).toEqual(["tavily"]);
    expect(jev.calls).toEqual([]);
  });

  it("an error from Jev gives no picks and keeps the hints", async () => {
    const pick = await pickWriterSkills(pickInput({
      catalog: [entry("x"), entry("tavily")], hints: ["tavily"],
      ask: async () => { throw new Error("System One is down"); },
    }));
    expect(pick.picked).toEqual([]);
    expect(pick.skills).toEqual(["tavily"]);
    // Two skills nobody judged the kind of; nothing was kept, so no further question was asked.
    expect(pick.unanswered).toBe(2);
  });

  it("a call that answers nothing adds nothing from it", async () => {
    const pick = await pickWriterSkills(pickInput({ catalog: [entry("x")], ask: async () => null }));
    expect(pick.skills).toEqual([]);
    expect(pick.unanswered).toBe(1);
  });
});
