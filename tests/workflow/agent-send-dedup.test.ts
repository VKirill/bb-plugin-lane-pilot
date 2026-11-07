import { describe, expect, it, vi } from "vitest";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";

// The send-dedup record lives in the plugin store: a read that fails must surface, not read as "never sent".
vi.mock("../../src/rooms/platform/server", async (original) => ({
  ...(await original<typeof import("../../src/rooms/platform/server")>()),
  fullAccessSpawn: vi.fn(async () => { throw new Error("SPAWNED"); }),
  findThreadsByMetadata: vi.fn(async () => null),
  projectFolder: vi.fn(async () => ({ hostId: "h", path: "/w" })),
}));
vi.mock("../../src/rooms/runs/server", async (original) => ({
  ...(await original<typeof import("../../src/rooms/runs/server")>()),
  requireHelperSpawn: () => ({ mode: "optional", policy: null }),
  helperChildPlacement: async () => ({ projectId: "p" }),
  requiredPolicyField: () => ({}),
}));

describe("the workflow helper's send record", () => {
  it("a plugin-store read failure surfaces instead of sending the step a second time", async () => {
    const rt = {
      pmThreadId: "pm", projectId: "p", runId: "run1",
      ctx: {
        db: { prepare: () => ({ get: () => undefined }) }, host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, log: () => undefined, isDisposed: () => false,
        effectiveProjectSettings: async () => ({ values: {} }), ownedAgents: async () => ({}),
        bb: {
          storage: { kv: { get: async () => { throw new Error("store down"); }, set: async () => undefined } },
          sdk: { threads: { get: async () => ({ id: "pm", status: "idle", environmentId: "env" }), defaultExecutionOptions: async () => ({}) }, environments: { get: async () => ({ path: "/w", hostId: "h" }) }, hosts: { list: async () => [] } },
        },
      },
      services: {},
    };
    await expect(createWorkflowAgents().run({
      rt, workflowRunId: "wf1", stepKey: "s", nodeId: "n", spawnKey: "k", title: "t", prompt: "x", fields: [],
      role: "analyst", intoThread: "thr", resolved: true,
    } as never)).rejects.toThrow("store down");
  });
});
