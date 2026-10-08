import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";

const projectId = "resilience-project";
const pmThreadId = "resilience-pm";
const runId = "resilience-run";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("resilience wiring", () => {
  it("stores a run budget through the CLI and reports breaker and budget state to the PM", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);

    const set = await harness.behavior.runCli(["budget", projectId, "run.max_attempts=3", "run.max_wall_minutes=90"]);
    expect(JSON.parse(String(set.stdout)).budget).toEqual({ "run.max_attempts": "3", "run.max_wall_minutes": "90", "run.max_tokens": "", "run.max_children": "" });
    await expect(harness.behavior.runCli(["budget", projectId, "run.max_tokens=lots"])).resolves.toMatchObject({ exitCode: 1 });

    const health = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_run_health", { runId }, { threadId: pmThreadId, projectId })));
    expect(health).toEqual({ runId, budget: null, providers: [] });
    const refused = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_run_health", { runId }, { threadId: "other", projectId })));
    expect(refused).toMatchObject({ ok: false, error: { code: "not_found", retryable: false, sideEffects: "none" } });
    expect(refused.error.message).toMatch(/does not belong/);

    const cli = JSON.parse(String((await harness.behavior.runCli(["health"])).stdout));
    expect(cli).toEqual({ providers: [], runs: [] });
  });
});
