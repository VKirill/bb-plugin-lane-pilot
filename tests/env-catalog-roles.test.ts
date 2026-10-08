import { describe, expect, it } from "vitest";
import { HELPER_ROLES, ROLE_PROFILES } from "../src/helper-context";
import { WRITER_SETUP_LINES } from "../src/server/writer-task";
import { qaThreadPrompt } from "../src/server/stages/qa-thread";
import { specialistPrompt } from "../src/server/specialists";

describe("Env Catalog access by role (J1)", () => {
  it("only errands and specialists carry its tools", () => {
    const withCatalog = HELPER_ROLES.filter((role) => ROLE_PROFILES[role].bbPlugins.includes("env-catalog"));
    expect(withCatalog.sort()).toEqual(["errand", "specialist:copy-lead", "specialist:design-lead", "specialist:seo-specialist", "specialist:tavily"]);
    for (const role of withCatalog) expect(ROLE_PROFILES[role].skills, role).toContain("env-catalog");
  });

  it("a prompt promises env tools only to a role that has them", () => {
    expect(ROLE_PROFILES["writer"].bbPlugins).not.toContain("env-catalog");
    expect(WRITER_SETUP_LINES.join("\n")).not.toContain("env_get");
    expect(specialistPrompt("@m", "tavily", "x")).toContain("env_get");
    expect(qaThreadPrompt({ url: "http://x/", cases: ["a"], viewports: "375", envClass: "local", authorized: false, qaHostId: "h" })).not.toContain("env_get");
  });
});
