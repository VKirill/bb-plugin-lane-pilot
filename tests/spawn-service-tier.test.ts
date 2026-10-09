import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fullAccessSpawn, providerSupportsServiceTier } from "../src/rooms/core/server/pm-spawn";
import { mountErrands } from "../src/rooms/qa/server/errands";
import { runQaThread } from "../src/rooms/qa/server/qa-thread";
import { createRun, openDatabase } from "../src/rooms/storage/database";

vi.mock("@lane-pilot/thread-observe", () => ({ observeStageChild: async () => ({ kind: "completed" }) }));

describe("spawn service tier", () => {
  describe("providerSupportsServiceTier", () => {
    it("returns true when provider has capabilities.supportsServiceTier: true", () => {
      expect(providerSupportsServiceTier({ capabilities: { supportsServiceTier: true } })).toBe(true);
      expect(providerSupportsServiceTier({ capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] })).toBe(true);
    });

    it("returns true when provider has top-level supportsServiceTier: true or non-empty serviceTiers", () => {
      expect(providerSupportsServiceTier({ supportsServiceTier: true })).toBe(true);
      expect(providerSupportsServiceTier({ serviceTiers: [{ id: "default" }] })).toBe(true);
      expect(providerSupportsServiceTier({ serviceTiers: ["fast"] })).toBe(true);
    });

    it("returns false when provider has supportsServiceTier: false or empty serviceTiers", () => {
      expect(providerSupportsServiceTier({ capabilities: { supportsServiceTier: false }, serviceTiers: [] })).toBe(false);
      expect(providerSupportsServiceTier({ capabilities: { supportsServiceTier: false } })).toBe(false);
      expect(providerSupportsServiceTier({ supportsServiceTier: false })).toBe(false);
      expect(providerSupportsServiceTier({ serviceTiers: [] })).toBe(false);
      expect(providerSupportsServiceTier({})).toBe(false);
      expect(providerSupportsServiceTier(null)).toBe(false);
      expect(providerSupportsServiceTier(undefined)).toBe(false);
    });
  });

  describe("central helper spawn (fullAccessSpawn)", () => {
    it("passes serviceTier: 'default' when no tier is specified and provider supports service tiers", async () => {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: {
            list: async () => [
              { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
            ],
          },
          threads: {
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "thr-1" };
            },
          },
        } as never,
      });

      await fullAccessSpawn(bb, {
        projectId: "p1",
        providerId: "claude-code",
        prompt: "test",
        pluginMetadata: { role: "helper" },
      } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
      expect(spawned[0]?.permissionMode).toBe("full");
    });

    it("passes configured serviceTier when given and provider supports service tiers", async () => {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: {
            list: async () => [
              { id: "codex", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default" }, { id: "fast" }] },
            ],
          },
          threads: {
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "thr-1" };
            },
          },
        } as never,
      });

      await fullAccessSpawn(bb, {
        projectId: "p1",
        providerId: "codex",
        serviceTier: "fast",
        prompt: "test",
        pluginMetadata: { role: "writer" },
      } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("fast");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends no service tier to a provider that has no service tiers", async () => {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: {
            list: async () => [
              { id: "acp-opencode", capabilities: { supportsServiceTier: false }, serviceTiers: [] },
            ],
          },
          threads: {
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "thr-1" };
            },
          },
        } as never,
      });

      await fullAccessSpawn(bb, {
        projectId: "p1",
        providerId: "acp-opencode",
        prompt: "test",
        pluginMetadata: { role: "helper" },
      } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBeUndefined();
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBeUndefined();
      expect(spawned[0]?.permissionMode).toBe("full");
    });

    it("strips requested service tier if provider has no service tiers", async () => {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: {
            list: async () => [
              { id: "custom-provider", capabilities: { supportsServiceTier: false }, serviceTiers: [] },
            ],
          },
          threads: {
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "thr-1" };
            },
          },
        } as never,
      });

      await fullAccessSpawn(bb, {
        projectId: "p1",
        providerId: "custom-provider",
        serviceTier: "fast",
        prompt: "test",
        pluginMetadata: { role: "helper" },
      } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBeUndefined();
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBeUndefined();
    });
  });

  describe("errand helper spawn inputs", () => {
    function setupErrandHost(providersList: Array<Record<string, unknown>>) {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: {
            list: async () => providersList,
          },
          threads: {
            get: async () => ({ id: "pm-1", projectId: "proj-1", environmentId: "env-1" }),
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "errand-thr-1" };
            },
          },
          environments: {
            get: async () => ({ id: "env-1", path: "/test/checkout", hostId: "host-1" }),
          },
        } as never,
      });
      const db = openDatabase(bb);
      createRun(db, "run-1", "proj-1", "cli", "/test/checkout");
      db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("pm-1", "run-1");
      const host = {
        call: async () => ({ isClean: true }),
      };
      const errands = mountErrands({ bb, db, host, secrets: {} as never, isDisposed: () => false } as never);
      return { errands, spawned };
    }

    it("sends serviceTier: 'default' when errand has no service tier specified", async () => {
      const { errands, spawned } = setupErrandHost([
        { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
      ]);

      await errands.startErrand({
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        task: "do something",
        authorized: false,
        accounts: [],
        providerId: "claude-code",
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends configured serviceTier: 'fast' when errand specifies fast tier", async () => {
      const { errands, spawned } = setupErrandHost([
        { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
      ]);

      await errands.startErrand({
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        task: "do something quickly",
        authorized: false,
        accounts: [],
        providerId: "claude-code",
        serviceTier: "fast",
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("fast");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends no service tier when errand runs on a provider without service tiers", async () => {
      const { errands, spawned } = setupErrandHost([
        { id: "acp-opencode", capabilities: { supportsServiceTier: false }, serviceTiers: [] },
      ]);

      await errands.startErrand({
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        task: "do something",
        authorized: false,
        accounts: [],
        providerId: "acp-opencode",
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBeUndefined();
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBeUndefined();
    });
  });

  describe("browser-qa helper spawn inputs", () => {
    function setupBrowserQaHost(providersList: Array<Record<string, unknown>>) {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: {
            list: async () => providersList,
          },
          threads: {
            get: async () => ({ id: "pm-1", projectId: "proj-1", environmentId: "env-1" }),
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "qa-thr-1" };
            },
            output: async () => ({
              output: 'Done.\n```json\n{"status":"pass","summary":"ok","cases":[{"case":"c1","viewport":"375","result":"passed"}]}\n```',
            }),
          },
        } as never,
      });
      const db = openDatabase(bb);
      createRun(db, "run-1", "proj-1", "cli", "/test/checkout");
      db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("pm-1", "run-1");
      const ctx = { bb, db, isDisposed: () => false };
      return { ctx, spawned };
    }

    it("sends serviceTier: 'default' when browser-qa has no service tier specified", async () => {
      const { ctx, spawned } = setupBrowserQaHost([
        { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
      ]);

      await runQaThread(ctx, {
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        taskTitle: "Check UI",
        qaHostId: "host-1",
        timeoutSec: 10,
        url: "http://localhost:3000",
        cases: ["wizard"],
        viewports: "375",
        envClass: "local",
        authorized: false,
        agent: { providerId: "claude-code", model: "claude-sonnet-4-6", effort: "high" },
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends configured serviceTier: 'fast' when browser-qa specifies fast tier", async () => {
      const { ctx, spawned } = setupBrowserQaHost([
        { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
      ]);

      await runQaThread(ctx, {
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        taskTitle: "Check UI fast",
        qaHostId: "host-1",
        timeoutSec: 10,
        url: "http://localhost:3000",
        cases: ["wizard"],
        viewports: "375",
        envClass: "local",
        authorized: false,
        agent: { providerId: "claude-code", model: "claude-sonnet-4-6", effort: "high", serviceTier: "fast" },
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("fast");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends no service tier when browser-qa runs on a provider without service tiers", async () => {
      const { ctx, spawned } = setupBrowserQaHost([
        { id: "acp-opencode", capabilities: { supportsServiceTier: false }, serviceTiers: [] },
      ]);

      await runQaThread(ctx, {
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        taskTitle: "Check UI opencode",
        qaHostId: "host-1",
        timeoutSec: 10,
        url: "http://localhost:3000",
        cases: ["wizard"],
        viewports: "375",
        envClass: "local",
        authorized: false,
        agent: { providerId: "acp-opencode", model: "opencode-1", effort: "medium" },
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBeUndefined();
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBeUndefined();
    });
  });
});
