import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { listWorkflowFiles, runCommand, writeWorkflowFile } from "../../src/rooms/host-worker";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { ERRAND_EPISODE_TABLE } from "../../src/rooms/contracts/server";
import { listErrandEpisodeTraces } from "../../src/rooms/storage";

type Row = Record<string, unknown>;

const PROJECT = "proj-drill-repeat";
const PM_THREAD = "thr-pm-repeat";
const LP_RUN = "lprun-drill-repeat";
const BRIEF = "Reconcile AcmeCorp quarterly supplier ledger CSV and export variance report";
const WORKFLOW_ID = "acmecorp-ledger-reconcile";

const dirs: string[] = [];
let dispose: (() => Promise<void> | void) | null = null;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function createStepTracker(drillName: string) {
  let current = "init";
  return async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
    current = label;
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[drill:${drillName} step="${current}"] ${msg}`, { cause: err });
    }
  };
}

beforeEach(() => {
  vi.stubEnv("HOME", tempDir("lp-drill-repeat-home-"));
});

afterEach(async () => {
  await dispose?.();
  dispose = null;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Control Drill 1: Repeat", () => {
  it("runs graphless errand -> writes episode -> saves path -> publishes with owner grant -> routes & runs cheaper", async () => {
    const step = createStepTracker("repeat");
    const checkout = tempDir("lp-drill-repeat-ws-");
    let seq = 0;
    const threadMeta = new Map<string, { role: string; nodeId: string }>();

    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
        if (call.method === "listWorkflowFiles") return listWorkflowFiles(call.input as never, undefined as never);
        if (call.method === "writeWorkflowFile") return writeWorkflowFile(call.input as never, undefined as never);
        if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
        throw new Error(`unexpected host RPC ${call.method}`);
      }) as never,
      sdk: {
        projects: {
          list: async () => [{ id: PROJECT, name: "Drill Repeat" }],
          get: async () => ({ id: PROJECT, name: "Drill Repeat", sources: [{ hostId: "local", path: checkout }] }),
        },
        environments: {
          get: async () => ({ id: "env-repeat", hostId: "local", path: checkout, status: "ready" }),
        },
        skills: { list: async () => ({ skills: [] }) },
        plugins: { list: async () => [] },
        providers: { list: async () => [] },
        hosts: { list: async () => [{ id: "local", name: "Local", status: "connected" }] },
        files: { write: async () => ({ outcome: "written", sha256: "abc" }) },
        threads: {
          getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === PM_THREAD ? { role: "pm", lanePilotRunId: LP_RUN } : {}),
          spawn: async (args: unknown) => {
            const req = args as unknown as Row;
            const meta = (req.pluginMetadata ?? {}) as Row;
            const id = `helper-repeat-${(seq += 1)}`;
            threadMeta.set(id, {
              role: String(meta.role ?? ""),
              nodeId: String(meta.lanePilotWorkflowNode ?? meta.role ?? ""),
            });
            return { id };
          },
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            status: "idle",
            projectId: PROJECT,
            environmentId: "env-repeat",
            sourceThreadId: PM_THREAD,
            lifecycleOwnerThreadId: PM_THREAD,
          }),
          stop: async () => ({ ok: true }) as never,
          send: async () => ({}) as never,
          output: async ({ threadId }: { threadId: string }) => {
            const info = threadMeta.get(threadId);
            if (info?.nodeId === "goal-audit") {
              return {
                output: `Done.\n\`\`\`json\n${JSON.stringify({
                  verdicts: [
                    { id: "request", met: true, evidence: "output.summary produced" },
                    { id: "summary", met: true, evidence: "output.summary is a non-empty string" },
                  ],
                  handoff: "all goals verified",
                })}\n\`\`\``,
              };
            }
            if (info?.nodeId === "reconcile") {
              return {
                output: `Done.\n\`\`\`json\n${JSON.stringify({ summary: "AcmeCorp ledger reconciled via graph", handoff: "reconcile done" })}\n\`\`\``,
              };
            }
            return { output: "Reconciled AcmeCorp quarterly supplier ledger CSV.\nERRAND: done" };
          },
          events: {
            list: async ({ threadId }: { threadId: string }) => {
              const info = threadMeta.get(threadId);
              if (threadId === PM_THREAD) return [];
              const isCapturedGraph = info?.nodeId === "reconcile" || info?.nodeId === "goal-audit";
              const model = isCapturedGraph ? "claude-haiku-4-5" : "claude-opus-4-5";
              const inputTokens = isCapturedGraph ? 200 : 20_000;
              const outputTokens = isCapturedGraph ? 80 : 5_000;
              return [
                { type: "turn/started", threadId, seq: 1 },
                { type: "client/thread/start", threadId, seq: 2, createdAt: 1, data: { request: { params: { execution: { model } } } } },
                {
                  type: "thread/tokenUsage/updated",
                  threadId,
                  seq: 3,
                  createdAt: 2,
                  data: {
                    turnId: "t1",
                    tokenUsage: {
                      last: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
                      total: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
                    },
                  },
                },
                { type: "turn/completed", threadId, seq: 4, data: { status: "completed" } },
              ];
            },
          },
        },
      } as never,
    });

    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const db = openDatabase(bb);
    createRun(db, LP_RUN, PROJECT, "bb", checkout, "none", undefined, "local");
    setRunThread(db, LP_RUN, PM_THREAD);

    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: PM_THREAD, projectId: PROJECT }))) as Row;

    const waitWfDone = async (workflowRunId: string) => {
      let lastStatus: Row | null = null;
      for (let i = 0; i < 200; i += 1) {
        const status = await call("lane_pilot_workflow_status", { runId: workflowRunId });
        lastStatus = status;
        if (status.status !== "running") return status;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`workflow run ${workflowRunId} did not finish in time: ${JSON.stringify(lastStatus)}`);
    };

    const run1Start = await step("run 1 graphless errand", async () => {
      const res = await call("lane_pilot_errand", { task: BRIEF, title: "AcmeCorp ledger run 1" });
      expect(res.workflowRunId).toEqual(expect.any(String));
      const status = await waitWfDone(String(res.workflowRunId));
      expect(status.status).toBe("succeeded");
      expect(status.workflow).toBe("errand");
      return String(res.workflowRunId);
    });

    await step("verify run 1 episode and cost recorded", async () => {
      await vi.waitFor(() => {
        const traces = listErrandEpisodeTraces(db, [run1Start]);
        expect(traces.has(run1Start)).toBe(true);
      });
      const ep = db.prepare(`SELECT workflow_id, status, outcome FROM ${ERRAND_EPISODE_TABLE} WHERE run_id = ?`).get(run1Start) as Row;
      expect(ep).toMatchObject({ workflow_id: "errand", status: "succeeded", outcome: "done" });
      const run1Row = db.prepare("SELECT cost_micro_usd FROM lane_pilot_wf_run WHERE id = ?").get(run1Start) as { cost_micro_usd: number };
      expect(run1Row.cost_micro_usd).toBeGreaterThan(0);
    });

    await step("run 2 graphless errand", async () => {
      const res = await call("lane_pilot_errand", { task: `${BRIEF} (repeat check)`, title: "AcmeCorp ledger run 2" });
      const status = await waitWfDone(String(res.workflowRunId));
      expect(status.status).toBe("succeeded");
      expect(status.workflow).toBe("errand");
    });

    const draftId = await step("owner marks save this path -> draft", async () => {
      const saved = await call("lane_pilot_path_save", {
        runId: run1Start,
        note: "Parameterize AcmeCorp ledger reconciliation into a fast graph",
      });
      expect(saved).toEqual({ ok: true, draftId: expect.any(String) });
      const detail = await call("lane_pilot_workflow_draft_get", { draftId: String(saved.draftId) });
      expect(detail.draft).toMatchObject({ status: "draft" });
      expect(detail.metadata).toMatchObject({ source: "path-capture", sourceRunIds: [run1Start] });
      return String(saved.draftId);
    });

    await step("patch and test draft", async () => {
      const patched = await call("lane_pilot_workflow_draft_patch", {
        draftId,
        ops: [
          {
            op: "set_meta",
            set: {
              id: WORKFLOW_ID,
              name: { en: "AcmeCorp supplier ledger reconcile", ru: "Сверка реестра поставщиков AcmeCorp" },
              description: {
                en: "Reconcile AcmeCorp quarterly supplier ledger CSV and export variance report",
                ru: "Сверка квартального реестра AcmeCorp CSV и экспорт отчёта отклонений",
              },
              tags: ["acmecorp", "supplier", "ledger", "reconcile", "csv", "variance"],
              examples: { en: [BRIEF], ru: [] },
              inputs: [
                { name: "goal", type: "string", default: "" },
                { name: "task", type: "string", default: "" },
              ],
              outputs: [{ name: "summary", type: "string" }],
            },
          },
          {
            op: "add_node",
            node: {
              id: "reconcile",
              type: "agent",
              role: "analyst",
              effect: "R",
              prompt: "Reconcile AcmeCorp supplier ledger CSV: {{$inputs.goal}}",
              out: [{ name: "summary", type: "string" }],
            },
          },
          {
            op: "add_node",
            node: {
              id: "done",
              type: "action",
              action: "emit",
              map: { summary: "reconcile.summary" },
            },
          },
          { op: "add_edge", edge: { from: "start", to: "reconcile" } },
          { op: "add_edge", edge: { from: "reconcile", to: "done" } },
        ],
      });
      expect(patched).toMatchObject({ ok: true, valid: true, errors: 0 });
      const tested = await call("lane_pilot_workflow_draft_test", { draftId });
      expect(tested, JSON.stringify(tested)).toMatchObject({ ran: true, green: true, status: "tested" });
    });

    await step("owner grant -> published", async () => {
      const ungranted = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
      expect(ungranted).toMatchObject({ published: false, reason: "no_publish_authority" });

      const ask = harness.behavior.callAgentTool(
        "lane_pilot_ask_owner",
        { question: `Publish workflow ${WORKFLOW_ID}?`, options: ["Publish", "Cancel"] },
        { threadId: PM_THREAD, projectId: PROJECT },
      );
      await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
      harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { choice: "1" });
      await ask;

      const pub = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
      expect(pub).toMatchObject({ published: true, workflowId: WORKFLOW_ID, workflowVersion: 1, scope: "project" });
    });

    await step("run 3 routes to published graph and costs less than run 1", async () => {
      const routed = await call("lane_pilot_route", { intent: BRIEF });
      expect(routed).toMatchObject({ decision: "route", workflowId: WORKFLOW_ID });

      const started = await call("lane_pilot_run_workflow", {
        workflowId: String(routed.workflowId),
        inputs: (routed.inputs as Record<string, unknown>) ?? { goal: BRIEF },
        ...(Array.isArray(routed.goals) && routed.goals.length ? { goals: routed.goals } : {}),
        ...(routed.notYetRunLive === true ? { liveTrial: true } : {}),
      });
      expect(started.workflow, JSON.stringify(started)).toBe(WORKFLOW_ID);

      const run3Id = String(started.workflowRunId);
      const status3 = await waitWfDone(run3Id);
      expect(status3.status).toBe("succeeded");
      expect(status3.workflow).toBe(WORKFLOW_ID);

      const run1Cost = (db.prepare("SELECT cost_micro_usd FROM lane_pilot_wf_run WHERE id = ?").get(run1Start) as { cost_micro_usd: number }).cost_micro_usd;
      const run3Cost = (db.prepare("SELECT cost_micro_usd FROM lane_pilot_wf_run WHERE id = ?").get(run3Id) as { cost_micro_usd: number }).cost_micro_usd;
      expect(run3Cost).toBeGreaterThan(0);
      expect(run3Cost).toBeLessThan(run1Cost);
    });
  });
});
