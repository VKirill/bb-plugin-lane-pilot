/** @vitest-environment jsdom */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "../i18n";
import { migrations } from "../src/database";
import { createWorkflowArchitect } from "../src/server/workflow-architect";
import type { ArchitectDeps } from "../src/server/workflow-architect";
import type { ServerCore } from "../src/server/core";
import type { Services } from "../src/server/services";
import { connectOps, insertAfterOps, newNode, problemMaps, readWhen, viewEdgeIndexes, writeWhen, whenError, expressionError, uniqueId } from "../src/ui/workflow-edit-model";
import { draftView } from "../src/workflow/draft-view";
import { BROWSER_DIGEST_STEPS } from "./workflow/architect-fixture";

// The graph pulls in xyflow and elkjs on first use; a cold import under load can pass the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  class Matrix { m22 = 1; m41 = 0; m42 = 0; constructor(_init?: string) {} }
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
});
afterEach(() => { cleanup(); setLocaleOverride(null); });

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const projectId = "proj_ed";

/** The real architect (drafts, validator, tests, publish) over a real database; the screen talks to its RPCs. */
async function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const globalDir = await mkdtemp(join(tmpdir(), "lp-edit-ui-"));
  dirs.push(globalDir);
  const signals: Array<{ draftId?: string }> = [];
  const emit: { current: ((payload: unknown) => Promise<unknown>) | null } = { current: null };
  const ctx = { db, log: () => undefined, realtime: { notify: (_project: string, kind: string, threadId?: string, draftId?: string) => { signals.push({ draftId }); void emit.current?.({ kind, ...(draftId ? { draftId } : {}), ...(threadId ? { threadId } : {}) }); } } } as unknown as ServerCore;
  const deps: ArchitectDeps = {
    globalDir: () => globalDir, projectPlace: async () => null, writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "no machine" }), hasExecutor: () => true,
    capabilityPorts: () => ({
      skills: async () => [{ name: "browser-automation", description: "Drive a browser" }, { name: "telegram-user" }], plugins: async () => [{ id: "browser-automation", name: "Browser Automation" }],
      mcpServers: async () => [{ name: "tavily" }], secrets: async () => [{ name: "TELEGRAM_SESSION", kind: "secret" }], hosts: async () => [{ id: "host_1", name: "MacBook", connected: false }], specialists: ["design-lead"],
    }),
  };
  const architect = createWorkflowArchitect(ctx, { workflowEngine: null } as unknown as Pick<Services, "workflowEngine">, deps);
  const draft = architect.drafts.create({ projectId, threadId: null, scope: "global", name: "Browser digest", description: "Search, summarise and send" });
  for (const ops of BROWSER_DIGEST_STEPS) architect.drafts.patch(draft.id, ops);
  const calls: Array<{ method: string; input: unknown }> = [];
  const track = <T extends (input: never) => unknown>(method: string, handler: T) => (input: unknown) => { calls.push({ method, input }); return handler(input as never); };
  const rpc = {
    get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
    workflow_list: () => ({ workflows: [{ id: "analyze-plan-execute", name: { en: "Analyze", ru: "Анализ" } }], problems: [], project: "not_requested" }),
    workflow_draft_list: architect.rpc.workflow_draft_list,
    workflow_draft_get: architect.rpc.workflow_draft_get,
    workflow_draft_patch: track("workflow_draft_patch", architect.rpc.workflow_draft_patch),
    workflow_draft_restore: track("workflow_draft_restore", architect.rpc.workflow_draft_restore),
    workflow_draft_test: track("workflow_draft_test", architect.rpc.workflow_draft_test),
    workflow_draft_publish: track("workflow_draft_publish", architect.rpc.workflow_draft_publish),
    workflow_capabilities: architect.rpc.workflow_capabilities,
  };
  return { architect, draftId: draft.id, rpc, calls, emit, signals };
}

async function open(extra: Record<string, unknown> = {}, options: { editing?: boolean } = {}) {
  const w = await world();
  await loadPluginApp(() => import("../app"));
  const { WorkflowDraftDetail } = await import("../src/ui/workflow-draft-detail");
  const slot = await renderSlot({ component: () => <WorkflowDraftDetail draftId={w.draftId} projectId={projectId} locale="en" onBack={() => undefined} startEditing={options.editing ?? true} /> }, {},
    { context: { projectId, threadId: null }, rpc: { ...w.rpc, ...extra } as never });
  w.emit.current = (payload) => slot.behavior.emitRealtime(`lp:${projectId}`, payload);
  if (options.editing ?? true) await slot.findByTestId("wf-edit-toolbar");
  await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
  return { ...w, slot };
}

const patches = (calls: Array<{ method: string; input: unknown }>) => calls.filter((call) => call.method === "workflow_draft_patch").map((call) => call.input as { ops: Array<Record<string, unknown>>; expectedVersion: number });
const edgeLabel = (container: HTMLElement, includes: string) => Array.from(container.querySelectorAll<HTMLElement>("[data-testid^='wf-edge-']")).find((element) => element.textContent?.includes(includes))!;

describe("the editor model", () => {
  const draft = {
    inputs: [{ name: "query", type: "string" }],
    nodes: [
      { id: "search", type: "agent", out: { status: "done|blocked", sources: "string[]" } },
      { id: "analyze", type: "agent", out: [{ name: "findings", type: "array" }] },
      { id: "end-note", type: "note", text: "n" },
    ],
    edges: [{ from: "start", to: "search" }, { from: "search", to: "analyze", with: { s: "search.sources" } }],
  };

  it("puts a new step between a step and its only way out, carrying the same inputs", () => {
    const node = newNode(draft, "agent");
    expect(node).toMatchObject({ id: "agent", type: "agent" });
    expect(uniqueId(draft, "search")).toBe("search-2");
    expect(insertAfterOps(draft, "search", node)).toEqual([
      { op: "add_node", node },
      { op: "update_edge", edge: { index: 1 }, set: { to: "agent" } },
      { op: "add_edge", edge: { from: "agent", to: "analyze", with: { s: "search.sources" } } },
    ]);
    // After a step with no or several ways out it is only joined; a note takes no edge; from the toolbar of an empty draft it follows the start.
    expect(insertAfterOps(draft, "analyze", node).at(-1)).toEqual({ op: "add_edge", edge: { from: "analyze", to: "agent" } });
    expect(insertAfterOps(draft, "$start", node)[1]).toMatchObject({ op: "update_edge", edge: { index: 0 }, set: { to: "agent" } });
    expect(insertAfterOps(draft, "search", newNode(draft, "note"))).toHaveLength(1);
    expect(insertAfterOps({ nodes: [], edges: [] }, null, node).at(-1)).toEqual({ op: "add_edge", edge: { from: "start", to: "agent" } });
    expect(newNode(draft, "decision", { after: "search" })).toMatchObject({ reads_node: "search" });
  });

  it("refuses an edge the file cannot hold, and joins the ends under their file names", () => {
    expect(connectOps(draft, "$start", "analyze")).toEqual({ ops: [{ op: "add_edge", edge: { from: "start", to: "analyze" } }] });
    expect(connectOps(draft, "$end", "search")).toMatchObject({ error: { key: "wfEditErr_fromEnd" } });
    expect(connectOps(draft, "search", "$start")).toMatchObject({ error: { key: "wfEditErr_toStart" } });
    expect(connectOps(draft, "search", "end-note")).toMatchObject({ error: { key: "wfEditErr_noteEdge" } });
    expect(connectOps(draft, "search", "analyze")).toMatchObject({ error: { key: "wfEditErr_duplicateEdge" } });
  });

  it("builds a condition from the source's declared fields and refuses an unknown one, with the enum's values", () => {
    const model = readWhen({ field: "status", op: "eq", value: "done" }, String);
    expect(model).toMatchObject({ kind: "clauses", join: "all" });
    expect(writeWhen(model)).toEqual({ field: "status", op: "eq", value: "done" });
    expect(whenError(model, draft, "search")).toBeNull();
    expect(whenError({ kind: "clauses", join: "all", clauses: [{ field: "verdict", op: "eq", value: "x" }] }, draft, "search")).toMatchObject({ key: "wfEditErr_unknownField", vars: { field: "verdict", known: "status, sources, handoff" } });
    expect(whenError({ kind: "clauses", join: "all", clauses: [{ field: "status", op: "eq", value: "maybe" }] }, draft, "search")).toMatchObject({ key: "wfEditErr_unknownValue" });
    expect(whenError({ kind: "clauses", join: "all", clauses: [{ field: "sources.length", op: "gt", value: 2 }] }, draft, "search")).toBeNull();
    expect(whenError({ kind: "clauses", join: "all", clauses: [{ field: "status", op: "eq" }] }, draft, "search")).toMatchObject({ key: "wfEditErr_valueRequired" });
    expect(writeWhen({ kind: "clauses", join: "any", clauses: [{ field: "a", op: "exists" }, { field: "b", op: "eq", value: 1 }] })).toEqual({ any: [{ field: "a", op: "exists" }, { field: "b", op: "eq", value: 1 }] });
    expect(readWhen({ not: { field: "a", op: "exists" } }, () => "!(a exists)")).toEqual({ kind: "complex", text: "!(a exists)" });
    // An expression reads node.field references: unknown nodes and fields are named, quoted text is not read.
    expect(expressionError("search.status == 'done' && input.query != ''", draft)).toBeNull();
    expect(expressionError("search.nope == 1", draft)).toMatchObject({ key: "wfEditErr_unknownField", vars: { field: "search.nope" } });
    expect(expressionError("ghost.x == 1", draft)).toMatchObject({ key: "wfEditErr_unknownNode", vars: { node: "ghost" } });
    expect(expressionError("search.status == 'ghost.x'", draft)).toBeNull();
    expect(expressionError("input.nothing == 1", draft)).toMatchObject({ key: "wfEditErr_unknownField" });
  });

  it("puts validator problems on the card or the edge they name, by the file's edge index", () => {
    const loose = { ...draft, edges: [{ from: "start", to: "search" }, { from: "search", to: "missing" }, { from: "search", to: "analyze" }] };
    const view = draftView(loose);
    // The edge to a step that is not there yet is not drawn, so the canvas's second edge is the file's third.
    expect(viewEdgeIndexes(loose, view)).toEqual([0, 2]);
    const found = problemMaps([
      { level: "error", code: "dead_end", message: "no way out", node: "analyze" },
      { level: "error", code: "edge_to", message: "unknown target", edge: 1 },
      { level: "error", code: "condition_field", message: "bad field", edge: 2 },
      { level: "warning", code: "x", message: "general" },
      { level: "error", code: "y", message: "in the fan", node: "analyze:child" },
    ], loose, viewEdgeIndexes(loose, view));
    expect(found.graph.nodes.get("analyze")).toEqual(["no way out", "in the fan"]);
    expect([...found.graph.errors].sort()).toEqual(["edge:e1", "node:analyze"]);
    expect(found.graph.edges.get("e1")).toEqual(["bad field"]);
    expect(found.general.map((problem) => problem.message)).toEqual(["unknown target", "general"]);
  });
});

describe("the graph view", () => {
  it("stays at a readable zoom on the start of a long chain, and fits a short one whole", async () => {
    await loadPluginApp(() => import("../app"));
    const { readableViewport, READABLE_ZOOM } = await import("../src/ui/workflow-graph");
    const anchor = { x: 16, y: 300, width: 76, height: 34 };
    const long = readableViewport({ width: 3200, height: 700 }, anchor, { width: 680, height: 460 }, "RIGHT");
    expect(long.zoom).toBe(READABLE_ZOOM);
    // The start is at the left edge and the middle of the box: the owner pans along the chain.
    expect(long).toMatchObject({ x: 20 - 16 * READABLE_ZOOM, y: 460 / 2 - (300 + 17) * READABLE_ZOOM });
    const tall = readableViewport({ width: 700, height: 3000 }, { x: 300, y: 16, width: 76, height: 34 }, { width: 360, height: 420 }, "DOWN");
    expect(tall.zoom).toBe(READABLE_ZOOM);
    expect(tall.y).toBe(20 - 16 * READABLE_ZOOM);
    const short = readableViewport({ width: 400, height: 200 }, anchor, { width: 680, height: 460 }, "RIGHT");
    expect(short.zoom).toBe(1);
    expect(short.x).toBeCloseTo((680 - 400) / 2);
  });

  it("lists a note beside the graph instead of leaving it alone on the canvas", async () => {
    const w = await world();
    w.architect.drafts.patch(w.draftId, [{ op: "add_node", node: { id: "why", type: "note", text: "Why the digest waits for approval." } }]);
    await loadPluginApp(() => import("../app"));
    const { WorkflowDraftDetail } = await import("../src/ui/workflow-draft-detail");
    const slot = await renderSlot({ component: () => <WorkflowDraftDetail draftId={w.draftId} projectId={projectId} locale="en" onBack={() => undefined} /> }, {}, { context: { projectId, threadId: null }, rpc: w.rpc as never });
    const notes = await slot.findByTestId("wf-notes");
    expect(notes.textContent).toContain("Why the digest waits for approval.");
    await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
    expect(within(slot.getByTestId("workflow-graph")).queryByTestId("wf-node-why")).toBeNull();
  });
});

describe("editing a draft in the Workflows tab", () => {
  it("adds a step after another from its «+», as one patch that puts it between, and selects it", async () => {
    const { slot, calls } = await open();
    fireEvent.click(await slot.findByTestId("wf-add-summarize"));
    fireEvent.click(await slot.findByTestId("wf-add-type-human"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    const [patch] = patches(calls);
    expect(patch!.ops.map((op) => op.op)).toEqual(["add_node", "update_edge", "add_edge"]);
    expect(patch!.ops[0]).toMatchObject({ node: { id: "human", type: "human" } });
    expect(patch!.ops[2]).toMatchObject({ edge: { from: "human", to: "approve" } });
    // The new step is on the graph and its panel is open; the status line says the draft was saved.
    await slot.findByTestId("wf-node-human");
    expect((await slot.findByTestId("wf-node-panel")).textContent).toContain("human");
    await waitFor(() => expect(slot.getByTestId("wf-edit-status").textContent).toMatch(/Saved, version 8/));
  });

  it("adds a step from the toolbar, picking its type, and rejects nothing it should not", async () => {
    const { slot, calls } = await open();
    fireEvent.click(slot.getByTestId("wf-edit-add"));
    const menu = await slot.findByTestId("wf-add-menu");
    for (const type of ["agent", "lp-task", "action", "decision", "human", "parallel", "join", "subworkflow", "note"]) expect(within(menu).getByTestId(`wf-add-type-${type}`)).toBeTruthy();
    fireEvent.click(within(menu).getByTestId("wf-add-type-note"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "add_node", node: { id: "note", type: "note", text: "Note" } }]);
    await slot.findByTestId("wf-node-note");
  });

  it("joins two steps by the panel's «Connect to» (the same patch as dragging a port) and opens the new edge", async () => {
    const { slot, calls, architect, draftId } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-analyze"));
    await slot.findByTestId("wf-edit-connect");
    fireEvent.click(slot.getByTestId("wf-edit-connect"));
    fireEvent.click(await slot.findByRole("option", { name: "aborted" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "add_edge", edge: { from: "analyze", to: "aborted" } }]);
    expect((await slot.findByTestId("wf-edge-panel")).textContent).toContain("analyze → aborted");
    expect(architect.drafts.get(draftId)!.definition.edges).toContainEqual({ from: "analyze", to: "aborted" });
  });

  it("builds a condition from the source's fields, refuses an unknown field before any patch, and sends a valid one", async () => {
    const { slot, calls } = await open();
    fireEvent.click(edgeLabel(slot.getByTestId("workflow-graph"), "'blocked'"));
    await slot.findByTestId("wf-edge-panel");
    // The edge has an expression; switch to fields and type a field the source does not declare.
    fireEvent.click(slot.getByTestId("wf-cond-mode-clauses"));
    const field = await slot.findByTestId("wf-cond-field-0") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "verdict" } });
    fireEvent.blur(field);
    const alert = await slot.findByText(/does not declare «verdict»/);
    expect(alert.textContent).toContain("status");
    expect(patches(calls)).toHaveLength(0);
    // A declared field with an enum value, chosen from the field's own values.
    fireEvent.change(field, { target: { value: "status" } });
    fireEvent.blur(field);
    fireEvent.click(await slot.findByTestId("wf-cond-value-0"));
    fireEvent.click(await slot.findByRole("option", { name: "blocked" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops[0]).toMatchObject({ op: "update_edge", set: { when: { field: "status", op: "eq", value: "blocked" } } });
    // The edge on the canvas now carries the condition as written.
    await waitFor(() => expect(edgeLabel(slot.getByTestId("workflow-graph"), "status == 'blocked'")).toBeTruthy());
  });

  it("refuses an expression that reads an unknown step or field", async () => {
    const { slot, calls } = await open();
    fireEvent.click(edgeLabel(slot.getByTestId("workflow-graph"), "'blocked'"));
    const expression = await slot.findByTestId("wf-cond-expression") as HTMLInputElement;
    fireEvent.change(expression, { target: { value: "search.nope == 1" } });
    fireEvent.blur(expression);
    expect(await slot.findByText(/does not declare «search.nope»/)).toBeTruthy();
    fireEvent.change(expression, { target: { value: "ghost.x == 1" } });
    fireEvent.blur(expression);
    expect(await slot.findByText(/no step «ghost»/)).toBeTruthy();
    expect(patches(calls)).toHaveLength(0);
  });

  it("shows what the validator found on the card and in the list", async () => {
    const { slot, architect, draftId } = await open();
    expect(slot.getByTestId("wf-edit-problem-count").textContent).toContain("No errors");
    // A step with no way out is an error the validator names by node.
    architect.drafts.patch(draftId, [{ op: "add_node", node: { id: "lonely", type: "agent", prompt: "x", out: [{ name: "r", type: "string" }] } }, { op: "add_edge", edge: { from: "approve", to: "lonely", when: "approve.answer_kind == 'abort'" } }]);
    await slot.behavior.emitRealtime(`lp:${projectId}`, { kind: "workflow-draft", draftId });
    const marker = await slot.findByTestId("wf-problem-lonely");
    expect(marker.getAttribute("aria-label")).toBe("The validator found a problem here");
    expect(slot.getByTestId("wf-node-lonely").getAttribute("data-problem")).toBe("error");
    // A warning is marked too, but not as an error.
    expect(slot.getByTestId("wf-node-search").getAttribute("data-problem")).toBe("warning");
    expect(slot.getByTestId("wf-edit-problem-count").textContent).toMatch(/\d+ errors/);
    expect(within(slot.getByTestId("wf-problems-panel")).getAllByTestId("wf-problem-row").some((row) => row.textContent?.includes("lonely"))).toBe(true);
    // A draft with errors cannot be tested.
    expect((slot.getByTestId("wf-edit-test") as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns an edit of a property into a draft patch with the version it was made on", async () => {
    const { slot, calls, architect, draftId } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-summarize"));
    const prompt = await slot.findByTestId("wf-edit-prompt") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Write a one-line digest." } });
    expect(patches(calls)).toHaveLength(0);
    fireEvent.blur(prompt);
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toMatchObject({ expectedVersion: 7, ops: [{ op: "update_node", id: "summarize", set: { prompt: "Write a one-line digest." } }] });
    expect((architect.drafts.get(draftId)!.definition.nodes as Array<{ id: string; prompt: string }>).find((node) => node.id === "summarize")!.prompt).toBe("Write a one-line digest.");
    // A number is a number, and a bad one is refused where it is typed.
    const attempts = slot.getByTestId("wf-edit-attempts") as HTMLInputElement;
    fireEvent.click(slot.getByTestId("wf-edit-guards").querySelector("summary")!);
    fireEvent.change(attempts, { target: { value: "9" } });
    fireEvent.blur(attempts);
    expect(await slot.findByText(/whole number from 1 to 5/)).toBeTruthy();
    fireEvent.change(attempts, { target: { value: "3" } });
    fireEvent.blur(attempts);
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.ops[0]).toMatchObject({ op: "update_node", id: "summarize", set: { maxAttempts: 3 } });
  });

  it("completes a field reference after «{{» in a prompt", async () => {
    const { slot } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-summarize"));
    const prompt = await slot.findByTestId("wf-edit-prompt") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Digest of {{ana", selectionStart: 15 } });
    prompt.setSelectionRange(15, 15);
    fireEvent.select(prompt);
    const list = await slot.findByTestId("wf-ref-suggestions");
    expect(Array.from(list.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["analyze.findings", "analyze.notes", "analyze.handoff"]);
    fireEvent.mouseDown(within(list).getByText("analyze.findings"));
    expect(prompt.value).toBe("Digest of {{analyze.findings}}");
  });

  it("keeps publish off until the draft is tested green, and off again when a test fails or the draft changes", async () => {
    const { slot, calls, architect, draftId } = await open();
    const publish = () => slot.getByTestId("wf-edit-publish") as HTMLButtonElement;
    expect(publish().disabled).toBe(true);
    expect(slot.getByTestId("wf-publish-why").textContent).toContain("Run the test");

    fireEvent.click(slot.getByTestId("wf-edit-test"));
    await waitFor(() => expect(slot.getByTestId("wf-tests-verdict").textContent).toBe("Green"));
    expect(calls.some((call) => call.method === "workflow_draft_test")).toBe(true);
    expect(slot.getByTestId("wf-case-digest").getAttribute("data-green")).toBe("1");
    expect(slot.getByTestId("wf-case-digest/blocked")).toBeTruthy();
    await waitFor(() => expect(publish().disabled).toBe(false));

    // A case that expects a path the graph does not take is red, with the reason, and publishing is off.
    fireEvent.click(slot.getByTestId("wf-edit-settings"));
    const json = await slot.findByTestId("wf-edit-test-json") as HTMLTextAreaElement;
    fireEvent.click(slot.getByTestId("wf-edit-test-case").querySelector("summary")!);
    fireEvent.change(json, { target: { value: JSON.stringify({ id: "wrong", sim: { input: { query: "q" }, expect_path: ["search"] } }) } });
    fireEvent.blur(json);
    await waitFor(() => expect(publish().disabled).toBe(true));
    expect(slot.getByTestId("wf-tests-verdict").textContent).toBe("Out of date");
    fireEvent.click(slot.getByTestId("wf-edit-test"));
    await waitFor(() => expect(slot.getByTestId("wf-tests-verdict").textContent).toBe("Red"));
    expect(slot.getByTestId("wf-case-wrong").getAttribute("data-green")).toBe("0");
    expect(slot.getByTestId("wf-case-wrong").textContent).toContain("is not the expected search");
    expect(publish().disabled).toBe(true);
    expect(slot.getByTestId("wf-publish-why").textContent).toContain("last test failed");
    expect(calls.some((call) => call.method === "workflow_draft_publish")).toBe(false);

    // Back to the original case: green, publishable, and the publish goes through.
    fireEvent.change(json, { target: { value: JSON.stringify(architect.drafts.definitionAt(draftId, 7)!.test) } });
    fireEvent.blur(json);
    await waitFor(() => expect(patches(calls).length).toBeGreaterThan(1));
    fireEvent.click(slot.getByTestId("wf-edit-test"));
    await waitFor(() => expect(slot.getByTestId("wf-tests-verdict").textContent).toBe("Green"));
    await waitFor(() => expect(publish().disabled).toBe(false));
    fireEvent.click(publish());
    await waitFor(() => expect(slot.getByTestId("wf-publish-result").textContent).toBe("Published"));
    expect(slot.getByTestId("wf-publish-path").textContent).toContain("browser-digest.json");
    expect(architect.drafts.get(draftId)!.status).toBe("published");
  });

  it("undoes and redoes the owner's edits as restores, and a version somebody else made clears them", async () => {
    const { slot, calls, architect, draftId } = await open();
    const undo = () => slot.getByTestId("wf-edit-undo") as HTMLButtonElement;
    const redo = () => slot.getByTestId("wf-edit-redo") as HTMLButtonElement;
    expect(undo().disabled).toBe(true);
    fireEvent.click(await slot.findByTestId("wf-add-summarize"));
    fireEvent.click(await slot.findByTestId("wf-add-type-note"));
    await slot.findByTestId("wf-node-note");
    await waitFor(() => expect(undo().disabled).toBe(false));
    fireEvent.click(undo());
    await waitFor(() => expect(slot.queryByTestId("wf-node-note")).toBeNull());
    expect(calls.find((call) => call.method === "workflow_draft_restore")!.input).toMatchObject({ draftId, version: 7 });
    expect(redo().disabled).toBe(false);
    fireEvent.click(redo());
    await slot.findByTestId("wf-node-note");

    // The architect changes the draft: the owner's undo would throw that away, so it is off.
    fireEvent.click(undo());
    await waitFor(() => expect(slot.queryByTestId("wf-node-note")).toBeNull());
    architect.drafts.patch(draftId, [{ op: "add_node", node: { id: "extra", type: "note", text: "from the architect" } }]);
    await slot.behavior.emitRealtime(`lp:${projectId}`, { kind: "workflow-draft", draftId });
    await slot.findByTestId("wf-node-extra");
    await waitFor(() => expect(undo().disabled).toBe(true));
    expect(redo().disabled).toBe(true);
    // The versions list restores any version, current one excepted.
    expect(slot.queryByTestId(`wf-restore-${architect.drafts.get(draftId)!.version}`)).toBeNull();
    expect(slot.getByTestId("wf-restore-7")).toBeTruthy();
  });

  it("redraws on the architect's signal and keeps the selection (and drops it only when its step is gone)", async () => {
    const { slot, architect, draftId } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-summarize"));
    await slot.findByTestId("wf-node-panel");
    const before = slot.getByTestId("wf-draft-version").textContent;

    architect.drafts.patch(draftId, [{ op: "add_node", node: { id: "archive", type: "action", action: "fs.write", out: [{ name: "path", type: "string" }] } }, { op: "add_edge", edge: { from: "sent", to: "archive" } }]);
    await slot.behavior.emitRealtime(`lp:${projectId}`, { kind: "workflow-draft", draftId });
    await slot.findByTestId("wf-node-archive");
    expect(slot.getByTestId("wf-draft-version").textContent).not.toBe(before);
    // The panel is still the one of the step that was selected, and the card shows it selected.
    expect(slot.getByTestId("wf-node-panel").textContent).toContain("summarize");
    expect(slot.getByTestId("wf-node-summarize").getAttribute("data-selected")).toBe("1");
    // What the architect just changed is outlined.
    await waitFor(() => expect(slot.getByTestId("wf-node-archive").getAttribute("data-changed")).toBe("1"));

    // Another draft's patch changes nothing; the removal of the selected step closes its panel.
    await slot.behavior.emitRealtime(`lp:${projectId}`, { kind: "workflow-draft", draftId: "wfd_other" });
    architect.drafts.patch(draftId, [{ op: "remove_node", id: "summarize" }]);
    await slot.behavior.emitRealtime(`lp:${projectId}`, { kind: "workflow-draft", draftId });
    await waitFor(() => expect(slot.queryByTestId("wf-node-panel")).toBeNull());
    await waitFor(() => expect(slot.queryByTestId("wf-node-summarize")).toBeNull());
  });

  it("re-reads and sends again a patch the architect's change made stale, once", async () => {
    const { slot, calls, architect, draftId } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-summarize"));
    const prompt = await slot.findByTestId("wf-edit-prompt") as HTMLTextAreaElement;
    // The architect patched meanwhile: the screen still holds the version before.
    architect.drafts.patch(draftId, [{ op: "add_node", node: { id: "extra", type: "note", text: "x" } }]);
    fireEvent.change(prompt, { target: { value: "A newer prompt." } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls).map((call) => call.expectedVersion)).toEqual([7, 8]);
    expect((architect.drafts.get(draftId)!.definition.nodes as Array<{ id: string; prompt?: string }>).find((node) => node.id === "summarize")!.prompt).toBe("A newer prompt.");
  });

  it("keeps the viewer as it was until «Edit» is pressed, and leaves editing on «Done»", async () => {
    const { slot } = await open({}, { editing: false });
    expect(slot.queryByTestId("wf-edit-toolbar")).toBeNull();
    expect(slot.queryByTestId("wf-add-summarize")).toBeNull();
    fireEvent.click(slot.getByTestId("wf-edit-toggle"));
    await slot.findByTestId("wf-edit-toolbar");
    await slot.findByTestId("wf-add-summarize");
    fireEvent.click(slot.getByTestId("wf-edit-toggle"));
    await waitFor(() => expect(slot.queryByTestId("wf-edit-toolbar")).toBeNull());
  });

  it("offers the catalogue's skills, machines and Env Catalog names (names only) in the panels", async () => {
    const { slot } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-search"));
    const skills = await slot.findByTestId("wf-edit-skills");
    expect(skills.textContent).toContain("browser-automation");
    fireEvent.click(slot.getByTestId("wf-edit-settings"));
    const secrets = await slot.findByTestId("wf-edit-secrets");
    await waitFor(() => expect(within(secrets).queryByRole("combobox")).toBeTruthy());
    fireEvent.click(within(secrets).getByRole("combobox"));
    expect(await slot.findByRole("option", { name: "TELEGRAM_SESSION" })).toBeTruthy();
    expect(slot.getByTestId("wf-edit-mcp").textContent).toContain("tavily");
  });

  it("puts the step's BB plugins and MCP servers beside its skills, from the catalogue, and writes them to the draft", async () => {
    const { slot, architect, draftId } = await open();
    fireEvent.click(await slot.findByTestId("wf-node-search"));
    const plugins = await slot.findByTestId("wf-edit-node-plugins");
    await waitFor(() => expect(within(plugins).queryByRole("combobox")).toBeTruthy());
    fireEvent.click(within(plugins).getByRole("combobox"));
    fireEvent.click(await slot.findByRole("option", { name: /browser/i }));
    await waitFor(() => expect((architect.drafts.get(draftId)!.definition.nodes as Array<{ id: string; plugins?: string[] }>).find((node) => node.id === "search")!.plugins).toEqual(["browser-automation"]));
    const mcp = await slot.findByTestId("wf-edit-node-mcp");
    await waitFor(() => expect(within(mcp).queryByRole("combobox")).toBeTruthy());
    fireEvent.click(within(mcp).getByRole("combobox"));
    fireEvent.click(await slot.findByRole("option", { name: "tavily" }));
    await waitFor(() => expect((architect.drafts.get(draftId)!.definition.nodes as Array<{ id: string; mcp?: string[] }>).find((node) => node.id === "search")!.mcp).toEqual(["tavily"]));
  });

  it("edits the schedule trigger (cron, zone, inputs) and the requirements lists without losing what was set", async () => {
    const { slot, calls, architect, draftId } = await open();
    fireEvent.click(await slot.findByTestId("wf-edit-settings"));
    const triggers = await slot.findByTestId("wf-edit-triggers");
    fireEvent.click(within(triggers).getByRole("combobox"));
    fireEvent.click(await slot.findByRole("option", { name: "schedule" }));
    const cron = await slot.findByTestId("wf-edit-cron") as HTMLInputElement;
    fireEvent.change(cron, { target: { value: "0 25 * * *" } });
    fireEvent.blur(cron);
    expect((await slot.findByRole("alert")).textContent).toContain("between 0 and 23");
    const before = patches(calls).length;
    fireEvent.change(cron, { target: { value: "0 9 * * 1-5" } });
    fireEvent.blur(cron);
    await waitFor(() => expect(patches(calls).length).toBeGreaterThan(before));
    fireEvent.change(slot.getByTestId("wf-edit-timezone"), { target: { value: "Europe/Moscow" } });
    fireEvent.blur(slot.getByTestId("wf-edit-timezone"));
    await waitFor(() => expect((architect.drafts.get(draftId)!.definition.triggers as Array<{ timezone?: string }>).at(-1)!.timezone).toBe("Europe/Moscow"));
    await new Promise((done) => setTimeout(done, 50));
    fireEvent.change(slot.getByTestId("wf-edit-schedule-inputs"), { target: { value: '{"query":"cats"}' } });
    fireEvent.blur(slot.getByTestId("wf-edit-schedule-inputs"));
    await waitFor(() => expect((architect.drafts.get(draftId)!.definition.triggers as unknown[]).at(-1)).toEqual({ type: "schedule", cron: "0 9 * * 1-5", timezone: "Europe/Moscow", inputs: { query: "cats" } }));
    // Adding another kind of trigger keeps the schedule's fields.
    fireEvent.click(within(slot.getByTestId("wf-edit-triggers")).getByRole("combobox"));
    fireEvent.click(await slot.findByRole("option", { name: "telegram" }));
    await waitFor(() => expect((architect.drafts.get(draftId)!.definition.triggers as Array<{ type: string }>).map((item) => item.type)).toContain("telegram"));
    expect((architect.drafts.get(draftId)!.definition.triggers as Array<{ type: string; cron?: string }>).find((item) => item.type === "schedule")!.cron).toBe("0 9 * * 1-5");
    // The new requirement lists are there to fill.
    expect(slot.getByTestId("wf-edit-tools")).toBeTruthy();
    expect(slot.getByTestId("wf-edit-platforms")).toBeTruthy();
    expect(slot.getByTestId("wf-edit-mcp-servers")).toBeTruthy();
  });

  it("works in Russian and shows the panel as a bottom sheet on a narrow screen", async () => {
    setLocaleOverride("ru");
    const measure = vi.spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 375, height: 800, top: 0, left: 0, right: 375, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    const w = await world();
    await loadPluginApp(() => import("../app"));
    const { WorkflowDraftDetail } = await import("../src/ui/workflow-draft-detail");
    const slot = await renderSlot({ component: () => <div style={{ width: 375 }}><WorkflowDraftDetail draftId={w.draftId} projectId={projectId} locale="ru" onBack={() => undefined} startEditing /></div> }, {},
      { context: { projectId, threadId: null }, rpc: w.rpc as never });
    expect((await slot.findByTestId("wf-edit-toolbar")).textContent).toContain("Добавить шаг");
    expect(slot.getByTestId("wf-edit-publish").textContent).toBe("Опубликовать");
    fireEvent.click(await slot.findByTestId("wf-node-send"));
    const panel = await slot.findByTestId("wf-node-panel");
    expect(panel.textContent).toContain("Параметры");
    expect(panel.className).toContain("lp-wf-sheet");
    measure.mockRestore();
  });
});

describe("starting an edit from a workflow of the library", () => {
  const detail = (scope: "builtin" | "global") => ({
    id: scope === "builtin" ? "analyze-plan-execute" : "mine", name: { en: "W", ru: "В" }, description: { en: "d", ru: "о" }, status: "published", version: 1, scope, internal: false, tags: [], nodes: 1, warnings: 0,
    stats: { runs: 0, succeeded: 0, failed: 0, active: 0, successRate: null, lastRunAt: null, lastStatus: null, lastRunId: null },
    examples: { en: [], ru: [] }, inputs: [], outputs: [], triggers: [], requires: [], budget: { maxSteps: null, maxTokens: null, maxCostUsd: null, maxWallSeconds: null }, qualityMode: null, source: "x.json", sha256: "s", warningMessages: [],
    graph: { nodes: [], edges: [] }, runs: [],
  });

  async function show(scope: "builtin" | "global", seen: unknown[]) {
    await loadPluginApp(() => import("../app"));
    const { WorkflowsScreen } = await import("../src/ui/workflows");
    const w = await world();
    const rpc = { ...w.rpc, workflow_list: () => ({ workflows: [{ ...detail(scope) }], problems: [], project: "ok" }), workflow_get: () => ({ workflow: detail(scope) }),
      workflow_draft_create: (input: unknown) => { seen.push(input); return { draftId: w.draftId, workflowId: detail(scope).id, reused: false }; } };
    const slot = await renderSlot({ component: () => <WorkflowsScreen locale="en" projectId={projectId} /> }, {}, { context: { projectId, threadId: null }, rpc: rpc as never });
    fireEvent.click(await slot.findByTestId(`wf-row-${detail(scope).id}`));
    return slot;
  }

  it("copies a built-in workflow to edit (it is read-only) and opens the copy in the editor", async () => {
    const seen: unknown[] = [];
    const slot = await show("builtin", seen);
    expect((await slot.findByTestId("wf-builtin-note")).textContent).toContain("read-only");
    expect(slot.getByTestId("wf-edit-start").textContent).toBe("Duplicate to edit");
    fireEvent.click(slot.getByTestId("wf-edit-start"));
    await slot.findByTestId("wf-edit-toolbar");
    expect(seen).toEqual([{ projectId, workflowId: "analyze-plan-execute", mode: "duplicate", scope: "project" }]);
  });

  it("edits an own workflow in place", async () => {
    const seen: unknown[] = [];
    const slot = await show("global", seen);
    await slot.findByTestId("wf-edit-start");
    expect(slot.queryByTestId("wf-builtin-note")).toBeNull();
    expect(slot.getByTestId("wf-edit-start").textContent).toBe("Edit");
    fireEvent.click(slot.getByTestId("wf-edit-start"));
    await slot.findByTestId("wf-edit-toolbar");
    expect(seen).toEqual([{ projectId, workflowId: "mine", mode: "edit", scope: "project" }]);
  });
});
