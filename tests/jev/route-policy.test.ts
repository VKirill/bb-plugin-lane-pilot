import { describe, expect, it } from "vitest";
import type { RouterCard, RouterModelInput } from "@lane-pilot/workflow-engine";
import { filterByPolicy, manifestOf, routePolicyOf } from "../../src/rooms/workflow/route-policy";
import { createJevRouterModel } from "../../src/rooms/workflow/route-model";
import type { Jev } from "@lane-pilot/jev";

const card = (id: string, requires: Partial<RouterCard["requires"]> = {}): RouterCard => ({
  id, name: { en: `${id} name`, ru: `${id} имя` }, description: { en: `${id} does work`, ru: "" }, examples: { en: [`do ${id}`], ru: [] },
  not_for: [], tags: [], inputs: [], outputs: [],
  requires: { plugins: [], skills: [], secrets: [], machines: [], env: [], browserSession: false, mcp: [], tools: [], platforms: [], ...requires },
  score: 0.5, rules: [],
});

const input = (candidates: RouterCard[]): RouterModelInput => ({ intent: "post the weekly update to threads", candidates });

describe("route policy manifest", () => {
  it("accounts, platforms and a browser session are high risk; tools and machines medium; plain work low", () => {
    expect(manifestOf(card("a", { secrets: ["STRIPE_KEY"] })).risk).toBe("high");
    expect(manifestOf(card("b", { platforms: ["threads"] })).risk).toBe("high");
    expect(manifestOf(card("c", { browserSession: true })).risk).toBe("high");
    expect(manifestOf(card("d", { machines: ["host_x"] })).risk).toBe("medium");
    expect(manifestOf(card("e", { tools: ["ffmpeg"] })).risk).toBe("medium");
    expect(manifestOf(card("f")).risk).toBe("low");
  });

  it("lists every permission the candidate asks for", () => {
    const m = manifestOf(card("g", { plugins: ["env-catalog"], secrets: ["STRIPE_KEY"], platforms: ["vk"], browserSession: true }));
    expect(m.permissions).toEqual(expect.arrayContaining(["plugin:env-catalog", "secret:STRIPE_KEY", "platform:vk", "browser:session"]));
  });

  it("a risk above the allowed level and a secret left out of secrets.allow are refused; an optional secret is not", () => {
    const out = filterByPolicy(
      [card("hi", { secrets: ["STRIPE_KEY"] }), card("opt", { secrets: ["TAVILY_API_KEY (optional research)"] }), card("ok")],
      { maxRisk: "medium", secretsAllow: ["STRIPE_KEY"] },
    );
    expect(out.allowed.map((c) => c.id)).toEqual(["opt", "ok"]);
    expect(out.rejected[0]).toMatchObject({ id: "hi" });
    expect(out.rejected[0]!.reason).toContain("risk high");
    const denied = filterByPolicy([card("hi", { secrets: ["STRIPE_KEY"] })], { secretsAllow: ["OTHER"] });
    expect(denied.rejected[0]!.reason).toContain("STRIPE_KEY is left out");
  });
});

describe("route policy in the router model", () => {
  const jevOf = (seen: { candidates?: string[] }): Jev => ({
    enabled: () => true,
    async judge(_j: unknown, i: unknown) { seen.candidates = (i as RouterModelInput).candidates.map((c) => c.id); return { by: "jev", decision: { choice: "ok", confidence: 90, pattern: "p", rejected: [], questions: [] }, receiptId: null, answers: {} }; },
    async judgeMany() { return []; },
    async judgeBundle() { return []; },
    outcome() {},
  } as unknown as Jev);

  it("forbidden candidates are cut before Jev and reported as rejected", async () => {
    const seen: { candidates?: string[] } = {};
    const model = createJevRouterModel({
      jev: () => jevOf(seen),
      settings: async () => ({ "secrets.allow": "OTHER" }) as never,
      legacy: async () => ({ choice: "legacy", confidence: 1, pattern: "l", rejected: [], questions: [] }),
      projectId: "p", runId: "r",
    });
    const out = await model(input([card("stripe", { secrets: ["STRIPE_KEY"] }), card("ok")]));
    expect(seen.candidates).toEqual(["ok"]);
    expect(out.choice).toBe("ok");
    expect(out.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ id: "stripe" })]));
  });

  it("with nothing left it escalates to the model step without asking Jev", async () => {
    let asked = false;
    const model = createJevRouterModel({
      jev: () => ({ enabled: () => true, async judge() { asked = true; throw new Error("must not be called"); } }) as unknown as Jev,
      settings: async () => ({ "route.max_risk": "low" }) as never,
      legacy: async (i) => ({ choice: i.candidates[0]!.id, confidence: 1, pattern: "l", rejected: [], questions: [] }),
      projectId: "p", runId: "r",
    });
    const out = await model(input([card("stripe", { secrets: ["STRIPE_KEY"] })]));
    expect(asked).toBe(false);
    expect(out.choice).toBe("stripe");
  });
});
