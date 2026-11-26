import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { mountOutbound, uiVersion } from "../src/rooms/relay/server";
import { createAttempt, createRun, openDatabase } from "../src/rooms/plugin-db";

describe("ui_version invalidation (B-9)", () => {
  it("an attempt change bumps the version and invalidates the watched read", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const invalidate = vi.fn();
    (bb.rpc as unknown as { experimental_invalidate?: unknown }).experimental_invalidate = invalidate;
    const db = openDatabase(bb);
    createRun(db, "run-w", "proj_1");
    mountOutbound({ db, bb, log: () => undefined, isDisposed: () => false });
    const before = uiVersion();
    createAttempt(db, { id: "a-w", runId: "run-w", taskId: "t" });
    expect(uiVersion()).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith(["ui_version"]);
    await harness.lifecycle.dispose();
  });
});
