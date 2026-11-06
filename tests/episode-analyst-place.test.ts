import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/storage/database";
import { analystPlace } from "../src/rooms/night-graphs/server";

function db() {
  const host = createFakePluginHost({ pluginId: "lane-pilot" } as never);
  const database = openDatabase(host.bb as never);
  const add = (runId: string, projectId: string | null, state: string, at: number) => database.prepare(`INSERT INTO lane_pilot_errand_episode
    (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, enriched_at, created_at, updated_at)
    VALUES (?, 1, ?, 'errand', 'completed', 'done', ?, ?, ?, ?)`).run(runId, projectId, state, at, at, at);
  return { database, add };
}

describe("the episode analyst's machine", () => {
  it("a project with no writer host borrows the host of the project analyzed last (proj_personal, 2026-11-06)", async () => {
    const { database, add } = db();
    add("r1", "proj_old", "enriched", 1_000);
    add("r2", "proj_mini", "enriched", 2_000);
    add("r3", "proj_personal", "pending", 3_000);
    const hosts: Record<string, unknown> = { proj_old: { status: "resolved", hostId: "ovh", path: "/o" }, proj_mini: { status: "resolved", hostId: "mini", path: "/m" } };
    const resolve = async (id: string | undefined) => (id && hosts[id]) ?? { status: "missing_host" };
    expect(await analystPlace(database as never, "proj_personal", resolve)).toMatchObject({ hostId: "mini" });
    expect(await analystPlace(database as never, "proj_old", resolve)).toMatchObject({ hostId: "ovh" });
  });

  it("with no analyzed project anywhere the own answer comes back, so the sweep reports no host", async () => {
    const { database } = db();
    expect(await analystPlace(database as never, "proj_personal", async () => ({ status: "missing_host" }))).toEqual({ status: "missing_host" });
  });
});
