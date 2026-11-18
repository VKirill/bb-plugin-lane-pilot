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

  it("stops the public items read when disposed during the planning-home check", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
    saveProjectSetting(db, "P", "project.planning_home", "/plans");
    resetPlanningHomeChecks();
    let disposed = false;
    bb.onDispose(() => { disposed = true; });
    const reading = deferred();
    const pending = deferred();
    const call = vi.fn(async (method: string) => {
      if (method === "runCommand") { reading.resolve(); await pending.promise; }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const api = createBacklog({ db, bb, host: { call }, isDisposed: () => disposed } as never).backlog;
    const running = api.items("P").then((items) => ({ items }), (error: unknown) => ({ error }));
    try {
      await reading.promise;
      await harness.dispose();
      expect(db.open).toBe(false);
      const prepare = vi.spyOn(db, "prepare");
      try {
        pending.resolve();
        const result = await running;
        expect.soft(call).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ error: expect.objectContaining({ message: "backlog stopped: plugin disposed" }) });
        await expect(api.items("P")).rejects.toThrow("backlog stopped: plugin disposed");
        expect(prepare).not.toHaveBeenCalled();
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

  it("overrides stale /tmp/ag194-v4-cli PrototypeConfig with canonical project.sources in items() and board() (P00.05)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId: "proj_ejbam66722",
      hostId: "host_mac",
      pmWorkspacePath: "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-190/tmp/pm-workspace",
      writerWorkspacePath: "/tmp/ag194-v4-cli",
      pmProviderId: "claude-code",
      pmModel: "claude-sonnet-4-6",
      writerProviderId: "claude-code",
      writerModel: "claude-sonnet-4-6",
    });
    harness.sdk.stub("projects.get" as never, async () => ({
      id: "proj_ejbam66722",
      name: "BB-сервис",
      sources: [
        { id: "src_canon", hostId: "host_mac", path: "/Users/vechkasov/Documents/BB-сервис", isDefault: true },
        { id: "src_ovh", hostId: "host_ovh", path: "/home/ubuntu/BB-service", isDefault: false },
      ],
    }));
    const seenPaths: string[] = [];
    const host = {
      call: async (_method: string, params: { basePath?: string; cwd?: string }) => {
        seenPaths.push(params.basePath ?? params.cwd ?? "");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const api = createBacklog({ db, bb, host, log: () => undefined, isDisposed: () => false } as never).backlog;
    try {
      await api.items("proj_ejbam66722");
      await api.board("proj_ejbam66722");
      expect(seenPaths.length).toBeGreaterThanOrEqual(3);
      expect(seenPaths.every((p) => p === "/Users/vechkasov/Documents/BB-сервис")).toBe(true);
      expect(seenPaths).not.toContain("/tmp/ag194-v4-cli");
    } finally {
      resetPlanningHomeChecks();
      await harness.dispose();
    }
  });
});
