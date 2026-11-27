import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID, PATHS_BRANCH_DRAFT_REPEATS_KEY } from "@lane-pilot/settings-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { listWorkflowFiles, runCommand, writeWorkflowFile } from "../../src/rooms/host-worker";
import { listRoad } from "../../src/rooms/lead/server";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../../src/rooms/plugin-db";
import { composeReviewDesk, runDeskCli } from "../../src/rooms/reports/server";
import { TRAJECTORY_DELTA_TABLE } from "../../src/rooms/errands";

type Row = Record<string, unknown>;

const PROJECT = "proj-drill-var";
const PM_THREAD = "thr-pm-var";
const LP_RUN = "lprun-drill-var";
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
  vi.stubEnv("HOME", tempDir("lp-drill-var-home-"));
  vi.stubEnv("BB_CLI", "/usr/bin/false");
});

afterEach(async () => {
  await dispose?.();
  dispose = null;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Control Drill 2: Variation", () => {
  it("records deviations on runs 1-2 -> surfaces branch candidate on road & desk -> opens branch draft with decision -> publishes v2 -> run 3 follows branch", async () => {
    const step = createStepTracker("variation");
    const checkout = tempDir("lp-drill-var-ws-");
    let seq = 0;
    const threadMeta = new Map<string, { nodeId: string }>();

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
          list: async () => [{ id: PROJECT, name: "Drill Variation" }],
          get: async () => ({ id: PROJECT, name: "Drill Variation", sources: [{ hostId: "local", path: checkout }] }),
        },
        environments: {
          get: async () => ({ id: "env-var", hostId: "local", path: checkout, status: "ready" }),
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
            const id = `helper-var-${(seq += 1)}`;
            threadMeta.set(id, { nodeId: String(meta.lanePilotWorkflowNode ?? meta.role ?? "") });
            return { id };
          },
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            status: "idle",
            projectId: PROJECT,
            environmentId: "env-var",
            sourceThreadId: PM_THREAD,
            lifecycleOwnerThreadId: PM_THREAD,
          }),
          stop: async () => ({ ok: true }) as never,
          send: async () => ({}) as never,
          output: async ({ threadId }: { threadId: string }) => {
            const nodeId = threadMeta.get(threadId)?.nodeId ?? "reconcile";
            if (nodeId === "think") {
              return {
                output: `Done.\n\`\`\`json\n${JSON.stringify({
                  summary: "Checked hub snapshot.",
                  branches: [],
                  proposals: [],
                  deferred: "",
                  status: "done",
                  handoff: "lead tick finished",
                })}\n\`\`\``,
              };
            }
            const summary = nodeId === "fast_track" ? "fast_branch_ok" : "standard_ok";
            return {
              output: `Done.\n\`\`\`json\n${JSON.stringify({ summary, handoff: `${nodeId} done` })}\n\`\`\``,
            };
          },
          events: {
            list: async ({ threadId }: { threadId: string }) =>
              threadId === PM_THREAD
                ? []
                : [
                    { type: "turn/started", threadId, seq: 1 },
                    { type: "client/thread/start", threadId, seq: 2, createdAt: 1, data: { request: { params: { execution: { model: "claude-haiku-4-5" } } } } },
                    {
                      type: "thread/tokenUsage/updated",
                      threadId,
                      seq: 3,
                      createdAt: 2,
                      data: {
                        turnId: "t1",
                        tokenUsage: {
                          last: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                          total: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                        },
                      },
                    },
                    { type: "turn/completed", threadId, seq: 4, data: { status: "completed" } },
                  ],
          },
        },
      } as never,
    });

    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const db = openDatabase(bb);
    createRun(db, LP_RUN, PROJECT, "bb", checkout, "none", undefined, "local");
    setRunThread(db, LP_RUN, PM_THREAD);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, PATHS_BRANCH_DRAFT_REPEATS_KEY, 2);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "lead.enabled", true);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "loops.mode", { discovery: "on" });
    saveProjectSetting(db, PROJECT, "loops.mode", { discovery: "on" });

    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: PM_THREAD, projectId: PROJECT }))) as Row;

    const waitWfDone = async (workflowRunId: string) => {
      let lastStatus: Row | null = null;
      for (let i = 0; i < 400; i += 1) {
        const status = await call("lane_pilot_workflow_status", { runId: workflowRunId });
        lastStatus = status;
        if (status.status !== "running") return status;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`workflow run ${workflowRunId} did not finish in time: ${JSON.stringify(lastStatus)}`);
    };

    const approvePublish = async (question: string) => {
      const ask = harness.behavior.callAgentTool(
        "lane_pilot_ask_owner",
        { question, options: ["Publish", "Cancel"] },
        { threadId: PM_THREAD, projectId: PROJECT },
      );
      await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
      harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { choice: "1" });
      await ask;
    };

    await step("publish base v1 graph from drill 1", async () => {
      const created = await call("lane_pilot_workflow_draft_create", {
        name: { en: "AcmeCorp supplier ledger reconcile", ru: "Сверка реестра AcmeCorp" },
        description: { en: "Reconcile AcmeCorp quarterly supplier ledger CSV", ru: "Сверка реестра AcmeCorp" },
        scope: "project",
        workflowId: WORKFLOW_ID,
      });
      const draftId = String(created.draftId);
      await call("lane_pilot_workflow_draft_patch", {
        draftId,
        ops: [
          {
            op: "set_meta",
            set: {
              inputs: [
                { name: "goal", type: "string", required: true },
                { name: "expedite", type: "boolean", default: false },
                { name: "threadId", type: "string", required: false },
              ],
              outputs: [{ name: "summary", type: "string" }],
              test: {
                id: "v1-smoke",
                sim: {
                  input: { goal: "Reconcile Q1", expedite: false },
                  stubs: { reconcile: { summary: "standard_ok", handoff: "reconcile done" } },
                  expect_path: ["reconcile", "done"],
                  expect_output: { summary: "standard_ok" },
                },
              },
            },
          },
          {
            op: "add_node",
            node: {
              id: "reconcile",
              type: "agent",
              role: "analyst",
              effect: "R",
              prompt: "Standard ledger reconcile: {{$inputs.goal}}",
              out: [{ name: "summary", type: "string" }],
            },
          },
          { op: "add_node", node: { id: "done", type: "action", action: "emit", map: { summary: "reconcile.summary" } } },
          { op: "add_edge", edge: { from: "start", to: "reconcile" } },
          { op: "add_edge", edge: { from: "reconcile", to: "done" } },
        ],
      });
      expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
      await approvePublish(`Publish workflow ${WORKFLOW_ID}?`);
      const pub = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
      expect(pub).toMatchObject({ published: true, workflowId: WORKFLOW_ID, workflowVersion: 1 });
    });

    await step("run 1 with new condition records deviation 1 (below threshold -> no road candidate yet)", async () => {
      const r1 = await call("lane_pilot_run_workflow", {
        workflowId: WORKFLOW_ID,
        inputs: { goal: "Expedite urgent Q1 supplier ledger", expedite: true, threadId: PM_THREAD },
      });
      const r1Id = String(r1.workflowRunId);
      expect((await waitWfDone(r1Id)).status).toBe("succeeded");

      await call("lane_pilot_workflow_amend", {
        runId: r1Id,
        reason: "Expedite urgent supplier ledger: skip secondary audit",
        rerun: { nodeId: "reconcile" },
      });
      expect((await waitWfDone(r1Id)).status).toBe("succeeded");

      const deltas = db.prepare(`SELECT workflow_id, intervention_kind FROM ${TRAJECTORY_DELTA_TABLE} WHERE project_id = ?`).all(PROJECT) as Row[];
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ workflow_id: WORKFLOW_ID, intervention_kind: "step_inserted" });

      const lt1 = await call("lane_pilot_run_workflow", {
        workflowId: "lead-tick",
        inputs: { projectId: PROJECT, tickId: "tick_var_1", trigger: "manual" },
      });
      const lt1Status = await waitWfDone(String(lt1.workflowRunId));
      expect(lt1Status.status, JSON.stringify(lt1Status)).toBe("succeeded");
      const branchRoads = listRoad(db, { projectId: PROJECT }).filter((row) => row.class === "branch");
      expect(branchRoads).toHaveLength(0);
    });

    const branchCandidate = await step("run 2 records deviation 2 -> hits threshold -> branch candidate appears on lead road and desk", async () => {
      const r2 = await call("lane_pilot_run_workflow", {
        workflowId: WORKFLOW_ID,
        inputs: { goal: "Expedite urgent Q2 supplier ledger", expedite: true, threadId: PM_THREAD },
      });
      const r2Id = String(r2.workflowRunId);
      expect((await waitWfDone(r2Id)).status).toBe("succeeded");

      await call("lane_pilot_workflow_amend", {
        runId: r2Id,
        reason: "Expedite urgent supplier ledger: skip secondary audit",
        rerun: { nodeId: "reconcile" },
      });
      expect((await waitWfDone(r2Id)).status).toBe("succeeded");

      const deltas = db.prepare(`SELECT workflow_id FROM ${TRAJECTORY_DELTA_TABLE} WHERE project_id = ?`).all(PROJECT) as Row[];
      expect(deltas).toHaveLength(2);

      const lt2 = await call("lane_pilot_run_workflow", {
        workflowId: "lead-tick",
        inputs: { projectId: PROJECT, tickId: "tick_var_2", trigger: "manual" },
      });
      const lt2Status = await waitWfDone(String(lt2.workflowRunId));
      expect(lt2Status.status, JSON.stringify(lt2Status)).toBe("succeeded");
      const branchRoads = listRoad(db, { projectId: PROJECT, state: "proposed" }).filter((row) => row.class === "branch");
      expect(branchRoads).toHaveLength(1);
      const road = branchRoads[0]!;
      const payload = JSON.parse(road.payload_json ?? "{}") as { key: string; graphId: string; count: number };
      expect(payload).toMatchObject({ graphId: WORKFLOW_ID, count: 2 });

      const desk = composeReviewDesk(db);
      const deskItem = desk.items.find((item) => item.id === `road:${road.id}`);
      expect(deskItem).toBeDefined();
      expect(deskItem?.section).toBe("candidates");
      expect(deskItem?.options).toContain("save as draft");

      const cliShow = await runDeskCli({ db, bb } as never, undefined, ["show", "--json"]);
      expect(cliShow.exitCode).toBe(0);
      const parsedShow = JSON.parse(cliShow.stdout ?? "{}") as { items: Array<{ id: string }> };
      expect(parsedShow.items.some((item) => item.id === `road:${road.id}`)).toBe(true);

      return { roadId: road.id, candidateKey: payload.key };
    });

    const branchDraftId = await step("save branch draft with decision node and pass tests", async () => {
      const saved = await call("lane_pilot_path_save", {
        branch: { graphId: WORKFLOW_ID, candidateKey: branchCandidate.candidateKey },
        note: "Route expedite=true to fast_track branch",
      });
      expect(saved).toEqual({ ok: true, draftId: expect.any(String) });
      const draftId = String(saved.draftId);
      const detail = await call("lane_pilot_workflow_draft_get", { draftId });
      expect(detail.metadata).toMatchObject({ source: "branch-capture", branchOf: WORKFLOW_ID });

      const patched = await call("lane_pilot_workflow_draft_patch", {
        draftId,
        ops: [
          { op: "remove_edge", edge: { from: "start", to: "reconcile" } },
          { op: "add_node", node: { id: "expedite_gate", type: "decision", uses: "builtin:decision" } },
          {
            op: "add_node",
            node: {
              id: "fast_track",
              type: "agent",
              role: "analyst",
              effect: "R",
              prompt: "Fast-track expedited ledger reconcile: {{$inputs.goal}}",
              out: [{ name: "summary", type: "string" }],
            },
          },
          {
            op: "add_node",
            node: {
              id: "done_fast",
              type: "action",
              action: "emit",
              map: { summary: "fast_track.summary" },
            },
          },
          { op: "add_edge", edge: { from: "start", to: "expedite_gate" } },
          { op: "add_edge", edge: { from: "expedite_gate", to: "fast_track", when: "$inputs.expedite == true" } },
          { op: "add_edge", edge: { from: "expedite_gate", to: "reconcile" } },
          { op: "add_edge", edge: { from: "fast_track", to: "done_fast" } },
        ],
      });
      expect(patched, JSON.stringify(patched)).toMatchObject({ ok: true, valid: true, errors: 0 });
      const ownerUpdated = await harness.behavior.callRpc("workflow_draft_patch", {
        draftId,
        ops: [
          {
            op: "set_meta",
            set: {
              test: {
                id: "v2-branch-smoke",
                sim: {
                  input: { goal: "Reconcile Q1", expedite: false },
                  stubs: {
                    reconcile: { summary: "standard_ok", handoff: "reconcile done" },
                    fast_track: { summary: "fast_branch_ok", handoff: "fast_track done" },
                  },
                  expect_path: ["expedite_gate", "reconcile", "done"],
                  expect_output: { summary: "standard_ok" },
                  variant_expedite: {
                    input: { goal: "Expedite urgent Q3", expedite: true },
                    expect_path: ["expedite_gate", "fast_track", "done_fast"],
                    expect_output: { summary: "fast_branch_ok" },
                  },
                },
              },
            },
          },
        ],
      }) as Row;
      expect(ownerUpdated).toMatchObject({ ok: true, valid: true, errors: 0 });
      const tested = await call("lane_pilot_workflow_draft_test", { draftId });
      expect(tested, JSON.stringify(tested)).toMatchObject({ ran: true, green: true, allCasesRun: true, status: "tested" });
      return draftId;
    });

    await step("owner grant -> publish version +1", async () => {
      await approvePublish(`Publish v2 of ${WORKFLOW_ID}?`);
      const pub = await call("lane_pilot_workflow_draft_publish", { draftId: branchDraftId, confirm: true });
      expect(pub, JSON.stringify(pub)).toMatchObject({ published: true, workflowId: WORKFLOW_ID, workflowVersion: 2 });
    });

    await step("run 3 with the new condition follows the branch", async () => {
      const r3 = await call("lane_pilot_run_workflow", {
        workflowId: WORKFLOW_ID,
        inputs: { goal: "Expedite urgent Q3 supplier ledger", expedite: true, threadId: PM_THREAD },
      });
      const r3Id = String(r3.workflowRunId);
      expect((await waitWfDone(r3Id)).status).toBe("succeeded");
      const nodes = (db.prepare("SELECT node_id, graph_version FROM lane_pilot_wf_step WHERE run_id = ?").all(r3Id) as Row[]);
      const ids = nodes.map((row) => String(row.node_id));
      expect(ids).toEqual(expect.arrayContaining(["expedite_gate", "fast_track"]));
      expect(ids).not.toContain("reconcile");
      expect(nodes.every((row) => row.graph_version === null || Number(row.graph_version) === 2)).toBe(true);
    });
  });
});
