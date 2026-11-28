import { describe, expect, it } from "vitest";
import { buildCharterPayload, parseCharterForm } from "../src/rooms/specialist/ui/charter-editor-model";

// The intake graph writes `arsenal` (allowed channels and graphs); specialists read the charter as written, so a save must not flatten it.
const body = {
  north_star: { metric_id: "leads", target: 600 },
  channels: ["telegram"],
  arsenal: { allowed_channels: ["yandex_direct"], allowed_graphs: ["mkt.landing-cro", "mkt.ab-test"] },
};

describe("charter editor channels", () => {
  it("keeps channels and arsenal untouched when the owner did not change the list", () => {
    const next = buildCharterPayload(body, { ...parseCharterForm(body), metric: "leads" });
    expect(next.channels).toEqual(["telegram"]);
    expect(next.arsenal).toEqual(body.arsenal);
  });

  it("drops a removed entry where it lived and adds a new one to channels", () => {
    const form = parseCharterForm(body);
    expect(form.channels.split(", ")).toEqual(["telegram", "yandex_direct", "mkt.landing-cro", "mkt.ab-test"]);
    const next = buildCharterPayload(body, { ...form, channels: "telegram, yandex_direct, mkt.landing-cro, vk" });
    expect(next.arsenal).toEqual({ allowed_channels: ["yandex_direct"], allowed_graphs: ["mkt.landing-cro"] });
    expect(next.channels).toEqual(["telegram", "vk"]);
  });
});
