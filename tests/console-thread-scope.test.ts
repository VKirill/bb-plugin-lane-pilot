import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcConsole, threadScopeOutput } from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { projectScopeOf } from "../src/rooms/memory/server";
import { openDatabase } from "../src/rooms/plugin-db";
import { clearThreadScopeCache, PROBE_CACHE_TTL_MS, runsConsoleRpc, threadScope } from "../src/rooms/runs/server";
import { projectPlace } from "../src/rooms/schedule/server";
import { specialistOverview } from "../src/rooms/specialist/server";

let dispose: (() => Promise<void> | void) | null = null;

beforeEach(() => {
  clearThreadScopeCache();
});

afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function fakeBb(input: {
  threads?: Record<string, { projectId?: string | null; environmentId?: string | null; sectionId?: string | null }>;
  environments?: Record<string, { hostId?: string | null; path?: string | null }>;
  metadata?: Record<string, Record<string, unknown> | null>;
}): BbPluginApi {
  return {
    sdk: {
      threads: {
        get: vi.fn(async ({ threadId }: { threadId: string }) => {
          const row = input.threads?.[threadId];
          if (!row) throw Object.assign(new Error("Thread not found"), { status: 404 });
          return { id: threadId, ...row };
        }),
        getPluginMetadata: vi.fn(async ({ threadId }: { threadId: string }) => {
          return input.metadata?.[threadId] ?? null;
        }),
      },
      environments: {
        get: vi.fn(async ({ environmentId }: { environmentId: string }) => {
          const env = input.environments?.[environmentId];
          if (!env) throw Object.assign(new Error("Environment not found"), { status: 404 });
          return { id: environmentId, ...env };
        }),
      },
    },
  } as unknown as BbPluginApi;
}

describe("threadScope", () => {
  it("resolves a PM thread with repository and section from memoryProject", async () => {
    const bb = fakeBb({
      threads: {
        thr_pm: { projectId: "proj-1", environmentId: "env-1" },
      },
      environments: {
        "env-1": { hostId: "ovh", path: "/srv/app/apps/api" },
      },
      metadata: {
        thr_pm: { role: "pm", lanePilotRunId: "run-1" },
      },
    });
    const projectPlaceFn = vi.fn(async () => null);
    const memoryProjectFn = vi.fn(async () => ({ projectId: "proj-1", sectionId: "sec-api" }));
    const probeRepoFn = vi.fn(async () => ({
      root: "/srv/app",
      remote: "git@github.com:org/app.git",
      githubRepoId: "987654",
    }));

    const out = await threadScope(
      { bb, projectPlace: projectPlaceFn, memoryProject: memoryProjectFn, probeRepo: probeRepoFn },
      "thr_pm",
    );

    expect(threadScopeOutput.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      threadId: "thr_pm",
      projectId: "proj-1",
      sectionId: "sec-api",
      hostId: "ovh",
      cwd: "/srv/app/apps/api",
      repo: {
        root: "/srv/app",
        remote: "git@github.com:org/app.git",
        githubRepoId: "987654",
      },
      isPm: true,
    });
    expect(memoryProjectFn).toHaveBeenCalledWith("ovh", "/srv/app/apps/api");
    expect(probeRepoFn).toHaveBeenCalledWith("ovh", "/srv/app/apps/api");
  });

  it("resolves an ordinary chat without Git (repo: null) and honors BB sectionId when present", async () => {
    const bb = fakeBb({
      threads: {
        thr_chat: { projectId: "proj-2", environmentId: "env-2", sectionId: "sec-bb" },
      },
      environments: {
        "env-2": { hostId: "mini", path: "/Users/owner/notes" },
      },
    });
    const memoryProjectFn = vi.fn(async () => ({ projectId: "proj-2", sectionId: "sec-mem" }));
    const probeRepoFn = vi.fn(async () => null);

    const out = await threadScope(
      { bb, projectPlace: async () => null, memoryProject: memoryProjectFn, probeRepo: probeRepoFn },
      "thr_chat",
    );

    expect(threadScopeOutput.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      threadId: "thr_chat",
      projectId: "proj-2",
      sectionId: "sec-bb",
      hostId: "mini",
      cwd: "/Users/owner/notes",
      repo: null,
      isPm: false,
    });
    expect(memoryProjectFn).not.toHaveBeenCalled();
    expect(probeRepoFn).toHaveBeenCalledTimes(1);
  });

  it("returns all-null scope for an unknown thread", async () => {
    const bb = fakeBb({});
    const probeRepoFn = vi.fn(async () => null);

    const out = await threadScope(
      { bb, projectPlace: async () => null, memoryProject: async () => null, probeRepo: probeRepoFn },
      "thr_missing",
    );

    expect(threadScopeOutput.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      threadId: "thr_missing",
      projectId: null,
      sectionId: null,
      hostId: null,
      cwd: null,
      repo: null,
      isPm: false,
    });
    expect(probeRepoFn).not.toHaveBeenCalled();
  });

  it("caches probe results per hostId+cwd for 5 minutes and calls probeRepo once for two calls", async () => {
    const bb = fakeBb({
      threads: {
        thr_a: { projectId: "proj-1", environmentId: "env-1" },
        thr_b: { projectId: "proj-1", environmentId: "env-1" },
      },
      environments: {
        "env-1": { hostId: "ovh", path: "/srv/shared" },
      },
    });
    let currentNow = 1_000_000;
    const probeRepoFn = vi.fn(async () => ({
      root: "/srv/shared",
      remote: "https://github.com/org/shared.git",
      githubRepoId: null,
    }));
    const deps = {
      bb,
      projectPlace: async () => null,
      memoryProject: async () => null,
      probeRepo: probeRepoFn,
      now: () => currentNow,
    };

    const first = await threadScope(deps, "thr_a");
    const second = await threadScope(deps, "thr_b");

    expect(first.repo).toEqual({ root: "/srv/shared", remote: "https://github.com/org/shared.git", githubRepoId: null });
    expect(second.repo).toEqual(first.repo);
    expect(probeRepoFn).toHaveBeenCalledTimes(1);

    // After 5 minutes TTL expires, probeRepo runs again.
    currentNow += PROBE_CACHE_TTL_MS;
    await threadScope(deps, "thr_a");
    expect(probeRepoFn).toHaveBeenCalledTimes(2);
  });

  it("degrades to repo: null and logs warn without full path when probe fails", async () => {
    const secretPath = "/Users/owner/private/secret-folder";
    const bb = fakeBb({
      threads: {
        thr_offline: { projectId: "proj-1", environmentId: "env-offline" },
      },
      environments: {
        "env-offline": { hostId: "win-box", path: secretPath },
      },
    });
    const warnings: string[] = [];
    const debugs: string[] = [];

    const out = await threadScope(
      {
        bb,
        projectPlace: async () => null,
        memoryProject: async () => null,
        probeRepo: async () => {
          throw new Error("host offline");
        },
        log: {
          warn: (msg) => warnings.push(msg),
          debug: (msg) => debugs.push(msg),
        },
      },
      "thr_offline",
    );

    expect(out.repo).toBeNull();
    expect(out.cwd).toBe(secretPath);
    expect(warnings).toEqual(["[console] thread_scope probe failed host=win-box reason=host offline"]);
    expect(warnings[0]).not.toContain(secretPath);
    expect(debugs[0]).toContain(secretPath);
  });

  it("registers thread_scope in runsConsoleRpc and exports schedule projectPlace and memory projectScopeOf", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    harness.sdk.stub("threads.get", async () => {
      throw Object.assign(new Error("Thread not found"), { status: 404 });
    });
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    expect(typeof projectPlace).toBe("function");
    expect(typeof projectScopeOf).toBe("function");

    const handlers = runsConsoleRpc(ctx, {
      money: { status: () => ({}) },
      specialistOverview,
    });
    const out = await handlers.thread_scope({ threadId: "thr_unknown" });
    expect(rpcConsole.thread_scope.output.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      threadId: "thr_unknown",
      projectId: null,
      sectionId: null,
      hostId: null,
      cwd: null,
      repo: null,
      isPm: false,
    });
  });
});
