import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("docs schedules", () => {
  // BB awaits plugin schedules one by one: a docs pass held inside one stopped self-repair for 50 min on the hub.
  it("return while the docs pass still runs, so the other schedules keep their turn", async () => {
    let listed = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ projects:{ list:() => { listed++; return new Promise(() => {}); } } } as never,
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const settled = (name: string) => Promise.race([harness.runSchedule(name).then(() => "returned"), new Promise((done) => setTimeout(() => done("held"), 200))]);
    expect(await settled("docs-nightly-hourly")).toBe("returned");
    expect(await settled("docs-nightly-hourly")).toBe("returned");
    // The second tick found the first pass still running and did not start another.
    expect(listed).toBe(1);
  });
});
