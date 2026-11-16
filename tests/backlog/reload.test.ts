import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createBacklog, mountBacklog } from "../../src/rooms/backlog/server";
import { nativeThreadKey, resetPlanningHomeChecks } from "../../src/rooms/contracts";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("backlog scanning across the 2026-11-16 reload", () => {
  // Observed log: drained at 1794820693052, startup recovery at 1794820693257,
  // then "backlog scan failed: The database connection is not open" at 1794820693365.
  it.each(["scan cadence", "PM metadata", "PM selection", "board cadence", "fetch", "board planning home", "read", "offer planning home", "issue board planning home", "issue planning home", "issue send", "scan save"])("stops without querying the closed database when disposed during %s", async (pause) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
    createRun(db, "run_cli", "P", "cli", "/repo");
    setRunThread(db, "run_cli", "thr_pm");
    resetPlanningHomeChecks();
    if (pause.includes("planning home")) saveProjectSetting(db, "P", "project.planning_home", "/plans");
    if (pause.startsWith("issue")) saveProjectSetting(db, "P", "backlog.auto_issue", "on");
    let disposed = false;
    bb.onDispose(() => { disposed = true; });
    const reading = deferred();
    const pending = deferred();
    const waitAt = async (point: string) => {
      if (pause !== point) return;
      reading.resolve();
      await pending.promise;
    };
    const get = bb.storage.kv.get.bind(bb.storage.kv);
    let cadenceReads = 0;
    const kvGet = vi.spyOn(bb.storage.kv, "get").mockImplementation(async (key) => {
      if (key === "backlog:last-scan:P") {
        await waitAt(++cadenceReads === 1 ? "scan cadence" : "board cadence");
        return Date.now() - 86_400_000;
      }
      if (key === nativeThreadKey("thr_pm")) await waitAt("PM selection");
      return get(key);
    });
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    const kvSet = vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === "backlog:last-scan:P") await waitAt("scan save");
      return set(key, value);
    });
    harness.sdk.stub("threads.getPluginMetadata", async () => {
      await waitAt("PM metadata");
      return { role: "pm" };
    });
    harness.sdk.stub("threads.send", async () => { await waitAt("issue send"); });
    let planningReads = 0;
    const call = vi.fn(async (method: string, input: { command: string }) => {
      if (method === "runCommand") {
        await waitAt(["board planning home", "offer planning home", "issue board planning home", "issue planning home"][planningReads++]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const fetching = input.command.startsWith("git fetch");
      await waitAt(fetching ? "fetch" : "read");
      // Recheck the configured home at each later read, including the automatic issue path.
      resetPlanningHomeChecks();
      return { exitCode: 0, stdout: fetching ? "0" : "__lp_todo__ .agents/todos/items/t-01/meta.yaml\nid: t-01\ntitle: Item t-01\nstatus: ready\nestimate: 3\n", stderr: "" };
    });
    const logs: string[] = [];
    const ctx = { db, bb, host: { call }, log: (line: string) => logs.push(line), isDisposed: () => disposed };
    const api = createBacklog(ctx as never).backlog;
    mountBacklog(ctx as never, api);
    const running = harness.runSchedule("backlog-scan");
    try {
      await reading.promise;
      await harness.dispose();
      expect(db.open).toBe(false);
      const prepare = vi.spyOn(db, "prepare");
      const callsBeforeResume = call.mock.calls.length;
      const kvReadsBeforeResume = kvGet.mock.calls.length;
      const kvWritesBeforeResume = kvSet.mock.calls.length;
      const sdkCallsBeforeResume = harness.sdk.calls.length;
      const logsBeforeResume = [...logs];
      try {
        pending.resolve();
        await running;
        expect.soft(prepare).not.toHaveBeenCalled();
        expect(call).toHaveBeenCalledTimes(callsBeforeResume);
        expect(kvGet).toHaveBeenCalledTimes(kvReadsBeforeResume);
        expect(kvSet).toHaveBeenCalledTimes(kvWritesBeforeResume);
        expect(harness.sdk.calls).toHaveLength(sdkCallsBeforeResume);
        expect(logs).toEqual(logsBeforeResume);
      } finally { prepare.mockRestore(); }
    } finally {
      pending.resolve();
      await running;
      vi.restoreAllMocks();
      resetPlanningHomeChecks();
      await harness.dispose();
    }
  });

  it("still reports a real database failure while the instance is live", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const logs: string[] = [];
    const ctx = { db, bb, log: (line: string) => logs.push(line), isDisposed: () => false };
    mountBacklog(ctx as never, createBacklog(ctx as never).backlog);
    try {
      db.close();
      await harness.runSchedule("backlog-scan");
      expect(logs).toEqual(["backlog scan failed: The database connection is not open"]);
    } finally { await harness.dispose(); }
  });
});
