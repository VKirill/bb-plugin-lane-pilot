import { describe, expect, it } from "vitest";
import { compileMainAgentProfile, MAIN_AGENT_PROFILE_IDS } from "../src/rooms/native-agent/agent-profile";
import { agentBadgeChart, agentKind, agentPickerLabel, composerAgentLabel, STOCK_AGENT_SEED_DESCRIPTIONS } from "../src/rooms/native-agent/agent-display";
import { t, setLocaleOverride } from "@lane-pilot/i18n";

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

  it("assigns a stable theme chart token per stock agent", () => {
    expect(agentBadgeChart("copy-lead")).toBe(2);
    expect(agentBadgeChart("dev-orchestrator")).toBe(1);
    expect(agentBadgeChart("design-lead")).toBe(4);
    expect(agentBadgeChart("copy-lead")).not.toBe(agentBadgeChart("seo-specialist"));
    expect(agentBadgeChart("night-desk")).toBe(agentBadgeChart("night-desk"));
  });

  it("classifies agents by the registry kind, falling back to the ids", () => {
    expect(agentKind({ id: "dev-orchestrator" })).toBe("coordinator");
    expect(agentKind({ id: "project-onboarder" })).toBe("internal");
    expect(agentKind({ id: "copy-lead" })).toBe("specialist");
    expect(agentKind({ id: "custom-video" })).toBe("specialist");
    expect(agentKind({ id: "copy-lead", kind: "internal" })).toBe("internal");
    expect(agentKind({ id: "dev-orchestrator", kind: "specialist" })).toBe("specialist");
  });

  it("names the coordinator Lane Pilot on the composer and keeps other labels", () => {
    expect(composerAgentLabel({ id: "dev-orchestrator", description: "Development coordinator" }, t)).toBe("Lane Pilot");
    expect(composerAgentLabel({ id: "copy-lead", description: "Copy editor" }, t)).toBe("Copy editor");
    expect(composerAgentLabel({ id: "my-lead", description: "Mine", kind: "coordinator" }, t)).toBe("Lane Pilot");
  });
});
