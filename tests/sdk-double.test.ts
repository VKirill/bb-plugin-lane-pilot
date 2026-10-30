import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shapeOf, twinDiffers } from "../src/rooms/twins";
import { sdkDouble, type DoubleEnvironment, type DoubleThread } from "./fixtures/sdk-double";

const record = (name: string) => (JSON.parse(readFileSync(join(__dirname, "fixtures/real-shapes", `${name}.json`), "utf8")) as { shape: unknown }).shape;

describe("the BB SDK double (SMA Q13)", () => {
  it("threads.get and environments.get answer in the recorded real shape — no invented key, no other type", async () => {
    const { bb } = sdkDouble({
      threads: [{ id: "thr_a", projectId: "proj_x", status: "idle", createdAt: 1 }],
      environments: [{ id: "env_a", projectId: "proj_x", hostId: "host_a", path: "/w" }],
    });
    expect(twinDiffers(shapeOf(await bb.sdk.threads.get({ threadId: "thr_a" })), record("threads.get") as never)).toEqual([]);
    expect(twinDiffers(shapeOf(await bb.sdk.environments.get({ environmentId: "env_a" })), record("environments.get") as never)).toEqual([]);
  });

  it("a seeded row that invents a key the real answer does not have is caught", async () => {
    const { bb } = sdkDouble({ threads: [{ id: "thr_a", colour: "red" } as unknown as DoubleThread] });
    expect(twinDiffers(shapeOf(await bb.sdk.threads.get({ threadId: "thr_a" })), record("threads.get") as never)).toEqual(["$.colour: the real thing has no such key"]);
    const env = sdkDouble({ environments: [{ id: "env_a", flavour: "green" } as unknown as DoubleEnvironment] });
    expect(twinDiffers(shapeOf(await env.bb.sdk.environments.get({ environmentId: "env_a" })), record("environments.get") as never)).toEqual(["$.flavour: the real thing has no such key"]);
  });

  it("threads and storage behave: send appends, metadata merges, kv round-trips, calls are recorded", async () => {
    const { bb, outbox, kv, calls } = sdkDouble({ threads: [{ id: "thr_a", pluginMetadata: { role: "pm" } }] });
    await bb.sdk.threads.send({ threadId: "thr_a", message: "hi" });
    expect(outbox.get("thr_a")).toHaveLength(1);
    await bb.sdk.threads.updatePluginMetadata({ threadId: "thr_a", set: { lane: "x" } });
    expect(await bb.sdk.threads.getPluginMetadata({ threadId: "thr_a" })).toEqual({ role: "pm", lane: "x" });
    await bb.storage.kv.set("k", { n: 1 });
    expect(await bb.storage.kv.get("k")).toEqual({ n: 1 });
    expect(await bb.storage.kv.list()).toEqual(["k"]);
    await expect(bb.sdk.threads.send({ threadId: "thr_missing", message: "x" })).rejects.toThrow(/no such thread/);
    expect(kv.get("k")).toEqual({ n: 1 });
    expect(calls.map((row) => row.path)).toContain("threads.send");
  });
});
