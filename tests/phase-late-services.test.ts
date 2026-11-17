import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { openDatabase } from "../src/rooms/plugin-db";
import { installWiring } from "../src/rooms/phase/server/driver-wiring";
import type { Phase } from "../src/rooms/phase/logic";

const phase = (id: string): Phase => ({
  id,
  projectId: "project-late-services",
  pmThreadId: "pm-late-services",
  runId: "run-late-services",
  title: "Late services",
  goal: "exercise late service wiring",
  stage: "discussion",
  state: "active",
  record: { train: true },
  edition: 1,
  createdAt: 1,
  updatedAt: 1,
});

describe("phase wiring with late-filled services", () => {
  it("resolves library and architect services when each route is invoked", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const started: Array<Record<string, unknown>> = [];
    const prepared: string[] = [];
    const loaded: string[] = [];
    const architectCalls: Array<Record<string, unknown>> = [];
    let quickIdCalls = 0;
    let preflightCalls = 0;
    let preflightAllowed = true;
    let fallbackCalls = 0;
    const baseWorkflow = { id: "lp.analyze", name: "Analyze", nodes: [] };
    const composedWorkflow = { id: "lp.analyze", name: "Analyze composed", nodes: [] };
    const services: Record<string, any> = {
      workflowEngine: {
        resolveWorkflow: (id: string) => ["lp.analyze", "issue-quick", "full-lifecycle", "issue-batch"].includes(id) ? { ...baseWorkflow, id } : null,
        start: (input: Record<string, unknown>) => { started.push(input); return { runId: `wf-${started.length}`, done: Promise.resolve() }; },
        get: () => null,
      },
      workflowCatalog: { store: () => { fallbackCalls += 1; return { list: () => [] }; } },
      workflowTriggers: { preflight: async () => { preflightCalls += 1; return preflightAllowed ? { ok: true } : { ok: false, reason: "fixture refusal" }; } },
      workflowLibrary: undefined,
      architect: undefined,
    };
    const current = new Map<string, Phase>();
    const wiring = installWiring({
      ctx: createCore(bb, db), services: services as never, db, bb, now: () => 10,
      reactions: { journalDrawing: async () => undefined },
      exhaust: async () => undefined,
      context: async (input: { phaseId: string }) => current.get(input.phaseId)!,
      plan: async (input: { phaseId: string }) => current.get(input.phaseId)!,
      planCheck: async (input: { phaseId: string }) => current.get(input.phaseId)!,
      question: () => current.values().next().value!, waveReview: async () => current.values().next().value!,
      goalAudit: async () => current.values().next().value!, lessons: async () => current.values().next().value!,
      drawing: async () => current.values().next().value!, returnTo: () => current.values().next().value!,
      mustGet: (id: string) => current.get(id)!,
      savePhase: (id: string, input: { record: Record<string, unknown> }) => { const before = current.get(id)!; current.set(id, { ...before, record: input.record }); },
      book: () => undefined, writeDocs: async () => ({ written: [] }), readText: async () => null, planningHome: async () => null,
      proofCurrency: async () => null,
    } as never);

    try {
      // The embedded path remains usable while no project library is present.
      const embedded = phase("embedded");
      current.set(embedded.id, embedded);
      expect(await wiring.auto.step(embedded)).toBe(true);
      expect(started[0]?.workflow).toMatchObject({ id: "lp.analyze" });
      expect(prepared).toEqual([]);

      services.workflowLibrary = {
        issueQuickWorkflowId: () => { quickIdCalls += 1; return "issue-quick"; },
        issueQuickModelCalls: () => 0,
        issueQuickShortPath: () => true,
        prepareWorkflow: async (projectId: string, workflow: { id: string }) => {
          prepared.push(`${projectId}:${workflow.id}`);
          return { workflow: composedWorkflow, resolve: services.workflowEngine.resolveWorkflow, composed: true };
        },
        loadStore: async (projectId: string) => { loaded.push(projectId); return { store: { list: () => [] } }; },
      };
      services.architect = { startOrder: async (input: Record<string, unknown>) => { architectCalls.push(input); return { threadId: "architect-thread" }; } };

      const analyzed = phase("late-auto");
      current.set(analyzed.id, analyzed);
      expect(await wiring.auto.step(analyzed)).toBe(true);
      expect(prepared).toEqual(["project-late-services:lp.analyze"]);
      expect(started[1]?.workflow).toBe(composedWorkflow);
      expect(preflightCalls).toBe(1);

      const heavyRun = await wiring.train.start({ projectId: analyzed.projectId, pmThreadId: analyzed.pmThreadId, runId: analyzed.runId!, requestId: "request-heavy", text: "heavy fix", kind: "heavy" });
      expect(heavyRun).toBe("wf-3");
      expect(quickIdCalls).toBe(0);
      expect(prepared).toEqual(["project-late-services:lp.analyze", "project-late-services:full-lifecycle"]);
      expect(preflightCalls).toBe(2);

      const trainRun = await wiring.train.start({ projectId: analyzed.projectId, pmThreadId: analyzed.pmThreadId, runId: analyzed.runId!, requestId: "request-1", text: "small fix", kind: "small" });
      expect(trainRun).toBe("wf-4");
      expect(quickIdCalls).toBe(1);
      expect(prepared).toEqual(["project-late-services:lp.analyze", "project-late-services:full-lifecycle", "project-late-services:issue-quick"]);
      expect(started[2]?.workflow).toBe(composedWorkflow);
      expect(started[3]?.workflow).toBe(composedWorkflow);
      expect(preflightCalls).toBe(3);

      preflightAllowed = false;
      expect(await wiring.train.start({ projectId: analyzed.projectId, pmThreadId: analyzed.pmThreadId, runId: analyzed.runId!, requestId: "request-refused", text: "batch fix", kind: "batch" })).toBeNull();
      expect(preflightCalls).toBe(4);
      expect(started).toHaveLength(4);

      expect(await wiring.train.startProcess({ projectId: analyzed.projectId, pmThreadId: analyzed.pmThreadId, text: "build a process" })).toBe("architect-thread");
      expect(architectCalls).toEqual([{ projectId: analyzed.projectId, pmThreadId: analyzed.pmThreadId, text: "build a process" }]);
      expect(await wiring.train.findPublished({ projectId: analyzed.projectId, text: "route this" })).toBeNull();
      expect(loaded).toEqual([analyzed.projectId]);
      expect(fallbackCalls).toBe(0);
      services.workflowLibrary.loadStore = async () => { throw new Error("fixture load failure"); };
      expect(await wiring.train.findPublished({ projectId: analyzed.projectId, text: "route after load failure" })).toBeNull();
      expect(fallbackCalls).toBe(1);
      services.workflowLibrary = undefined;
      expect(await wiring.train.findPublished({ projectId: analyzed.projectId, text: "route without library" })).toBeNull();
      expect(fallbackCalls).toBe(2);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
