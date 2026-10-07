import { describe, expect, it } from "vitest";
import { createTasksMirror, tasksMirrorEnabled, type MirrorTask } from "../../src/server/tasks-mirror";

const task: MirrorTask = { projectId: "proj_1", runId: "run-1", taskId: "T1", title: "Write a page", objective: "Make it", acceptance: ["It exists"] };

function setup(options: { enabled?: boolean; plugin?: boolean; linked?: boolean; failOn?: string } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const kv = new Map<string, unknown>();
  const logs: string[] = [];
  const bb = {
    sdk: options.plugin === false ? {} : { plugins: { callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input?: unknown }) => {
      expect(pluginId).toBe("tasks");
      calls.push({ method, input: (input ?? {}) as Record<string, unknown> });
      if (method === options.failOn) throw new Error(`${method} rejected`);
      if (method === "listProjects") return { projects: options.linked === false ? [] : [{ id: "TRK", linkedBbProjectId: "proj_1" }, { id: "OTHER", linkedBbProjectId: null }] };
      return { ok: true, task: { id: "BBT1", key: "LP-1" } };
    } } },
    storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } },
    log: { info: (line: string) => logs.push(line) },
  } as never;
  const mirror = createTasksMirror(bb, async () => ({ "tasks.mirror": options.enabled ?? true }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { mirror, calls, kv, logs, settle };
}

describe("tasksMirrorEnabled", () => {
  // On by default (owner: no switches to flip); a project with no linked Tasks project mirrors nothing anyway.
  it("is on unless the project turns it off", () => {
    expect(tasksMirrorEnabled({})).toBe(true);
    expect(tasksMirrorEnabled({ "tasks.mirror": false })).toBe(false);
    expect(tasksMirrorEnabled({ "tasks.mirror": "false" })).toBe(false);
    expect(tasksMirrorEnabled({ "tasks.mirror": true })).toBe(true);
    expect(tasksMirrorEnabled({ "tasks.mirror": "true" })).toBe(true);
  });
});

describe("BB Tasks mirror", () => {
  it("creates the task in the linked project once, then updates its status, attaches the thread and comments without notifying", async () => {
    const { mirror, calls, settle } = setup();
    const handle = mirror.open(task);
    handle.running("Started");
    handle.thread("thr_abc", "Writer started");
    handle.finish("accepted", "Accepted.");
    await settle();
    expect(calls.map((call) => call.method)).toEqual(["listProjects", "createTask", "updateTask", "createComment", "taskThreadsAttach", "createComment", "updateTask", "createComment"]);
    expect(calls[1]!.input).toMatchObject({ projectId: "TRK", title: "Write a page", status: "todo", description: expect.stringContaining("`T1` (run run-1)") });
    expect(calls.filter((call) => call.method === "updateTask").map((call) => call.input.status)).toEqual(["in_progress", "done"]);
    expect(calls.filter((call) => call.method === "createComment").every((call) => call.input.notify === false)).toBe(true);
    expect(calls.find((call) => call.method === "taskThreadsAttach")!.input).toEqual({ taskId: "BBT1", threadId: "thr_abc" });
  });

  it("maps blocked to in_review and canceled to canceled", async () => {
    const blocked = setup();
    blocked.mirror.open(task).finish("blocked", "Not accepted: x");
    const canceled = setup();
    canceled.mirror.open(task).finish("canceled", "Canceled.");
    await blocked.settle();
    await canceled.settle();
    expect(blocked.calls.find((call) => call.method === "updateTask")!.input.status).toBe("in_review");
    expect(canceled.calls.find((call) => call.method === "updateTask")!.input.status).toBe("canceled");
  });

  it("takes the stored mapping after a reload instead of creating the task again", async () => {
    const first = setup();
    first.mirror.open(task).running();
    await first.settle();
    const second = setup();
    first.kv.forEach((value, key) => second.kv.set(key, value));
    second.mirror.open(task).finish("accepted", "Accepted.");
    await second.settle();
    expect(second.calls.map((call) => call.method)).toEqual(["updateTask", "createComment"]);
  });

  it("does nothing when the project has it off, the plugin is absent or no tracker project is linked", async () => {
    for (const options of [{ enabled: false }, { plugin: false }, { linked: false }]) {
      const { mirror, calls, settle } = setup(options);
      const handle = mirror.open(task);
      handle.running();
      handle.thread("thr_1");
      handle.finish("accepted", "ok");
      await settle();
      expect(calls.filter((call) => call.method !== "listProjects"), JSON.stringify(options)).toEqual([]);
    }
  });

  it("drops a rejected call quietly and goes on with the next one", async () => {
    const { mirror, calls, logs, settle } = setup({ failOn: "taskThreadsAttach" });
    const handle = mirror.open(task);
    handle.thread("thr_1");
    handle.finish("accepted", "ok");
    await settle();
    expect(calls.map((call) => call.method)).toContain("updateTask");
    expect(logs.join("\n")).toContain("taskThreadsAttach rejected");
  });
});
