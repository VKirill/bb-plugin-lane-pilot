import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { definitionSha256, parseWorkflow, WorkflowEngine, type Workflow, type WorkflowStore } from "@lane-pilot/workflow-engine";
import plugin from "../server";
import { DRILL_SANDBOX_PROJECT_IDS } from "../src/rooms/contracts";
import type { ServerCore } from "../src/rooms/contracts/server";
import { createCore } from "../src/rooms/core/server/core";
import { DOCS_ENABLED_KEY } from "../src/rooms/docs";
import { docsRpc } from "../src/rooms/docs/server";
import { openDatabase, saveProjectSetting } from "../src/rooms/plugin-db";
import { createWorkflowTriggers, workflowStartRefusal } from "../src/rooms/workflow/server/services/workflow-triggers";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function docsWorkflow(id = "docs-synthesis"): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id,
    version: 1,
    category: "docs",
    name: { en: id, ru: id },
    description: { en: `Test docs workflow ${id} for docs switch verification`, ru: `Тестовый граф документации ${id}` },
    status: "published",
    nodes: [{ id: "echo", type: "action", action: "test.echo", params: { value: "ok" }, out: [{ name: "out", type: "string" }] }],
    edges: [{ from: "start", to: "echo" }, { from: "echo", to: "end" }],
  });
}

function storeFor(...workflows: Workflow[]): WorkflowStore {
  const items = workflows.map((workflow) => ({
    workflow,
    origin: "project" as const,
    source: `test:${workflow.id}.json`,
    sha256: definitionSha256(workflow),
    warnings: [],
  }));
  return {
    list: () => items,
    get: (id) => items.find((item) => item.workflow.id === id) ?? null,
    resolve: (id) => items.find((item) => item.workflow.id === id)?.workflow ?? null,
    problems: [],
  };
}

describe("docs switch: docs_projects, docs_set, and docs graph start refusal", () => {
  it("lists non-sandbox projects with docs off by default and persists docs_set via settings store", async () => {
    const infoLogs: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          list: async () => [
            { id: GLOBAL_SETTINGS_PROJECT_ID, name: "*" },
            { id: DRILL_SANDBOX_PROJECT_IDS[0]!, name: "Drill" },
            { id: "proj-bench", name: "LP bench suite" },
            { id: "proj-1", name: "Alpha" },
            { id: "proj-2", name: "Beta" },
          ] as never,
          get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId === "proj-1" ? "Alpha" : "Beta", sources: [] }) as never,
        },
      },
    });
    const origInfo = bb.log.info.bind(bb.log);
    bb.log.info = (msg: string) => {
      infoLogs.push(msg);
      origInfo(msg);
    };
    const db = openDatabase(bb);
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const initial = await harness.behavior.callRpc("docs_projects", {}) as { projects: Array<{ projectId: string; name: string; on: boolean }> };
    expect(initial.projects).toEqual([
      { projectId: "proj-1", name: "Alpha", on: false },
      { projectId: "proj-2", name: "Beta", on: false },
    ]);

    const turnedOn = await harness.behavior.callRpc("docs_set", { projectId: "proj-1", on: true }) as { projectId: string; name: string; on: boolean };
    expect(turnedOn).toEqual({ projectId: "proj-1", name: "Alpha", on: true });
    expect(infoLogs.some((line) => line.includes("docs.switch") && line.includes("proj-1") && line.includes("true"))).toBe(true);

    const afterOn = await harness.behavior.callRpc("docs_projects", {}) as { projects: Array<{ projectId: string; name: string; on: boolean }> };
    expect(afterOn.projects).toEqual([
      { projectId: "proj-1", name: "Alpha", on: true },
      { projectId: "proj-2", name: "Beta", on: false },
    ]);

    const turnedOff = await harness.behavior.callRpc("docs_set", { projectId: "proj-1", on: false }) as { projectId: string; name: string; on: boolean };
    expect(turnedOff).toEqual({ projectId: "proj-1", name: "Alpha", on: false });

    // Unit check directly through docsRpc handler as well.
    const ctx = createCore(bb, db);
    const direct = docsRpc(ctx, { docsPlaces: async () => [], docsPlaceStatus: async () => ({ verdict: null, cadence: "nightly", lastReadAt: null }), docsLastRead: () => null });
    await direct.docs_set({ projectId: "proj-2", on: true });
    expect((await direct.docs_projects()).projects.find((p) => p.projectId === "proj-2")?.on).toBe(true);
  });

  it("refuses docs graphs when documentation is off and allows them when true or auto", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db) as ServerCore;
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", resolveWorkflow: () => null });
    engine.register("test.echo", { run: async () => ({ output: { out: "ok" } }) });
    const customDocs = docsWorkflow("custom-docs-graph");
    const triggers = createWorkflowTriggers(
      ctx,
      { workflowEngine: engine },
      { loadStore: async () => ({ store: storeFor(docsWorkflow("docs-synthesis"), customDocs), project: "ok" }) },
    );

    // Off by default: built-in docs-synthesis and custom category=docs graph are refused.
    expect(workflowStartRefusal({ db, workflowId: "docs-synthesis", source: "manual", projectId: "proj-docs" })).toBe("docs_disabled");
    const refusedBuiltin = await triggers.start({ projectId: "proj-docs", workflowId: "docs-synthesis", inputs: {}, source: "manual" });
    expect(refusedBuiltin).toMatchObject({ ok: false, reason: "docs_disabled" });
    if (!refusedBuiltin.ok) expect(refusedBuiltin.message).toContain(DOCS_ENABLED_KEY);

    const refusedCustom = await triggers.start({ projectId: "proj-docs", workflowId: "custom-docs-graph", inputs: {}, source: "manual" });
    expect(refusedCustom).toMatchObject({ ok: false, reason: "docs_disabled" });

    // Turning docs.enabled to "true" allows both.
    saveProjectSetting(db, "proj-docs", DOCS_ENABLED_KEY, "true");
    expect(workflowStartRefusal({ db, workflowId: "docs-synthesis", source: "manual", projectId: "proj-docs" })).toBeNull();
    const allowedTrue = await triggers.start({ projectId: "proj-docs", workflowId: "custom-docs-graph", inputs: {}, source: "manual" });
    expect(allowedTrue.ok).toBe(true);

    // "auto" also allows docs graphs when explicitly chosen by the owner.
    saveProjectSetting(db, "proj-docs", DOCS_ENABLED_KEY, "auto");
    expect(workflowStartRefusal({ db, workflowId: "docs-synthesis", source: "manual", projectId: "proj-docs" })).toBeNull();
    const allowedAuto = await triggers.start({ projectId: "proj-docs", workflowId: "docs-synthesis", inputs: {}, source: "manual" });
    expect(allowedAuto.ok).toBe(true);
  });
});
