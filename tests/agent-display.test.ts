import { describe, expect, it } from "vitest";
import { compileMainAgentProfile, MAIN_AGENT_PROFILE_IDS } from "../src/agent-profile";
import { agentPickerLabel, STOCK_AGENT_SEED_DESCRIPTIONS } from "../src/agent-display";
import { t, setLocaleOverride } from "../i18n";

describe("agent picker display labels", () => {
  it("maps stock seed and bundled names and keeps custom names", () => {
    for (const id of MAIN_AGENT_PROFILE_IDS) {
      expect(agentPickerLabel({ id, description: compileMainAgentProfile(id).description }, t)).not.toBe(
        STOCK_AGENT_SEED_DESCRIPTIONS[id],
      );
    }
    setLocaleOverride("en");
    expect(agentPickerLabel({ id: "dev-orchestrator", description: "Lane Pilot development orchestrator" }, t))
      .toBe("Development coordinator");
    expect(agentPickerLabel({ id: "dev-orchestrator", description: "Development coordinator" }, t))
      .toBe("Development coordinator");
    expect(agentPickerLabel({ id: "tavily", description: "Lane Pilot Tavily research agent" }, t))
      .toBe("Researcher");
    expect(agentPickerLabel({ id: "copy-lead", description: "My desk editor" }, t)).toBe("My desk editor");
    expect(agentPickerLabel({ id: "custom-writer", description: "Lane Pilot development orchestrator" }, t))
      .toBe("Lane Pilot development orchestrator");
    setLocaleOverride("ru");
    expect(agentPickerLabel({ id: "dev-orchestrator", description: "Development coordinator" }, t))
      .toBe("Координатор разработки");
    expect(agentPickerLabel({ id: "seo-specialist", description: "Мой SEO" }, t)).toBe("Мой SEO");
    setLocaleOverride(null);
  });
});
