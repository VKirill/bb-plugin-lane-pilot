import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createWorkflowCatalog, validateWorkflow } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/storage/database";
import { createWorkflowLibrary } from "../../src/rooms/workflow/server/workflow-library";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/workflow-triggers";
import { engineOn, journalDb, ok, trust, wf } from "./engine-helpers";
import { workflow } from "./fixtures";

// The 2026-10-29 full-code audit (Аудит GPT), probes A-011 and A-012, kept as regressions.
it("runs the child definition the chain started with, although the catalog changed while the parent waited", async () => {
  const db = journalDb();
  const leaf = (version: number) => wf({ id: "leaf", version, nodes: [{ id: "write", type: "action", action: `write${version}`, output: [{ name: "text", type: "string" }] }],
    edges: [{ from: "start", to: "write" }, { from: "write", to: "end", with: { result: "write.text" } }] });
  let catalog = leaf(1);
  const parent = wf({ id: "parent", nodes: [{ id: "wait", type: "action", action: "wait", output: [{ name: "text", type: "string" }] }, { id: "call", type: "subworkflow", workflow: "leaf", inputs: { query: "$inputs.query" } }],
    edges: [{ from: "start", to: "wait" }, { from: "wait", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }] });
  const engine = engineOn(db, { wait: { reentrant: true, run: async () => ({ wait: { kind: "external" } }) }, write1: ok(() => ({ text: "version-one" })), write2: ok(() => ({ text: "version-two" })) },
    { resolveWorkflow: (id) => (id === "leaf" ? catalog : null) });
  try {
    const run = engine.start({ workflow: parent, inputs: { query: "q" } });
    expect((await run.done).status).toBe("waiting");
    catalog = leaf(2);
    const step = engine.snapshot(run.runId)!.steps.find((row) => row.state === "waiting")!;
    await engine.resolve(run.runId, step.step_key, { text: "continue" });
    await engine.idle();
    expect(engine.get(run.runId)).toMatchObject({ status: "succeeded", output: { result: "version-one" } });
  } finally { engine.dispose(); db.close(); }
});

it("starts a project workflow whose child lives only in the project's library", async () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const child = workflow({ id: "audit-project-child", status: "tested", internal: true, nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.query" } }], edges: [{ from: "start", to: "done" }] });
  const parent = workflow({ id: "audit-project-parent", status: "tested", nodes: [{ id: "call", type: "subworkflow", workflow: "audit-project-child", inputs: { query: "$inputs.query" } }],
    edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }] });
  trust(db, child); trust(db, parent);
  const catalog = createWorkflowCatalog({ builtin: [], globalDir: null });
  await catalog.store();
  const engine = engineOn(db, {}, { resolveWorkflow: (id, version) => catalog.peek()?.resolve(id, version) ?? null });
  const ctx = { bb, db, log: () => {}, host: { call: async () => ({ hostId: "h", files: [{ path: "parent.json", content: JSON.stringify(parent) }, { path: "child.json", content: JSON.stringify(child) }] }) } };
  const services = { workflowEngine: engine, workflowCatalog: catalog, docsPlaces: async () => [{ hostId: "h", path: "/fixture", scopes: [], name: "fixture" }] };
  try {
    const library = createWorkflowLibrary(ctx as never, services as never, { globalDir: "/audit-fixture-does-not-exist" });
    const { store } = await library.loadStore("p");
    expect(validateWorkflow(store.get("audit-project-parent")!.workflow, { resolve: store.resolve }).filter((problem) => problem.level === "error")).toEqual([]);
    const triggers = createWorkflowTriggers(ctx as never, services as never, { loadStore: library.loadStore });
    const result = await triggers.start({ projectId: "p", workflowId: "audit-project-parent", source: "manual", inputs: { query: "q" }, liveTrial: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await engine.idle();
    expect(engine.get((result as { runId: string }).runId)).toMatchObject({ status: "succeeded", output: { result: "q" } });
  } finally { engine.dispose(); db.close(); }
});
