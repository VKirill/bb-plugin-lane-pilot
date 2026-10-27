import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { runGraphHelper } from "../../src/rooms/workflow/server/graph-helper";

/** A helper thread that runs until the test lets it end, and a step journal two plugin instances share. */
function world() {
  const state = { spawned: 0, stopped: [] as string[], running: true };
  const sdk = {
    providers: { list: async () => [], models: async () => ({ models: [] }) },
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: state.running ? "running" : "idle", projectId: "proj-1" }),
      spawn: async () => { state.spawned += 1; return { id: `helper-${state.spawned}` }; },
      stop: async ({ threadId }: { threadId: string }) => { state.stopped.push(threadId); },
      archive: async () => ({}),
      output: async () => ({ output: "the answer" }),
      events: { list: async ({ threadId }: { threadId: string }) => state.running
        ? [{ type: "turn/started", threadId, seq: 1 }]
        : [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
    },
  } as never;
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk });
  const journal = new Map<string, unknown>();
  /** One plugin instance: its own disposed flag and step abort, the journal of the run it shares. */
  const instance = () => {
    const flags = { disposed: false };
    const abort = new AbortController();
    const c = {
      runId: "wfrun_1", stepKey: "step", nodeId: "n", spawnKey: "spawn-1", signal: abort.signal,
      effect: async (key: string, _kind: string, run: () => Promise<unknown>) => { if (!journal.has(key)) journal.set(key, await run()); return journal.get(key); },
    } as never;
    const ctx = { bb, isDisposed: () => flags.disposed } as never;
    const run = () => runGraphHelper(ctx, c, { key: "k", label: "helper", projectId: "proj-1", archive: true, spawn: async () => (await (bb.sdk as any).threads.spawn()).id });
    return { flags, abort, run };
  };
  return { state, instance };
}

describe("a graph helper thread and a plugin reload (RECHECK-341 F2)", () => {
  it("a reload holds the step and leaves the thread running; the next instance finds the same thread and reads its answer", async () => {
    const { state, instance } = world();
    const first = instance();
    const failure = first.run().then(() => null, (cause: Error) => cause);
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.flags.disposed = true;
    expect((await failure)?.message).toMatch(/plugin_stopped/);
    expect(state.stopped).toEqual([]);
    expect(state.spawned).toBe(1);

    const second = instance();
    const again = second.run();
    state.running = false;
    expect(await again).toMatchObject({ threadId: "helper-1", text: "the answer" });
    expect(state.spawned).toBe(1);
    expect(state.stopped).toEqual([]);
  });

  it("an owner's cancel still stops the thread", async () => {
    const { state, instance } = world();
    const only = instance();
    const failure = only.run().then(() => null, (cause: Error) => cause);
    await new Promise((resolve) => setTimeout(resolve, 50));
    only.abort.abort();
    expect((await failure)?.message).toMatch(/aborted/);
    expect(state.stopped).toEqual(["helper-1"]);
  });
});
