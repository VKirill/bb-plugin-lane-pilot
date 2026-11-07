import { expect, it } from "vitest";
import { pickerRouting } from "../src/rooms/ui-shell/ui/native-model-picker";
import type { ModelCatalog } from "@lane-pilot/models";

// 2026-10-31: the role picker asked the MacBook for Devin's models — Devin is not signed in there and lists one placeholder
// («Agent default») — and the owner could not pick SWE-2, which the Mac mini and OVH list.
const model = (id: string, hostIds: string[]) => ({ id, model: id, displayName: id, efforts: ["medium"], defaultEffort: "medium", isDefault: false, hostIds });
const catalog: ModelCatalog = {
  hosts: [{ id: "macbook", name: "MacBook", connected: true }, { id: "mini", name: "MAC Mini", connected: true }, { id: "ovh", name: "OVH", connected: true }],
  providers: [{ id: "devin", displayName: "Devin", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["macbook", "mini", "ovh"],
    models: [model("acp-default", ["macbook"]), model("swe-2-high", ["mini", "ovh"]), model("adaptive", ["mini", "ovh"])] }],
} as never;

it("asks the machine where the provider lists the most models, even when the saved model is the placeholder of another", () => {
  expect(pickerRouting(catalog, "devin")).toEqual({ kind: "host", hostId: "mini" });
  expect(pickerRouting(catalog, "devin", "acp-default")).toEqual({ kind: "host", hostId: "mini" });
  expect(pickerRouting({ ...catalog, runHostId: "ovh" } as never, "devin", "acp-default")).toEqual({ kind: "host", hostId: "ovh" });
});
