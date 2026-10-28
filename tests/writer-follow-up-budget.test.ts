import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunBudget } from "@lane-pilot/resilience";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import { saveFollowUp } from "../src/rooms/writer/server/sticky";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";

// The follow-up wait ends with the thread's interruption only after the budget stop has stopped the thread.
let rejectWait: ((cause: Error) => void) | null = null;
vi.mock("@lane-pilot/thread-observe", async (actual) => ({
  ...(await actual<typeof import("@lane-pilot/thread-observe")>()),
  waitThreadIdle: () => new Promise((_resolve, reject) => { rejectWait = reject; }),
}));

const config: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo",
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};
const task: TaskV2 = {
  schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer",
  project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [],
  objective: "write", acceptance: ["file exists"], verify: "none", verification: [],
};

describe("budget stop during a follow-up wait", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (cause: unknown) => { unhandled.push(cause); };
  afterEach(() => { process.off("unhandledRejection", onUnhandled); rejectWait = null; });

  it("blocks the attempt and leaves no unhandled rejection when the stopped thread's wait fails afterwards", async () => {
    process.on("unhandledRejection", onUnhandled);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
    await saveFollowUp(bb.storage.kv as never, "a1", Date.now());
    const ctx = {
      state: { disposed: false },
      bb: {
        storage: bb.storage,
        log: { warn() {}, error() {}, info() {} },
        sdk: {
          threads: {
            stop: async () => { setTimeout(() => rejectWait?.(new Error("writer_follow_up:error:thread_interrupted:manual-stop")), 0); },
            events: { list: async () => [] },
            get: async () => ({ id: "writer-1", status: "active" }),
          },
        },
      },
      db,
      getThreadBounded: async () => ({ status: "active" }),
      host: { call: async () => ({}) },
    };
    const finish = createWriterFinish(ctx as never, {
      runBudgetFor: () => createRunBudget({ maxWallMs: 10 }, 0),
      validateWriterResult: async () => ({ status: "accepted" }),
    } as never);
    const result = await finish.finishWriterAttempt({
      projectId: "P", config, task, runId: "run", taskId: "t1", attemptId: "a1",
      pmThreadId: "pm", writerThreadId: "writer-1", dirtBefore: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result).toMatchObject({ status: "blocked", reason: "run_budget_exceeded:wall-clock ms" });
    expect(getAttempt(db, "a1")).toMatchObject({ state: "blocked" });
    expect(unhandled).toEqual([]);
  });
});
