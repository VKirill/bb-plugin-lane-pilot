import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { createIntakeTrain } from "../../src/rooms/workflow/server/services/intake";
import { issueQuickModelCalls, issueQuickShortPath, issueQuickWorkflowId } from "../../src/rooms/workflow/models/short-path";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

describe("issue_quick.short_path", () => {
  it("stays on the short path unless the setting is off", () => {
    expect(issueQuickShortPath(undefined)).toBe(true);
    expect(issueQuickShortPath({})).toBe(true);
    expect(issueQuickWorkflowId({ "issue_quick.short_path": "on" })).toBe("issue-quick");
    expect(issueQuickWorkflowId({ "issue_quick.short_path": "off" })).toBe("issue-quick-legacy");
    expect(issueQuickModelCalls({})).toBe(1);
    expect(issueQuickModelCalls({ "issue_quick.short_path": "off" })).toBe(2);
  });

  it("the intake starts the graph the setting names", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    cleanups.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);
    createRun(db, "r1", "p1", "bb");

    const startedIds: string[] = [];
    const train = createIntakeTrain({ bb, db, log: () => undefined } as never, {
      architect: { startOrder: vi.fn() },
      workflowCatalog: { store: vi.fn() } as never,
      workflowEngine: {
        resolveWorkflow: (id: string) => ({ id, version: 1, entry: "start", nodes: [], edges: [] }) as never,
        start: (args: { workflow: { id: string } }) => {
          startedIds.push(args.workflow.id);
          return { runId: `wf_${args.workflow.id}`, done: Promise.resolve() } as never;
        },
        get: () => null,
      } as never,
      workflowLibrary: { issueQuickWorkflowId } as never,
      workflowTriggers: { preflight: vi.fn() },
    });

    await train.start({ projectId: "p1", pmThreadId: "pm1", runId: "r1", requestId: "req-on", text: "Fix bug", kind: "small" });
    saveProjectSetting(db, "p1", "issue_quick.short_path", "off");
    await train.start({ projectId: "p1", pmThreadId: "pm1", runId: "r1", requestId: "req-off", text: "Fix bug", kind: "small" });

    expect(startedIds).toEqual(["issue-quick", "issue-quick-legacy"]);
  });
});
