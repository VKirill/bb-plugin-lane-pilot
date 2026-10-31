import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roleRow } from "@lane-pilot/models";
import { ROLE_PROFILES } from "../src/rooms/native-agent/helper-context";
import { roleSpec } from "../src/rooms/workflow/server/workflow-agent";

// The owner (2026-10-31): a service's API is mapped through its pages by GPT Terra, the computer-use model, in a scenario of its own.
describe("the api-recon scenario", () => {
  const graph = JSON.parse(readFileSync(new URL("../workflows/api-recon.json", import.meta.url), "utf8")) as { nodes: Array<{ id: string; role?: string; prompt?: string }> };

  it("runs its crawl on the api-recon role, which defaults to GPT-6.1 Terra and carries only the browser and the login", () => {
    expect(graph.nodes.find((node) => node.id === "crawl")?.role).toBe("api-recon");
    expect(roleRow("api-recon").default).toMatchObject({ model: "gpt-6.1-terra", effort: "high" });
    expect(roleSpec("api-recon")).toMatchObject({ helper: "api-recon", readOnly: true });
    expect(ROLE_PROFILES["api-recon"]).toEqual({ bbPlugins: ["browser-automation", "env-catalog"], skills: ["browser-automation", "env-catalog"], mcpServers: [] });
  });

  it("is read-only and records the network and the bundles (the method of the magicseo recon)", () => {
    const prompt = graph.nodes.find((node) => node.id === "crawl")!.prompt!;
    expect(prompt).toMatch(/READ-ONLY/);
    expect(prompt).toMatch(/fetch and XMLHttpRequest/);
    expect(prompt).toMatch(/JS bundles/);
    expect(prompt).toMatch(/endpoints\.json/);
  });
});
