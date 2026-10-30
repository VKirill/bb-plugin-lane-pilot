import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { benchPipeline } from "../../src/rooms/bench/server/plugin-ports";
import { openDatabase, loadPrototypeConfig, savePrototypeConfig } from "../../src/rooms/storage/database";
import { DEFAULT_BENCH_WRITER } from "../../src/rooms/bench/runner";
import type { BenchProjectRef } from "../../src/rooms/bench/ports";

const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench repo", hostId: "local", path: "/tmp/lp-bench" };

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  // configure/startRun do not touch `services`; the rest of the pipeline is exercised in runner tests.
  return { bb, db, pipeline: benchPipeline({ bb, db, host: {} } as never, {} as never) };
}

describe("bench PM pair", () => {
  it("configure rewires a stale codex PM pair to the arm's writer pair", async () => {
    const { db, pipeline } = world();
    // The shape the 2026-10-29/30 nights hit: a prototype config written before the compiled
    // main agent's claude-code-only rule, still pointing the PM at codex.
    savePrototypeConfig(db, { projectId: project.projectId, hostId: "local", pmWorkspacePath: "/old", writerWorkspacePath: "/old",
      pmProviderId: "codex", pmModel: "gpt-6-luna", writerProviderId: "codex", writerModel: "gpt-6-luna" });
    await pipeline.configure(project, { settings: { "writer.provider": "claude-code", "writer.model": "claude-haiku-5-5" }, harness: "none", sourceProjectId: null });
    const config = loadPrototypeConfig(db, project.projectId);
    expect(config).toMatchObject({ pmProviderId: "claude-code", pmModel: "claude-haiku-5-5", hostId: "local", pmWorkspacePath: "/old" });
  });

  it("configure writes the arm's pair when no prototype config exists", async () => {
    const { db, pipeline } = world();
    await pipeline.configure(project, { settings: { "writer.provider": "codex", "writer.model": "gpt-6-luna" }, harness: "none", sourceProjectId: null });
    expect(loadPrototypeConfig(db, project.projectId)).toMatchObject({ pmProviderId: "codex", pmModel: "gpt-6-luna", pmWorkspacePath: project.path });
  });

  it("configure falls back to the default bench writer when the arm names none", async () => {
    const { db, pipeline } = world();
    savePrototypeConfig(db, { projectId: project.projectId, hostId: "local", pmWorkspacePath: "/old", writerWorkspacePath: "/old",
      pmProviderId: "codex", pmModel: "gpt-6-luna", writerProviderId: "codex", writerModel: "gpt-6-luna" });
    await pipeline.configure(project, { settings: {}, harness: "none", sourceProjectId: null });
    expect(loadPrototypeConfig(db, project.projectId)).toMatchObject({ pmProviderId: DEFAULT_BENCH_WRITER.providerId, pmModel: DEFAULT_BENCH_WRITER.model });
  });
});
