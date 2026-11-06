import { describe, expect, it } from "vitest";
import { publishedCatalog } from "./workflow/router-catalog";
import { attachNearest, formHypothesis, graphSignalsOf, nearestUnits, SKILL_NEAR_SCORE, type FormHint, type GroupSignals, type NearestUnit } from "../src/rooms/lead/server/nearest";

const skills = (...entries: Array<[string, string]>): Array<{ name: string; description: string | null }> =>
  entries.map(([name, description]) => ({ name, description }));

describe("nearestUnits (stream G/R8)", () => {
  it("returns at most four units, graphs and skills ranked by score", async () => {
    const units = await nearestUnits("ss-photo доставка фотографий клиенту", {
      workflows: [],
      skills: skills(
        ["selfystudio", "SelfyStudio photo pipeline: shoot pages, photosets, delivery to the client"],
        ["image-prompting", "Image prompts for SelfyStudio chat models"],
        ["unrelated", "Quarterly tax filing for a bakery"],
      ),
      tree: null,
    });
    expect(units.length).toBeLessThanOrEqual(4);
    expect(units[0]).toMatchObject({ kind: "skill", id: "selfystudio" });
    for (let i = 1; i < units.length; i += 1) expect(units[i - 1]!.score).toBeGreaterThanOrEqual(units[i]!.score);
  });

  it("caps at four even when more skills match, and graph candidates join the ranking", async () => {
    const many = skills(
      ["alpha-photo", "photo delivery alpha"], ["beta-photo", "photo delivery beta"], ["gamma-photo", "photo delivery gamma"],
      ["delta-photo", "photo delivery delta"], ["eps-photo", "photo delivery eps"], ["zeta-photo", "photo delivery zeta"],
    );
    const units = await nearestUnits("photo delivery shoot", { workflows: publishedCatalog(), skills: many, tree: null });
    expect(units.length).toBeLessThanOrEqual(4);
    expect(units.every((unit) => unit.kind === "graph" || unit.kind === "skill")).toBe(true);
  });

  it("a skill under the near threshold does not count as the same family", async () => {
    const units = await nearestUnits("совсем другая задача про кулинарию", {
      workflows: [],
      skills: skills(["selfystudio", "SelfyStudio photo pipeline delivery"]),
      tree: null,
    });
    const near = units.find((unit) => unit.kind === "skill" && unit.score >= SKILL_NEAR_SCORE);
    expect(near).toBeUndefined();
  });
});

const signals = (over: Partial<GroupSignals> = {}): GroupSignals => ({ repeatedTrace: null, providers: 1, ...over });
const nearest = (...entries: Array<[NearestUnit["kind"], string, number]>): NearestUnit[] =>
  entries.map(([kind, id, score]) => ({ kind, id, score }));

describe("formHypothesis (stream G/R8)", () => {
  it("the same command sequence in three ok traces is a script — the ss-photo case on the selfystudio family", () => {
    const hint = formHypothesis({ nearest: nearest(["skill", "selfystudio", 0.9]), signals: signals({ repeatedTrace: "ok" }), graphSignals: false });
    expect(hint.form).toBe("script");
  });

  it("a near skill of the same family gives a reference; a repeated failure makes it a rule", () => {
    const near = nearest(["skill", "selfystudio", SKILL_NEAR_SCORE]);
    expect(formHypothesis({ nearest: near, signals: signals(), graphSignals: false }).form).toBe("reference");
    expect(formHypothesis({ nearest: near, signals: signals({ repeatedTrace: "failed" }), graphSignals: false }).form).toBe("rule");
    // The trap is a rule even without a near skill.
    expect(formHypothesis({ nearest: [], signals: signals({ repeatedTrace: "failed" }), graphSignals: false }).form).toBe("rule");
  });

  it("gates, schedules and different helpers make a graph; nothing near makes a skill", () => {
    expect(formHypothesis({ nearest: nearest(["skill", "selfystudio", 0.9]), signals: signals(), graphSignals: true }).form).toBe("graph");
    expect(formHypothesis({ nearest: nearest(["graph", "invoice-send", 0.7]), signals: signals(), graphSignals: false }).form).toBe("skill");
    expect(formHypothesis({ nearest: [], signals: signals(), graphSignals: false }).form).toBe("skill");
  });

  it("negatives: two traces are not a script, a weak skill is not a family, providers alone can make a graph", () => {
    // repeatedTrace is computed upstream; a null here must not become a script.
    expect(formHypothesis({ nearest: [], signals: signals({ repeatedTrace: null }), graphSignals: false }).form).toBe("skill");
    expect(formHypothesis({ nearest: nearest(["skill", "selfystudio", SKILL_NEAR_SCORE - 0.01]), signals: signals(), graphSignals: false }).form).toBe("skill");
    expect(graphSignalsOf({ samples: ["обычное поручение"], signals: signals({ providers: 2 }) })).toBe(true);
    expect(graphSignalsOf({ samples: ["обычное поручение"], signals: signals({ providers: 1 }) })).toBe(false);
    expect(graphSignalsOf({ samples: ["выставить счёт в Эльбе"], signals: signals() })).toBe(true);
    expect(graphSignalsOf({ samples: ["проверить статус сборки"], signals: signals() })).toBe(false);
  });
});

describe("attachNearest (stream G/R8)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    kind: "computer", samples: ["ss-photo доставка фото клиенту"], projects: ["p_a"],
    signals: signals({ repeatedTrace: "ok" }), nearest: [] as NearestUnit[], hint: null as FormHint | null, ...over,
  });
  const bb = (skillsList: () => Promise<unknown>) => ({
    sdk: { skills: { list: skillsList } },
    log: { warn: () => undefined },
  });

  it("fills nearest and hint once per tick; the skills list is read once per project", async () => {
    let calls = 0;
    const rows = [row(), row({ samples: ["другой процесс совсем"] })];
    const logs: string[] = [];
    await attachNearest({
      bb: bb(async () => { calls += 1; return { skills: [{ name: "selfystudio", description: "photo pipeline delivery" }] }; }) as never,
      workflowCatalog: { store: async () => ({ list: () => [] }) } as never,
      fallbackProjectId: null, rows, log: (message) => logs.push(message), readTree: async () => null,
    });
    expect(calls).toBe(1);
    expect(rows[0]!.hint?.form).toBe("script");
    expect(rows[0]!.nearest.some((unit) => unit.kind === "skill" && unit.id === "selfystudio")).toBe(true);
    expect(rows[1]!.hint?.form).toBe("script");
    expect(logs).toEqual([]);
  });

  it("an unreadable skills list leaves hint null and logs lead_nearest_unavailable once", async () => {
    const rows = [row(), row({ projects: ["p_b"] })];
    const logs: string[] = [];
    await attachNearest({
      bb: bb(async () => { throw new Error("sdk down"); }) as never,
      workflowCatalog: undefined, fallbackProjectId: null, rows,
      log: (message) => logs.push(message), readTree: async () => null,
    });
    expect(rows.every((item) => item.hint === null && item.nearest.length === 0)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("lead_nearest_unavailable");
  });
});
