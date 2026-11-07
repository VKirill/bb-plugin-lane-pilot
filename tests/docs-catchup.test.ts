import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createDocsNightly } from "../src/rooms/docs/server/docs-nightly";
import { openDatabase } from "../src/rooms/plugin-db";

// docs-nightly catch-up: one unreadable unit record must not keep the next unit (or pass) from being settled.
describe("docs catch-up per-key isolation", () => {
  it("skips a unit whose record read throws and still settles the next one", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const works = new Map<string, () => Promise<void>>();
    (bb.background as unknown as { schedule: (name: string, cron: string, fn: () => Promise<void>) => void }).schedule = (name, _cron, fn) => { works.set(name, fn); };
    createDocsNightly(createCore(bb, db), {} as never);
    const kv = bb.storage.kv as never as { get: (key: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> };
    await kv.set("docs-units-open", { "unit-bad": true, "unit-gone": true });
    const realGet = kv.get.bind(kv);
    kv.get = async (key: string) => { if (key === "unit-bad") throw new Error("corrupt unit"); return realGet(key); };
    await works.get("docs-nightly-catchup")!();
    await vi.waitFor(async () => {
      expect(await kv.get("docs-units-open")).toEqual({ "unit-bad": true });
    });
    await harness.lifecycle.dispose();
  });
});
