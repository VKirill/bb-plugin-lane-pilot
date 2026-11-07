import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, loadWorkflowStore, registerPureActions, setRouterModel } from "@lane-pilot/workflow-engine";
import { createRun, openDatabase, setRunThread } from "../src/rooms/plugin-db";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { mountErrands } from "../src/rooms/qa/server/errands";

/**
 * The errand's self-route (errand-graph.ts routedGraph): a brief the router matches surely to an offered graph starts that graph's
 * run instead of a plain errand; a plain errand records the router's answer in its inputs (routeTop, routeWhy). The catalog is a stub:
 * two small workflows built like the router tests' ones, so the scores do not depend on the live catalog.
 */
const PROJECT = "proj-1";
const PM = "pm-1";
const RUN = "lprun-1";
const TASK = "Send the November invoice to Acme Corp.";

/** A small workflow definition in the workflows/*.json shape; loadWorkflowStore parses it like a shipped one. */
const stub = (extra: Record<string, unknown>) => ({
  schemaVersion: 1, id: "stub-graph", name: { en: "Stub graph", ru: "Тестовый граф" },
  description: { en: "Sends the invoice the owner asks for", ru: "Отправляет счёт, о котором просит владелец" },
  status: "published",
  tags: ["invoice"],
  examples: { en: [TASK], ru: [] },
  inputs: [{ name: "goal", type: "string" }],
  outputs: [{ name: "result", type: "string" }],
  nodes: [{ id: "work", type: "action", action: "noop", output: [{ name: "result", type: "string" }] }],
  edges: [
    { from: "start", to: "work", with: { goal: "input.goal" } },
    { from: "work", to: "end", with: { result: "work.result" } },
  ],
  ...extra,
});

const sources = (...defs: Array<Record<string, unknown>>) => defs.map((value, i) => ({ name: `stub-${i}.json`, value }));

function world(catalog: Array<Record<string, unknown>> = [stub({ id: "invoice-send" })]) {
  const state = { output: "Done.\nERRAND: done", status: "", spawned: [] as Array<Record<string, unknown>>, disposed: false };
  const sdk = {
    providers: { list: async () => [] },
    projects: { get: async () => ({ sources: [{ hostId: "host-1", path: "/proj" }] }) },
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-1" }),
      getPluginMetadata: async () => ({}),
      spawn: async (args: unknown) => { state.spawned.push(args as Record<string, unknown>); return { id: `errand-thr-${state.spawned.length}` }; },
      stop: async () => undefined,
      output: async () => ({ output: state.output }),
      events: { list: async () => [{ type: "turn/started", threadId: "t", seq: 1 }] },
    },
    environments: { get: async () => ({ id: "env-1", path: "/checkout", hostId: "host-1" }) },
  } as never;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "cli", "/checkout");
  setRunThread(db, RUN, PM);
  const host = { call: async () => ({ hostId: "host-1", exitCode: 0, stdout: "", stderr: "" }) };
  const secrets = { check: async () => ({ missing: [], denied: [], wrongKind: [], unavailable: false, catalog: [] }), record: async () => undefined };
  const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: (id) => builtinWorkflow(id) });
  registerPureActions(engine);
  // The stub graph's one action, like the api-recon "agent" executor of the errand tests: started, never answering.
  engine.register("noop", { reentrant: true, run: () => new Promise(() => undefined) } as never);
  const ready = loadWorkflowStore({ builtin: sources(...catalog) });
  const ctx = { bb, db, host, secrets, isDisposed: () => state.disposed, log: () => undefined } as never;
  const services = { workflowEngine: engine, workflowCatalog: { store: async () => ready } } as never;
  mountErrands(ctx, services);
  const call = async (name: string, params: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: PM, projectId: PROJECT }))) as Record<string, any>;
  const runs = () => db.prepare("SELECT id, workflow_id, inputs_json FROM lane_pilot_wf_run").all() as Array<{ id: string; workflow_id: string; inputs_json: string }>;
  const inputsOf = () => JSON.parse(runs()[0]!.inputs_json) as Record<string, unknown>;
  return { state, call, runs, inputsOf };
}

afterEach(() => setRouterModel(null));

describe("the errand routes its brief to a sure graph", () => {
  it("a brief that routes at >= 90 to a published graph starts that graph's run and no errand run, and says the graph and the confidence", async () => {
    const w = world();
    setRouterModel(async () => ({ choice: "invoice-send", confidence: 95, pattern: "invoice", rejected: [], questions: [] }));
    const answer = await w.call("lane_pilot_errand", { task: TASK });
    expect(answer).toMatchObject({ workflowRunId: expect.stringMatching(/^wfrun_/), state: "running", workflow: "invoice-send", confidence: 95 });
    expect(answer.note).toContain("lane_pilot_workflow_status");
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "invoice-send" })]);
    expect(w.inputsOf()).toMatchObject({ goal: TASK });
    expect(w.state.spawned).toEqual([]);
  });

  it("a tested graph is its first real run: the errand starts it with liveTrial, the way lane_pilot_run_workflow's tested branch does", async () => {
    const w = world([stub({ id: "invoice-send", status: "tested" })]);
    setRouterModel(async () => ({ choice: "invoice-send", confidence: 95, pattern: "invoice", rejected: [], questions: [] }));
    const answer = await w.call("lane_pilot_errand", { task: TASK });
    expect(answer).toMatchObject({ workflow: "invoice-send", state: "running" });
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "invoice-send" })]);
  });

  it("a route under 90 stays a plain errand with routeTop <id>:<confidence> and routeWhy below_confidence on its inputs", async () => {
    const w = world();
    setRouterModel(async () => ({ choice: "invoice-send", confidence: 70, pattern: "unsure", rejected: [], questions: [] }));
    const answer = await w.call("lane_pilot_errand", { task: TASK });
    expect(answer).not.toHaveProperty("workflow");
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "errand" })]);
    expect(w.inputsOf()).toMatchObject({ routeTop: "invoice-send:70", routeWhy: "below_confidence" });
  });

  it("a sure route whose required input the brief cannot fill stays a plain errand with routeWhy missing_inputs:<name>", async () => {
    const w = world([stub({ id: "invoice-send", inputs: [{ name: "goal", type: "string" }, { name: "recipient", type: "string", required: true }] })]);
    setRouterModel(async () => ({ choice: "invoice-send", confidence: 95, pattern: "invoice", rejected: [], questions: [] }));
    const answer = await w.call("lane_pilot_errand", { task: TASK });
    expect(answer).not.toHaveProperty("workflow");
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "errand" })]);
    expect(w.inputsOf()).toMatchObject({ routeTop: "invoice-send:95", routeWhy: "missing_inputs:recipient" });
  });

  it("a brief with authorized: true routes only to a published graph, never to a tested one (routeWhy tested_needs_unauthorized)", async () => {
    const w = world([stub({ id: "invoice-send", status: "tested" })]);
    setRouterModel(async () => ({ choice: "invoice-send", confidence: 95, pattern: "invoice", rejected: [], questions: [] }));
    const answer = await w.call("lane_pilot_errand", { task: TASK, authorized: true });
    expect(answer).not.toHaveProperty("workflow");
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "errand" })]);
    expect(w.inputsOf()).toMatchObject({ routeWhy: "tested_needs_unauthorized" });
  });
});
