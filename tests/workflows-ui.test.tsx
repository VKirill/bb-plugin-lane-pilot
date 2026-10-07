/** @vitest-environment jsdom */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "../i18n";
import { createWorkflowLibrary } from "../src/server/workflow-library";
import type { ServerCore } from "../src/server/core";
import type { Services } from "../src/server/services";
import { engineOn, journalDb, trust, wf } from "./workflow/engine-helpers";
import { workflow } from "./workflow/fixtures";

// The graph pulls in xyflow and elkjs on first use; a cold import under load can pass the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  // xyflow reads the viewport transform through DOMMatrixReadOnly, which jsdom lacks.
  class Matrix { m22 = 1; m41 = 0; m42 = 0; constructor(_init?: string) {} }
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
});
afterEach(() => { cleanup(); setLocaleOverride(null); });

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const reviewFix = (extra: Record<string, unknown> = {}) => workflow({
  id: "review-fix", name: { en: "Review and fix", ru: "Ревью и правки" }, description: { en: "Build, review, rework until it passes", ru: "Собрать, проверить, переделать" }, status: "published",
  nodes: [
    { id: "build", type: "agent", role: "builder", prompt: "Build the thing described in the task.", maxVisits: 3, output: [{ name: "done", type: "boolean" }] },
    { id: "review", type: "agent", role: "reviewer", prompt: "Review the build.", output: [{ name: "verdict", type: "enum", values: ["pass", "rework"] }] },
    { id: "ship", type: "action", action: "ship", output: [{ name: "text", type: "string" }] },
  ],
  edges: [
    { from: "start", to: "build" },
    { from: "build", to: "review", pass: "read-prior-session" },
    { from: "review", to: "build", when: { field: "verdict", op: "eq", value: "rework" }, label: "again" },
    { from: "review", to: "ship", when: "review.verdict == 'pass'" },
    { from: "ship", to: "end", with: { result: "ship.text" } },
  ],
  ...extra,
});
const digest = () => workflow({
  id: "x-digest", name: { en: "X digest", ru: "Сводка из X" }, description: { en: "Search X and post a digest", ru: "Найти в X и выложить сводку" }, status: "draft", tags: ["social"],
  nodes: [
    { id: "search", type: "agent", role: "plan-researcher", prompt: "Search.", output: [{ name: "items", type: "array" }] },
    { id: "post", type: "action", action: "telegram.send", output: [{ name: "text", type: "string" }] },
  ],
  edges: [{ from: "start", to: "search" }, { from: "search", to: "post", with: { items: "search.items" } }, { from: "post", to: "end", with: { result: "post.text" } }],
});

/** The real library over a real engine and journal, so the screens get the shapes the server sends. */
async function world(options: { reviewWaits?: boolean; files?: Record<string, unknown> } = {}) {
  const db = journalDb();
  const globalDir = await mkdtemp(join(tmpdir(), "lp-wf-ui-"));
  dirs.push(globalDir);
  const files = { "review-fix.json": reviewFix(), "x-digest.json": digest(), ...(options.files ?? {}) };
  for (const [name, content] of Object.entries(files)) { await writeFile(join(globalDir, name), JSON.stringify(content)); trust(db, content as Record<string, unknown>); }
  const engine = engineOn(db, {
    agent: { reentrant: true, run: async (ctx) => ctx.nodeId === "review" && options.reviewWaits ? { wait: { kind: "human" }, threadId: "thr_review" } : { output: { handoff: "done", done: true, verdict: "pass" }, threadId: `thr_${ctx.nodeId}` } },
    ship: { reentrant: true, run: async () => ({ output: { text: "shipped" } }) },
  }, { resolveWorkflow: () => null });
  const ctx = { db, log: () => undefined, host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
  const services = { workflowEngine: engine, docsPlaces: async () => [] } as unknown as Services;
  const lib = createWorkflowLibrary(ctx, services, { globalDir });
  const rpc = {
    get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
    workflow_list: (input: { projectId?: string }) => lib.list(input),
    workflow_get: (input: { id: string; projectId?: string }) => lib.get(input),
    workflow_run_snapshot: (input: { runId: string }) => lib.runSnapshot(input),
  };
  return { db, engine, lib, rpc };
}

/** The SDK's app runtime exists only after loadPluginApp, so the screen is imported after it. */
async function screen() {
  await loadPluginApp(() => import("../app"));
  return (await import("../src/ui/workflows")).WorkflowsScreen;
}

async function mount(rpc: Record<string, unknown>, extra: Record<string, unknown> = {}, projectId: string | null = null, locale: "en" | "ru" = "en") {
  const WorkflowsScreen = await screen();
  return renderSlot({ component: () => <WorkflowsScreen locale={locale} projectId={projectId} /> }, {}, { context: { projectId, threadId: null }, rpc: rpc as never, ...extra });
}

describe("Workflows library", () => {
  it("lists built-in and global workflows with status, scope and run stats, and filters by search, status and scope", async () => {
    const { rpc, engine } = await world();
    // One finished run of review-fix gives it stats.
    const started = engine.start({ workflow: wf(reviewFix() as never), inputs: { query: "q" }, link: { projectId: "proj_1" } });
    await started.done;
    const slot = await mount(rpc);
    await slot.findByTestId("wf-row-review-fix");
    expect(slot.getByTestId("wf-row-x-digest")).toBeTruthy();
    expect(slot.getByTestId("wf-row-analyze-plan-execute")).toBeTruthy();
    expect(slot.getByTestId("wf-status-review-fix").textContent).toBe("Published");
    expect(slot.getByTestId("wf-status-x-digest").textContent).toBe("Draft");
    expect(slot.getByTestId("wf-scope-review-fix").textContent).toBe("Global");
    expect(slot.getByTestId("wf-scope-analyze-plan-execute").textContent).toBe("Built-in");
    expect(slot.getByTestId("wf-stats-review-fix").textContent).toContain("1 run");
    expect(slot.getByTestId("wf-stats-review-fix").textContent).toContain("100% succeeded");
    expect(slot.getByTestId("wf-stats-x-digest").textContent).toContain("No runs yet");

    const search = slot.getByTestId("wf-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "digest" } });
    await waitFor(() => expect(slot.queryByTestId("wf-row-review-fix")).toBeNull());
    expect(slot.getByTestId("wf-row-x-digest")).toBeTruthy();
    fireEvent.change(search, { target: { value: "social" } });
    expect(slot.getByTestId("wf-row-x-digest")).toBeTruthy();
    fireEvent.change(search, { target: { value: "Ревью" } });
    await waitFor(() => expect(slot.queryByTestId("wf-row-x-digest")).toBeNull());
    expect(slot.getByTestId("wf-row-review-fix")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect((await slot.findByTestId("wf-empty")).textContent).toContain("No workflows match.");
    fireEvent.change(search, { target: { value: "" } });

    fireEvent.click(slot.getByTestId("wf-filter-status"));
    fireEvent.click(await slot.findByRole("option", { name: "Draft" }));
    await waitFor(() => expect(slot.queryByTestId("wf-row-review-fix")).toBeNull());
    expect(slot.getByTestId("wf-row-x-digest")).toBeTruthy();
    fireEvent.click(slot.getByTestId("wf-filter-status"));
    fireEvent.click(await slot.findByRole("option", { name: "Any status" }));
    fireEvent.click(slot.getByTestId("wf-filter-scope"));
    fireEvent.click(await slot.findByRole("option", { name: "Built-in" }));
    await waitFor(() => expect(slot.queryByTestId("wf-row-x-digest")).toBeNull());
    expect(slot.getByTestId("wf-row-analyze-plan-execute")).toBeTruthy();
  });

  it("speaks Russian when asked and names a project whose machine could not be read", async () => {
    const { rpc } = await world();
    setLocaleOverride("ru");
    const slot = await mount({ ...rpc, workflow_list: async (input: { projectId?: string }) => ({ ...(await rpc.workflow_list(input)), project: "unavailable" as const }) }, {}, "proj_1", "ru");
    expect((await slot.findByTestId("wf-row-review-fix")).textContent).toContain("Ревью и правки");
    expect(slot.getByTestId("wf-status-review-fix").textContent).toBe("Опубликован");
    expect(slot.getByTestId("wf-project-notice").textContent).toContain("Машину проекта");
  });
});

describe("Workflow graph", () => {
  it("draws the nodes and labelled edges of two workflows, with role colours and passing modes", async () => {
    const { rpc } = await world();
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-review-fix"));
    const graph = await slot.findByTestId("workflow-graph");
    await waitFor(() => expect(graph.getAttribute("data-layout")).toBe("ready"));
    for (const id of ["$start", "build", "review", "ship", "$end"]) expect(await slot.findByTestId(`wf-node-${id}`)).toBeTruthy();
    expect(slot.getByTestId("wf-node-build").getAttribute("data-tone")).toBe("build");
    expect(slot.getByTestId("wf-node-review").getAttribute("data-tone")).toBe("review");
    expect(slot.getByTestId("wf-node-ship").getAttribute("data-tone")).toBe("action");
    expect(slot.getByTestId("wf-node-build").textContent).toContain("builder");
    expect(slot.getByTestId("wf-node-build").textContent).toContain("Build the thing described in the task.");
    // Every edge that has a condition, a label, a data mapping or a non-default passing mode says so; the bare entry edge says nothing.
    await waitFor(() => expect(graph.querySelectorAll("[data-testid^='wf-edge-']").length).toBe(4));
    const labels = Array.from(graph.querySelectorAll("[data-testid^='wf-edge-']")).map((node) => node.textContent ?? "");
    expect(labels.some((text) => text.includes("again") && text.includes("verdict == 'rework'"))).toBe(true);
    expect(labels.some((text) => text.includes("review.verdict == 'pass'"))).toBe(true);
    expect(labels.some((text) => text.includes("prior session"))).toBe(true);
    expect(labels.filter((text) => text.includes("artifact")).length).toBeGreaterThan(0);
    // Read-only: no «+» until the editor passes a handler.
    expect(graph.querySelector(".lp-wf-add")).toBeNull();

    fireEvent.click(slot.getByTestId("wf-back"));
    fireEvent.click(await slot.findByTestId("wf-row-x-digest"));
    await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
    await slot.findByTestId("wf-node-search");
    expect(slot.getByTestId("wf-node-search").getAttribute("data-tone")).toBe("plan");
    expect(slot.queryByTestId("wf-node-review")).toBeNull();
    await waitFor(() => expect(slot.getByTestId("workflow-graph").querySelectorAll("[data-testid^='wf-edge-']").length).toBe(2));
  });

  it("opens a subworkflow node into its own graph and closes it again", async () => {
    const parentCall = workflow({
      id: "parent", name: { en: "Parent", ru: "Родитель" }, description: { en: "calls the digest", ru: "вызывает сводку" },
      nodes: [{ id: "call", type: "subworkflow", workflow: "x-digest", inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }],
      edges: [{ from: "start", to: "call", with: { query: "input.query" } }, { from: "call", to: "end", with: { result: "call.result" } }],
    });
    const { rpc } = await world({ files: { "parent.json": parentCall } });
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-parent"));
    await slot.findByTestId("wf-node-call");
    fireEvent.click(await slot.findByTestId("wf-expand-call"));
    await slot.findByTestId("wf-group-call");
    expect(await slot.findByTestId("wf-node-call/search")).toBeTruthy();
    expect(slot.getByTestId("wf-node-call/post")).toBeTruthy();
    fireEvent.click(slot.getByTestId("wf-expand-call"));
    await waitFor(() => expect(slot.queryByTestId("wf-node-call/search")).toBeNull());
    expect(slot.getByTestId("wf-node-call")).toBeTruthy();
  });
});

describe("Workflow run view", () => {
  it("shows node statuses and moves them when the server signals a change; a click opens the node's chat and its result", async () => {
    const { rpc, engine } = await world({ reviewWaits: true });
    const opened: unknown[] = [];
    const started = engine.start({ workflow: wf(reviewFix() as never), inputs: { query: "q" }, link: { projectId: "proj_1" } });
    await started.done;
    // The review step waits for its answer: the run is live.
    const slot = await mount(rpc, { openThreadPanel: (options: unknown) => { opened.push(options); return true; } });
    fireEvent.click(await slot.findByTestId("wf-row-review-fix"));
    // An active run takes over the screen by itself.
    await waitFor(() => expect(slot.getByTestId("wf-run-summary").textContent).toContain("Waiting"));
    await waitFor(() => expect(slot.getByTestId("wf-node-build").getAttribute("data-status")).toBe("done"));
    expect(slot.getByTestId("wf-node-review").getAttribute("data-status")).toBe("waiting");
    expect(slot.getByTestId("wf-node-ship").getAttribute("data-status")).toBe("pending");
    expect(slot.getByTestId("wf-node-review").textContent).toContain("Waiting");

    // The answer arrives: the engine finishes the run and the server signals.
    const waitingStep = (await rpc.workflow_run_snapshot({ runId: started.runId })).snapshot!.steps.find((step) => step.nodeId === "review")!;
    expect(engine.resolve(started.runId, waitingStep.key, { verdict: "pass", handoff: "looks right" })).toBeTruthy();
    await started.done.catch(() => undefined);
    await waitFor(async () => expect((await rpc.workflow_run_snapshot({ runId: started.runId })).snapshot!.run.status).toBe("succeeded"));
    await slot.behavior.emitRealtime("lp:-", { kind: "workflow", runId: started.runId });
    await waitFor(() => expect(slot.getByTestId("wf-node-review").getAttribute("data-status")).toBe("done"));
    expect(slot.getByTestId("wf-node-ship").getAttribute("data-status")).toBe("done");
    expect(slot.getByTestId("wf-node-$end").getAttribute("data-status")).toBe("done");
    expect(slot.getByTestId("wf-run-summary").textContent).toContain("Succeeded");

    // A click on a node that ran in a chat opens that chat in the side panel and shows what the step produced.
    fireEvent.click(slot.getByTestId("wf-node-build"));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({ actionId: "lane-helper-thread", params: { threadId: "thr_build" } });
    const panel = await slot.findByTestId("wf-node-panel");
    expect(panel.textContent).toContain("Handoff");
    expect(panel.textContent).toContain("done");
    fireEvent.click(slot.getByTestId("wf-node-review"));
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]).toMatchObject({ params: { threadId: "thr_review" } });
    expect(slot.getByTestId("wf-node-panel").textContent).toContain("looks right");
  });

  it("ignores a signal about a run it does not show and offers the definition again", async () => {
    const { rpc, engine } = await world();
    const started = engine.start({ workflow: wf(reviewFix() as never), inputs: { query: "q" } });
    await started.done;
    const snapshots = vi.fn();
    const slot = await mount({ ...rpc, workflow_run_snapshot: (input: { runId: string }) => { snapshots(input.runId); return rpc.workflow_run_snapshot(input); } });
    fireEvent.click(await slot.findByTestId("wf-row-review-fix"));
    // A finished run is not opened by itself; the owner picks it.
    fireEvent.click(await slot.findByTestId("wf-run-pick"));
    fireEvent.click(await slot.findByTestId(`wf-pick-run-${started.runId}`));
    await waitFor(() => expect(snapshots).toHaveBeenCalledTimes(1));
    await slot.behavior.emitRealtime("lp:-", { kind: "workflow", runId: "wfrun_other" });
    await slot.behavior.emitRealtime("lp:-", { kind: "council" });
    await new Promise((done) => setTimeout(done, 60));
    expect(snapshots).toHaveBeenCalledTimes(1);
    fireEvent.click(slot.getByTestId("wf-run-pick"));
    fireEvent.click(await slot.findByTestId("wf-pick-definition"));
    await waitFor(() => expect(slot.queryByTestId("wf-run-summary")).toBeNull());
    expect(slot.getByTestId("wf-node-ship").getAttribute("data-status")).toBe("none");
  });
});

describe("Workflows in the page", () => {
  it("has a Workflows item in the rail and the narrow select, and a Workflows tab in a project", async () => {
    const { rpc } = await world();
    const app = await loadPluginApp(() => import("../app"));
    const slot = await renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: "proj_ui", threadId: null },
      providers: { status: "ready", providers: [] as never },
      rpc: {
        ...rpc,
        list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: "proj_ui" }),
        get_screen: () => { throw new Error("not needed here"); },
        list_sections: () => ({ sections: [] }),
      } as never,
    });
    fireEvent.click(await slot.findByTestId("scope-nav-workflows"));
    expect((await slot.findByTestId("workflows")).textContent).toContain("Workflows");
    await slot.findByTestId("wf-row-review-fix");
    expect(slot.getByTestId("project-settings").hasAttribute("hidden")).toBe(true);
  });
});

/** A draft as the architect leaves it half-way: an entry, one agent, and an edge to a node that does not exist yet. */
const draftV1 = () => ({
  id: "x-search", name: { en: "X search", ru: "Поиск в X" }, description: { en: "Search and summarise", ru: "Найти и свести" },
  nodes: [{ id: "search", type: "agent", role: "researcher", prompt: "Search X.", out: { items: "Item[]" } }],
  edges: [{ from: "start", to: "search" }, { from: "search", to: "summarise" }],
});
const draftV2 = () => ({
  ...draftV1(),
  nodes: [...draftV1().nodes, { id: "summarise", type: "agent", role: "writer", prompt: "Summarise the items.", out: { text: "string" } }],
  edges: [...draftV1().edges, { from: "summarise", to: "end", with: { result: "summarise.text" } }],
});

describe("draft view", () => {
  it("reads an unfinished draft leniently and says what a patch changed", async () => {
    const { draftView, draftChanges } = await import("../src/workflow/draft-view");
    const first = draftView(draftV1());
    expect(first.nodes.map((node) => node.id)).toEqual(["$start", "search"]);
    // The edge to a node that is not there yet is left out, not an error.
    expect(first.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["$start>search"]);
    expect(first.nodes[1]).toMatchObject({ tone: "plan", out: ["items"] });
    const second = draftView(draftV2());
    const changed = draftChanges(first, second);
    expect([...changed.nodes].sort()).toEqual(["$end", "summarise"]);
    expect(second.edges.filter((edge, index) => changed.edges.has(`e${index}`)).map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual(["search>summarise", "summarise>$end"]);
    expect(draftChanges(null, second).nodes.size).toBe(0);
    expect(draftChanges(second, draftView(draftV2())).nodes.size).toBe(0);
    expect(draftView(null)).toEqual({ nodes: [], edges: [] });
    expect(draftView({ nodes: [{ type: "agent" }, "x", { id: "ok", type: "weird" }], edges: [null, { from: "ok" }] }).nodes.map((node) => node.id)).toEqual(["ok"]);
  });
});

describe("workflow drafts on the Workflows tab", () => {
  it("lists drafts with a draft badge and starts the architect in the project, opening its chat", async () => {
    const { rpc } = await world();
    const started: unknown[] = [];
    const opened: unknown[] = [];
    const slot = await mount({
      ...rpc,
      workflow_draft_list: () => ({ drafts: [{ draftId: "draft_1", name: { en: "X search", ru: "Поиск в X" }, version: 3, updatedAt: 1_700_000_000_000 }] }),
      workflow_architect_start: (input: unknown) => { started.push(input); return { threadId: "thr_architect" }; },
    }, { openThreadPanel: (options: unknown) => { opened.push(options); return true; } }, "proj_1");
    expect((await slot.findByTestId("wf-draft-draft_1")).textContent).toContain("X search");
    expect(slot.getByTestId("wf-draft-badge-draft_1").textContent).toBe("Draft");
    expect(slot.getByTestId("wf-draft-draft_1").textContent).toContain("version 3");
    fireEvent.click(slot.getByTestId("wf-architect-start"));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(started).toEqual([{ projectId: "proj_1" }]);
    expect(opened[0]).toMatchObject({ actionId: "lane-helper-thread", params: { threadId: "thr_architect" } });
  });

  it("works against a server without the draft RPCs: no drafts, and the button reports why", async () => {
    const { rpc } = await world();
    const slot = await mount(rpc, {}, "proj_1");
    await slot.findByTestId("wf-row-review-fix");
    expect(slot.queryByTestId("workflow-drafts")).toBeNull();
    fireEvent.click(slot.getByTestId("wf-architect-start"));
    expect((await slot.findByTestId("wf-architect-error")).textContent).toContain("Could not start the architect");
  });

  it("redraws an open draft on the patch signal and outlines what the patch changed", async () => {
    const { rpc } = await world();
    let current: { version: number; workflow: unknown } = { version: 1, workflow: draftV1() };
    const reads = vi.fn();
    const slot = await mount({
      ...rpc,
      workflow_draft_list: () => ({ drafts: [{ draftId: "draft_1", name: { en: "X search", ru: "Поиск в X" }, version: 1 }] }),
      workflow_draft_get: ({ draftId }: { draftId: string }) => { reads(draftId); return { draftId, ...current }; },
    });
    fireEvent.click(await slot.findByTestId("wf-draft-draft_1"));
    await slot.findByTestId("wf-node-search");
    await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
    expect(slot.getByTestId("wf-draft-version").textContent).toBe("version 1");
    expect(slot.queryByTestId("wf-node-summarise")).toBeNull();
    expect(slot.getByTestId("wf-node-search").getAttribute("data-changed")).toBe("0");
    expect(slot.getByTestId("wf-draft-changes").textContent).toContain("Waiting for the next patch");

    // Another draft's patch changes nothing here.
    await slot.behavior.emitRealtime("lp:-", { kind: "workflow-draft", draftId: "draft_other" });
    await new Promise((done) => setTimeout(done, 40));
    expect(reads).toHaveBeenCalledTimes(1);

    // The architect adds a step: the graph redraws without a reload, the new node and edges are outlined.
    current = { version: 2, workflow: draftV2() };
    await slot.behavior.emitRealtime("lp:-", { kind: "workflow-draft", draftId: "draft_1" });
    await slot.findByTestId("wf-node-summarise");
    await waitFor(() => expect(slot.getByTestId("wf-node-summarise").getAttribute("data-changed")).toBe("1"));
    expect(slot.getByTestId("wf-node-search").getAttribute("data-changed")).toBe("0");
    expect(slot.getByTestId("wf-draft-version").textContent).toBe("version 2");
    expect(slot.getByTestId("wf-draft-changes").textContent).toMatch(/nodes: 2, edges: 2/);
    await waitFor(() => expect(slot.getByTestId("workflow-graph").querySelectorAll("[data-testid^='wf-edge-'][data-changed='1']").length).toBeGreaterThan(0));

    // A node click opens the panel slot: the editor's form goes here.
    fireEvent.click(slot.getByTestId("wf-node-summarise"));
    expect((await slot.findByTestId("wf-node-panel")).textContent).toContain("Summarise the items.");
  });
});
