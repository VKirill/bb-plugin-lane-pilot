import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createRun, getRunWriterHost, openDatabase, savePrototypeConfig, setRunThread } from "../src/database";
import { LANE_PILOT_READ_NAME } from "../src/bounded-read";
import { readBoundedFile } from "../src/host-handlers";

const projectId = "proj_read";
const hostA = "host-read-a";
const hostB = "host-read-b";

describe("lane_pilot_read", () => {
  it("registers the real tool key and refuses an invented MCP alias", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    try {
      expect(LANE_PILOT_READ_NAME).toBe("lane_pilot_read");
      expect(LANE_PILOT_READ_NAME.startsWith("mcp__")).toBe(false);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reads through frozen run host, not mutated config.hostId, and bounds the host RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-read-ws-"));
    await mkdir(join(root, "src"));
    const body = "one\ntwo\nthree\nfour";
    await writeFile(join(root, "src/note.txt"), body);
    const hostCalls: Array<{ method: string; hostId?: string; input: Record<string, unknown> }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "lprun_read" }),
        },
        files: {
          read: async () => {
            throw new Error("sdk files.read must not be used for lane_pilot_read");
          },
        },
      },
      experimental_callHostRpc: async (call) => {
        hostCalls.push({ method: call.method, hostId: call.hostId, input: call.input as Record<string, unknown> });
        if (call.method !== "readBoundedFile") throw new Error(`unexpected host method ${call.method}`);
        return readBoundedFile(call.input as Parameters<typeof readBoundedFile>[0], {} as never);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId,
      hostId: hostA,
      pmWorkspacePath: "/tmp/pm-read",
      writerWorkspacePath: root,
      pmProviderId: "claude-code",
      pmModel: "claude-test",
      writerProviderId: "codex",
      writerModel: "codex-test",
    });
    createRun(db, "lprun_read", projectId, "bb", root, "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, hostA);
    setRunThread(db, "lprun_read", "thr_pm");
    savePrototypeConfig(db, {
      projectId,
      hostId: hostB,
      pmWorkspacePath: "/tmp/pm-read",
      writerWorkspacePath: root,
      pmProviderId: "claude-code",
      pmModel: "claude-test",
      writerProviderId: "codex",
      writerModel: "codex-test",
    });
    expect(getRunWriterHost(db, "lprun_read")).toBe(hostA);
    await plugin(bb);
    try {
      const raw = String(await harness.behavior.callAgentTool(LANE_PILOT_READ_NAME, {
        path: "src/note.txt", offset: 1, maxLines: 2,
      }, { threadId: "thr_pm", projectId }));
      const parsed = JSON.parse(raw);
      expect(parsed).toMatchObject({
        schemaVersion: 1,
        hostId: hostA,
        path: "src/note.txt",
        offset: 1,
        maxLines: 2,
        totalLines: 4,
        lineStart: 2,
        lineEnd: 3,
        truncated: true,
        content: "two\nthree",
        contentEncoding: "utf8",
      });
      expect(parsed.sha256).toBe(createHash("sha256").update(body).digest("hex"));
      expect(parsed.sizeBytes).toBe(Buffer.byteLength(body));
      expect(JSON.stringify(parsed)).not.toContain("four");
      expect(hostCalls).toEqual([expect.objectContaining({
        method: "readBoundedFile",
        hostId: hostA,
        input: expect.objectContaining({
          requestedHostId: hostA,
          projectCwd: root,
          relativePath: "src/note.txt",
          offset: 1,
          maxLines: 2,
        }),
      })]);
      await expect(harness.behavior.callAgentTool(LANE_PILOT_READ_NAME, {
        path: "../secret", offset: 0, maxLines: 10,
      }, { threadId: "thr_pm", projectId })).rejects.toThrow(/escaped/);
      await expect(harness.behavior.callAgentTool(LANE_PILOT_READ_NAME, {
        path: "/etc/passwd", offset: 0, maxLines: 10,
      }, { threadId: "thr_pm", projectId })).rejects.toThrow(/escaped/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each([
    { name: "foreign project", threadId: "thr_pm", callProjectId: "proj_foreign", bindPm: true },
    { name: "mismatched PM thread", threadId: "thr_stale", callProjectId: projectId, bindPm: true },
    { name: "missing PM thread binding", threadId: "thr_pm", callProjectId: projectId, bindPm: false },
  ])("refuses $name before any host RPC", async ({ threadId, callProjectId, bindPm }) => {
    const root = await mkdtemp(join(tmpdir(), "lp-read-identity-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/note.txt"), "secret\n");
    const hostCalls: unknown[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "lprun_ident" }),
        },
      },
      experimental_callHostRpc: async (call) => {
        hostCalls.push(call);
        throw new Error("host must not be called for a mismatched PM identity");
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId,
      hostId: hostA,
      pmWorkspacePath: "/tmp/pm-read",
      writerWorkspacePath: root,
      pmProviderId: "claude-code",
      pmModel: "claude-test",
      writerProviderId: "codex",
      writerModel: "codex-test",
    });
    createRun(db, "lprun_ident", projectId, "bb", root, "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, hostA);
    if (bindPm) setRunThread(db, "lprun_ident", "thr_pm");
    await plugin(bb);
    try {
      await expect(harness.behavior.callAgentTool(LANE_PILOT_READ_NAME, {
        path: "src/note.txt", offset: 0, maxLines: 10,
      }, { threadId, projectId: callProjectId })).rejects.toThrow(/does not belong to this PM thread and project/);
      expect(hostCalls).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("fail-closes when the frozen writer host binding is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-read-missing-host-"));
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "lprun_nohost" }),
        },
      },
      experimental_callHostRpc: async () => {
        throw new Error("host must not be called without a frozen binding");
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId,
      hostId: hostB,
      pmWorkspacePath: "/tmp/pm-read",
      writerWorkspacePath: root,
      pmProviderId: "claude-code",
      pmModel: "claude-test",
      writerProviderId: "codex",
      writerModel: "codex-test",
    });
    createRun(db, "lprun_nohost", projectId, "bb", root);
    setRunThread(db, "lprun_nohost", "thr_pm");
    await plugin(bb);
    try {
      await expect(harness.behavior.callAgentTool(LANE_PILOT_READ_NAME, {
        path: "src/note.txt", offset: 0, maxLines: 10,
      }, { threadId: "thr_pm", projectId })).rejects.toThrow(/frozen writer host or workspace binding/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
