import { describe, expect, it } from "vitest";
import type { RouterCard } from "@lane-pilot/workflow-engine";
import { filterByPolicy, manifestOf, routePolicyOf } from "../../src/rooms/workflow/route-policy";

const card = (id: string, requires: Partial<RouterCard["requires"]> = {}): RouterCard => ({
  id, name: { en: `${id} name`, ru: `${id} имя` }, description: { en: `${id} does work`, ru: "" }, examples: { en: [`do ${id}`], ru: [] },
  not_for: [], tags: [], inputs: [], outputs: [],
  requires: { plugins: [], skills: [], secrets: [], machines: [], env: [], browserSession: false, mcp: [], tools: [], platforms: [], ...requires },
  score: 0.5, rules: [],
});

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
