import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

// The BB-service project's actual sources when the hourly pass failed on 2026-10-28.
const projectId = "proj_ejbam66722";
const sources = [
  { hostId: "host_7sea4qaad8", path: "/Users/vechkasov/Documents/BB-сервис", isDefault: true },
  { hostId: "host_p7jhrgsapq", path: "/Users/vechkasov/Documents/BB-сервис", isDefault: false },
  { hostId: "host_rwrxyi39aw", path: "/home/ubuntu/BB-service", isDefault: false },
  { hostId: "host_z8sapas8an", path: "C:\\Users\\vechkasov\\bb-perf", isDefault: false },
];
const windows = sources[3]!;

describe("nightly docs workspace eligibility", () => {
  it.each(["source", "section"] as const)("skips a Windows %s before host RPC validation and still inspects the POSIX sources", async (origin) => {
    const scoped: Array<{ requestedHostId: string; projectCwd: string }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async () => ({ id: projectId, name: "BB-сервис", sources: origin === "source" ? sources : sources.slice(0, 3) }) as never,
          list: async () => [{ id: projectId }] as never,
        },
        plugins: { callRpc: async ({ pluginId, method }) => {
          if (pluginId === "project-folders" && method === "sections_list") return { sections: origin === "section" ? [
            { id: "perf", projectId, parentId: null, name: "Perf", kind: "folder", ...windows, paths: [windows] },
          ] : [] };
          throw new Error(`unexpected plugin RPC ${pluginId}.${method}`);
        } },
      },
      experimental_callHostRpc: (call) => {
        if (call.method !== "gitDocsScope") throw new Error(`unexpected host RPC ${call.method}`);
        scoped.push(call.input as typeof scoped[number]);
        return { hostId: (call.input as typeof scoped[number]).requestedHostId, status: "not-git", isRepoRoot: false, hasDocs: false,
          changed: [], dirty: [], base: null, workspaces: [], localDate: "2026-10-28", localHour: 4, reason: null };
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    // An explicit "Always" must not bypass the host's supported path shape.
    saveProjectSetting(openDatabase(bb), projectId, "docs.enabled", true);
    const result = await harness.behavior.runCli(["docs-nightly", projectId]) as { stdout: string };
    expect(JSON.parse(result.stdout)).toEqual([
      { projectId, hostId: windows.hostId, path: windows.path, state: "skipped", reason: "unsupported_workspace_path" },
    ]);
    expect(scoped).toEqual(sources.slice(0, 3).map(({ hostId, path }) => ({ requestedHostId: hostId, projectCwd: path, sinceEpochMs: expect.any(Number) })));
    expect(harness.logEntries.filter((entry) => entry.message.includes("Lane Pilot nightly docs failed"))).toEqual([]);
  });
});
