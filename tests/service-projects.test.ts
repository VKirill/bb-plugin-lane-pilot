import { describe, expect, it } from "vitest";
import { hideServiceProjects } from "../src/rooms/stability/server/service-projects";

describe("Lane Pilot's service projects stay out of the sidebar", () => {
  it("hides «LP sandbox …» and «LP bench …» once, and leaves a project the owner styled as he set it", async () => {
    const saved: unknown[] = [];
    const items: Record<string, unknown> = { "p:p_owner_set": { hidden: false } };
    const hidden = await hideServiceProjects({
      projects: { list: async () => [{ id: "p_work", name: "FeedGen" }, { id: "p_sandbox", name: "LP sandbox rules" }, { id: "p_bench", name: "LP bench cakekeeper" }, { id: "p_owner_set", name: "LP bench SelfyStudio" }] },
      callRpc: async ({ method, input }) => {
        if (method === "prefs_get") return { items };
        saved.push(input);
        return { ok: true };
      },
      log: () => undefined,
    });
    expect(hidden).toEqual(["p_sandbox", "p_bench"]);
    expect(saved).toEqual([{ key: "p:p_sandbox", style: { hidden: true } }, { key: "p:p_bench", style: { hidden: true } }]);
  });

  it("does nothing without project-folders", async () => {
    expect(await hideServiceProjects({ projects: { list: async () => [{ id: "p", name: "LP sandbox x" }] }, callRpc: undefined, log: () => undefined })).toEqual([]);
  });
});
