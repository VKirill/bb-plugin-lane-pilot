import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fullAccessSpawn, providerSupportsServiceTier } from "../src/rooms/platform/server/services/pm-spawn";
import { mountErrands } from "../src/rooms/errands/server";
import { runQaThread } from "../src/rooms/qa/server";
import { createRun, openDatabase } from "../src/rooms/plugin-db";

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

    it("sends the standard tier even when the caller asked for fast", async () => {
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
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends the standard tier to a provider that lists no service tiers", async () => {
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
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
      expect(spawned[0]?.permissionMode).toBe("full");
    });

    it("sends the standard tier to a provider with no tiers even when the caller asked for fast", async () => {
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
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });
  });

  describe("provider list not consulted (providers.list)", () => {
    function setupSpawnHost(list: () => Promise<unknown>) {
      const spawned: Record<string, unknown>[] = [];
      let calls = 0;
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          providers: { list: async () => { calls += 1; return list(); } },
          threads: {
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: `thr-${spawned.length}` };
            },
          },
        } as never,
      });
      return { bb, spawned, calls: () => calls };
    }

    it("spawns on the standard tier when providers.list throws", async () => {
      const { bb, spawned, calls } = setupSpawnHost(async () => {
        throw new Error("provider host unreachable");
      });

      await fullAccessSpawn(bb, { projectId: "p1", providerId: "claude-code", prompt: "test", pluginMetadata: { role: "helper" } } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
      expect(spawned[0]?.permissionMode).toBe("full");
      expect(calls()).toBe(0);
    });

    it("spawns on the standard tier when providers.list is not stubbed", async () => {
      const spawned: Record<string, unknown>[] = [];
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          threads: {
            spawn: async (args: unknown) => {
              spawned.push(args as Record<string, unknown>);
              return { id: "thr-1" };
            },
          },
        } as never,
      });

      await fullAccessSpawn(bb, { projectId: "p1", providerId: "claude-code", prompt: "test", pluginMetadata: { role: "helper" } } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect(spawned[0]?.permissionMode).toBe("full");
    });

    it("sends the standard tier when the caller asked for fast and providers.list fails", async () => {
      const { bb, spawned } = setupSpawnHost(async () => {
        throw new Error("timeout");
      });

      await fullAccessSpawn(bb, { projectId: "p1", providerId: "codex", serviceTier: "fast", prompt: "test", pluginMetadata: { role: "writer" } } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends the standard tier when the provider is missing from the list", async () => {
      const { bb, spawned } = setupSpawnHost(async () => [{ id: "other", capabilities: { supportsServiceTier: true } }]);

      await fullAccessSpawn(bb, { projectId: "p1", providerId: "claude-code", prompt: "test", pluginMetadata: { role: "helper" } } as never);

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
    });

    it("sends 'default' for a provider with tiers and no configured tier", async () => {
      const { bb, spawned } = setupSpawnHost(async () => [{ id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] }]);

      await fullAccessSpawn(bb, { projectId: "p1", providerId: "claude-code", prompt: "test", pluginMetadata: { role: "helper" } } as never);

      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("never reads the provider list", async () => {
      const { bb, spawned, calls } = setupSpawnHost(async () => [{ id: "claude-code", capabilities: { supportsServiceTier: true } }]);
      const hostSpawn = { projectId: "p1", providerId: "claude-code", prompt: "test", pluginMetadata: { role: "helper" }, environment: { type: "host", hostId: "host-1" } };

      await fullAccessSpawn(bb, hostSpawn as never);
      await fullAccessSpawn(bb, hostSpawn as never);
      await fullAccessSpawn(bb, { ...hostSpawn, environment: { type: "host", hostId: "host-2" } } as never);

      expect(spawned).toHaveLength(3);
      expect(calls()).toBe(0);
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

    it("sends the standard tier when the errand asks for fast", async () => {
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
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends the standard tier when the errand runs on a provider without service tiers", async () => {
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
        model: "router9/x",
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });
  });

  describe("browser-qa helper spawn inputs", () => {
    const QA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const QA_FILE = { content: QA_PNG.toString("base64"), contentEncoding: "base64", sha256: "a".repeat(64), sizeBytes: QA_PNG.length };
    function setupBrowserQaHost(providersList: Array<Record<string, unknown>>, verdictText?: string) {
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
              output: verdictText ?? 'Done.\n```json\n{"status":"pass","summary":"ok","findings":[],"evidence":"viewed","cases":[{"case":"c1","viewport":"375","result":"passed"}],"artifacts":[{"case":"c1","viewport":"375","path":"artifacts/browser-qa/c1-375.png"}]}\n```',
            }),
            storageLocation: async () => ({ hostId: "qa-host", storageRootPath: "/thread-store/qa-thr-1" }),
            events: { list: async ({ threadId }: { threadId?: string }) => [
              { type: "turn/started", threadId, seq: 1 },
              { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
            ] as never },
          },
          files: {
            read: async ({ path }: { path?: string }) => path?.endsWith("c1-375.png") ? QA_FILE : Promise.reject(new Error("ENOENT")),
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

    it("sends the standard tier when browser-qa asks for fast", async () => {
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
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("sends the standard tier when browser-qa runs on a provider without service tiers", async () => {
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
      expect(spawned[0]?.serviceTier).toBe("default");
      expect((spawned[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    });

    it("cannot pass on a verdict that misses requested case×viewport pairs", async () => {
      const { ctx } = setupBrowserQaHost([
        { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
      ], 'Done.\n```json\n{"status":"pass","summary":"ok","cases":[]}\n```');

      const verdict = await runQaThread(ctx, {
        projectId: "proj-1",
        runId: "run-1",
        pmThreadId: "pm-1",
        taskTitle: "Check UI",
        qaHostId: "host-1",
        timeoutSec: 10,
        url: "http://localhost:3000",
        cases: ["wizard"],
        viewports: "375,1280",
        envClass: "local",
        authorized: false,
        agent: { providerId: "claude-code", model: "claude-sonnet-4-6", effort: "high" },
      });

      expect(verdict.verdict).toBe("blocked");
      expect(verdict.summary).toContain("browser_qa_coverage_failed");
      expect(verdict.summary).toContain("missing:c1@1280");
    });

    it("cannot pass a verdict that carries no durable screenshot evidence", async () => {
      const { ctx } = setupBrowserQaHost([
        { id: "claude-code", capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast" }] },
      ], 'Done.\n```json\n{"status":"pass","summary":"ok","findings":[],"evidence":"viewed","cases":[{"case":"c1","viewport":"375","result":"passed"}]}\n```');

      const verdict = await runQaThread(ctx, {
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

      expect(verdict.verdict).toBe("blocked");
      expect(verdict.summary).toContain("browser_qa_evidence_failed");
      expect(verdict.summary).toContain("missing_evidence:c1@375");
    });
  });

  describe("Lane Pilot's OpenCode v2 agent", () => {
    const host = (agents: string[] | Error, spawned: Record<string, unknown>[], calls = { models: 0 }) => createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        providers: {
          list: async () => [{ id: "opencode2", capabilities: { supportsServiceTier: false } }],
          models: async () => {
            calls.models += 1;
            if (agents instanceof Error) throw agents;
            return { models: [{ id: "router9/x", sessionOptions: [{ id: "agent", type: "select", value: "build", values: agents.map((id) => ({ id, label: id })) }] }] };
          },
        },
        threads: { spawn: async (args: unknown) => { spawned.push(args as Record<string, unknown>); return { id: "thr-1" }; } },
      } as never,
    }).bb;
    const spawn = (bb: ReturnType<typeof host>, extra: Record<string, unknown> = {}) =>
      fullAccessSpawn(bb, { projectId: "p1", providerId: "opencode2", model: "router9/x", prompt: "t", environment: { type: "host", hostId: "mini" }, pluginMetadata: { role: "writer" }, ...extra } as never);

    it("starts an opencode2 thread on lane-pilot when the host's catalog lists it, and reads the catalog once a minute", async () => {
      const spawned: Record<string, unknown>[] = [];
      const calls = { models: 0 };
      const bb = host(["build", "plan", "lane-pilot"], spawned, calls);
      await spawn(bb);
      await spawn(bb);
      expect(spawned.map((args) => args.sessionOptions)).toEqual([{ agent: "lane-pilot" }, { agent: "lane-pilot" }]);
      expect(calls.models).toBe(1);
    });

    it("names no agent on a host without it, when the catalog fails, or when the caller chose options", async () => {
      const spawned: Record<string, unknown>[] = [];
      await spawn(host(["build", "plan"], spawned));
      await spawn(host(new Error("offline"), spawned));
      await spawn(host(["lane-pilot"], spawned), { sessionOptions: { agent: "plan" } });
      expect(spawned.map((args) => args.sessionOptions)).toEqual([undefined, undefined, { agent: "plan" }]);
    });

    it("leaves other providers alone", async () => {
      const spawned: Record<string, unknown>[] = [];
      const calls = { models: 0 };
      await spawn(host(["lane-pilot"], spawned, calls), { providerId: "codex" });
      expect(spawned[0]?.sessionOptions).toBeUndefined();
      expect(calls.models).toBe(0);
    });
  });
});
