import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { createRun, openDatabase, setRunThread } from "../src/rooms/plugin-db";
import { registeredTools, requirePmThreadRun } from "../src/rooms/platform/server";

describe("agent messages are actionable PM input", () => {
  let dispose: (() => Promise<void> | void) | undefined;
  afterEach(async () => { await dispose?.(); dispose = undefined; });

  it.each([null, "lane-pilot", "another-plugin", "owner"])("reaches the workflow handler for sender origin %s, on direct and family paths", async (originPluginId) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { initiator: originPluginId === "owner" ? "user" : "agent", senderThreadId: originPluginId === "owner" ? null : "thr_coordinator" } }]);
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, originPluginId }));
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, "run-delegation", "proj-delegation", "cli");
    setRunThread(db, "run-delegation", "thr_pm");
    const context = { threadId: "thr_pm", projectId: "proj-delegation", signal: new AbortController().signal };
    const params = { workflowId: "lp.build", inputs: {} };
    // A fragment must reach the real catalog's refusal, not be refused because another BB agent sent the task.
    const direct = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_run_workflow", params, context)));
    expect(direct).toMatchObject({ status: "refused" });
    expect(direct.reason).toContain("fragment");
    const family = JSON.parse(String(await registeredTools(bb.agents).get("lane_pilot_run_workflow")!.execute(params, context)));
    expect(family).toMatchObject({ status: "refused" });
    expect(family.reason).toContain("fragment");
  });

  it("does not turn the delegating agent itself into a PM or grant a run to an ordinary chat", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_pm" ? { role: "pm", lanePilotRunId: "run-delegation" } : { role: "writer" });
    expect(await requirePmThreadRun(bb, { threadId: "thr_pm" })).toBe("run-delegation");
    await expect(requirePmThreadRun(bb, { threadId: "thr_coordinator" })).rejects.toMatchObject({ code: "not_pm_thread" });
  });
});
