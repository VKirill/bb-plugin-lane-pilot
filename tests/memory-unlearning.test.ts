import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { audit, unlearningResiduals } from "../scripts/memory-unlearning-audit";
import { openDatabase } from "../src/rooms/storage/database";

// arXiv #25: deleting a fact must propagate — no residual mentions on any reader surface.
describe("unlearning audit", () => {
  it("a deleted note leaves zero residuals", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    expect(audit(db).residuals).toEqual([]);
  });
});
