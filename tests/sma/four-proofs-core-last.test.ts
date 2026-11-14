// SMA map, the last bb-core batch (core-last): n1499 is proved on Lane Pilot's own half. Its card («Skills .claude/skills/sma-*:
// sixteen thin wrappers over workflows») is the store of per-workflow entries an agent sees. Lane Pilot writes no wrapper skill:
// the PM's lane_pilot_route tool names every ready shipped graph by id in its instructions (the visible registry), and
// lane_pilot_run_workflow starts one of them. The other three nodes of the batch (n469, n470, n1514) are bb-core's.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { builtinWorkflows } from "../../src/rooms/workflow/builtin";

const READY = /Ready graphs shipped with Lane Pilot: ([^;]*);/;

describe("core-last: the per-workflow entries an agent sees", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  it("[sma:k_st_skills] the route tool names exactly the ready shipped graphs by id, never a fragment or a pipeline", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const route = harness.registrations.agentTools.find((tool) => tool.name === "lane_pilot_route") as unknown as { instructions: string } | undefined;
    const listed = READY.exec(route?.instructions ?? "")?.[1]?.split(", ") ?? [];

    // What the card's wrappers point at: every shipped graph a person may start (published, or tested for a first live run).
    const all = builtinWorkflows();
    const ready = all.filter((w) => (w.status === "published" || w.status === "tested") && !w.internal && !w.startedBy).map((w) => w.id);
    const hidden = all.filter((w) => w.internal || w.startedBy).map((w) => w.id);
    expect(ready.length).toBeGreaterThan(10);
    expect(hidden.length).toBeGreaterThan(0);
    expect(listed).toEqual(ready);
    expect(listed.filter((id) => hidden.includes(id))).toEqual([]);
  });
});
