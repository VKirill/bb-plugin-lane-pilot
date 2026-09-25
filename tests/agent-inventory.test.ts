import { describe, expect, it } from "vitest";
import { applyResourceMode, collectAgentInventory, mergeInventoryItems, resourceModeOf } from "../src/agent-inventory";

describe("agent inventory", () => {
  it("keeps inherit, none, and selected distinct", () => {
    expect(resourceModeOf(undefined)).toBe("inherit");
    expect(resourceModeOf([])).toBe("none");
    expect(resourceModeOf(["Read"])).toBe("selected");
    expect(applyResourceMode("inherit", ["x"], ["y"])).toBeUndefined();
    expect(applyResourceMode("none", ["x"], ["y"])).toEqual([]);
    expect(applyResourceMode(undefined, undefined, ["kept"])).toEqual(["kept"]);
  });

  it("does not treat an inventory error as an empty catalog", async () => {
    const inventory = await collectAgentInventory({
      projectId: "proj_a",
      listSkills: async () => { throw new Error("skills down"); },
    });
    expect(inventory.skills).toMatchObject({ status: "error", items: [] });
    expect(inventory.tools.status).toBe("unavailable");
    expect(mergeInventoryItems([], ["copywriter"]).map((item) => item.name)).toEqual(["copywriter"]);
  });
});
