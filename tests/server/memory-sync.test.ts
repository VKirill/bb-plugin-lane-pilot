import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig, searchMemoryRecords, setRunThread, storeMemoryRecords } from "../../src/database";

const projectId = "memory-sync-project";
const pmThreadId = "memory-sync-pm";
const runId = "memory-sync-run";
const workspace = "/tmp/memory-sync-workspace";
const dir = `${workspace}/.agents/memory`;

const fileRecord = `---
id: worktree-routing
schema_version: 2
status: active
memory_type: normative
truth_mode: decision
claim: Parallel writers use a worktree each
language: en
sensitivity: internal
context_priority: always
retrieval:
  areas: [lanes]
  hint: worktree
---

Shared checkouts see half-done edits.
`;

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("memory sync", () => {
  it("imports lane-memory files into project memory and exports records the folder lacks", async () => {
    const files = new Map<string, string>([[`${dir}/worktree-routing.md`, fileRecord], [`${dir}/MEMORY.md`, "generated"], [`${dir}/dead.md`, fileRecord.replace("id: worktree-routing", "id: dead").replace("status: active", "status: archived")]]);
    const written: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        files: {
          listPaths: async ({ path }: { path: string }) => ({ truncated: false, paths: [...files.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => ({ kind: "file" as const, name: file.slice(path.length + 1), path: file, positions: [], score: 1 })) }) as never,
          read: async ({ path }: { path: string }) => ({ content: files.get(path) ?? null }) as never,
          write: async ({ path, content }: { path: string; content: string }) => { written.push(path); files.set(path, content); return { ok: true } as never; },
        },
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: workspace, writerWorkspacePath: workspace, pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const call = async (name: string, params: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;

    expect(await call("lane_pilot_memory_import", { runId })).toMatchObject({ state: "skipped", reason: "memory_disabled" });
    saveProjectSetting(db, projectId, "memory.enabled", "true");

    const imported = await call("lane_pilot_memory_import", { runId });
    expect(imported).toMatchObject({ state: "imported", files: 2, imported: 1, skipped: [{ file: "dead.md", reason: "status archived" }] });
    const found = searchMemoryRecords(db, projectId, "worktree parallel writers", 10, "fts5", "subagent");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "core", concepts: ["worktree-routing", "lanes", "worktree"] });
    expect((await call("lane_pilot_memory_import", { runId })).imported).toBe(0);

    storeMemoryRecords(db, { projectId, audience: "subagent", sourceSha256: "c".repeat(64), entries: [{ kind: "note", content: "Night review: discount applied twice on retry.", concepts: ["lesson", "checkout"] }], coreBudget: 3072, noteBudget: 8000, indexBudget: 65536 });
    const exported = await call("lane_pilot_memory_export", { runId });
    expect(exported).toMatchObject({ state: "exported", records: 2, written: 2, existing: 0 });
    expect(written.every((path) => path.startsWith(`${dir}/lp-`) && path.endsWith(".md"))).toBe(true);
    expect(files.get(written[0]!)).toContain("schema_version: 2");
    expect(await call("lane_pilot_memory_export", { runId })).toMatchObject({ written: 0, existing: 2 });
  });
});
