import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";

/**
 * 0.1.573: lp.clarify shipped `startedBy:"pm"` — a starter no code path provides, so every start
 * boundary refused it forever (m_sg_clarify was engine-test green but unreachable live). With the
 * field gone it is an ordinary published graph: the real `workflow_run` RPC starts it, the analyst
 * answers with task-named questions, and the internal/pipeline graphs stay refused.
 */
const projectId = "proj_clarify";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const CLARIFY_ANSWER = `Read the task tree.\n\n\`\`\`json\n${JSON.stringify({
  questions: [
    { task: "reports", question: "Which export format should the report use?" },
    { task: "billing", question: "Which invoice series pays for the export?" },
  ],
  handoff: "two questions proposed",
})}\n\`\`\``;

async function setup() {
  const spawned: Array<Record<string, any>> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: { requestedHostId: string; cwd: string } }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host call ${call.method}`);
    }) as never,
    sdk: {
      hosts: { list: async () => [{ id: "local-host", name: "Local", status: "connected" }] },
      plugins: { list: async () => [], callRpc: async () => { throw new Error("no catalog"); } },
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === "thr_pm" ? { role: "pm", lanePilotRunId: "lprun_a" } : {},
        list: async () => [],
        updatePluginMetadata: async () => ({}),
        queue: { list: async () => [] },
        spawn: async (args: Record<string, any>) => { spawned.push(args); return { id: `thr_agent_${spawned.length}` }; },
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId, environmentId: "env-pm", sectionId: "sec_1", sourceThreadId: "thr_pm", lifecycleOwnerThreadId: "thr_pm" }),
        events: { list: async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        output: async () => ({ output: CLARIFY_ANSWER }),
        context: async () => ({ usage: null }),
        stop: async () => ({}),
        send: async () => ({}),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local-host", path: process.cwd(), status: "ready" }) },
      projects: { get: async () => ({ id: projectId, name: "Site", sources: [{ hostId: "local-host", path: process.cwd() }] }) },
    } as never,
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  createRun(db, "lprun_a", projectId, "cli");
  setRunThread(db, "lprun_a", "thr_pm");
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  return { rpc, spawned };
}

describe("starter graphs at the workflow_run boundary", () => {
  it("lp.clarify starts for real and returns task-named questions", async () => {
    const { rpc, spawned } = await setup();
    const started = await rpc("workflow_run", { id: "lp.clarify", projectId, inputs: { goal: "export the monthly reports" }, source: "manual" });
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, created: true, runId: expect.stringMatching(/^wfrun_/) });

    let snap: Record<string, any> | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      snap = (await rpc("workflow_run_snapshot", { runId: started.runId })).snapshot;
      if (snap?.run.status === "succeeded" || snap?.run.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(snap?.run.status).toBe("succeeded");
    expect(snap!.run.output).toMatchObject({
      questions: [
        { task: "reports", question: expect.any(String) },
        { task: "billing", question: expect.any(String) },
      ],
    });
    // The analyst ran as a real helper thread of the run, not a stub.
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0]).toMatchObject({ pluginMetadata: expect.objectContaining({ lanePilotWorkflowNode: "analyst" }) });
  });

  it("internal and pipeline graphs stay refused at the same boundary", async () => {
    const { rpc } = await setup();
    for (const id of ["lp.plan", "lp.build", "lp-task-pipeline", "lp.worktree-cleanup"]) {
      const result = await rpc("workflow_run", { id, projectId, inputs: { goal: "x" }, source: "manual" });
      expect(result, id).toMatchObject({ ok: false, reason: "not_runnable" });
    }
  });
});
