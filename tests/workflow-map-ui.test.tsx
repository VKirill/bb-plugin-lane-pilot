/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { parseWorkflow } from "@lane-pilot/workflow-engine";
import { buildWorkflowMap } from "../src/rooms/workflow/server/workflow-map";
import { workflow } from "./workflow/fixtures";

// The map pulls in xyflow and elkjs on first use; a cold import under load can pass the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  // xyflow reads the viewport transform through DOMMatrixReadOnly, which jsdom lacks.
  class Matrix { m22 = 1; m41 = 0; m42 = 0; constructor(_init?: string) {} }
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
});
afterEach(() => { cleanup(); setLocaleOverride(null); });

const item = (definition: Record<string, unknown>, origin: "builtin" | "global" | "project" = "global") =>
  ({ workflow: parseWorkflow(definition as never), origin, source: "test.json", sha256: "sha", warnings: [] });

const reviewFix = () => workflow({
  id: "review-fix", name: { en: "Review and fix", ru: "Ревью и правки" }, description: { en: "Build, review", ru: "Собрать, проверить" }, status: "published",
  nodes: [
    { id: "build", type: "agent", role: "builder", prompt: "Build the thing.", output: [{ name: "done", type: "boolean" }] },
    { id: "ship", type: "action", action: "ship", output: [{ name: "text", type: "string" }] },
  ],
  edges: [{ from: "start", to: "build" }, { from: "build", to: "ship" }, { from: "ship", to: "end", with: { result: "ship.text" } }],
});
const digest = () => workflow({
  id: "x-digest", name: { en: "X digest", ru: "Сводка из X" }, description: { en: "Post a digest", ru: "Сводка" }, status: "draft", tags: ["social"],
  nodes: [
    { id: "search", type: "agent", role: "plan-researcher", prompt: "Search.", output: [{ name: "items", type: "array" }] },
    { id: "call", type: "subworkflow", workflow: "review-fix", output: [{ name: "text", type: "string" }] },
  ],
  edges: [{ from: "start", to: "search" }, { from: "search", to: "call" }, { from: "call", to: "end", with: { result: "call.text" } }],
});

const data = () => ({
  ...buildWorkflowMap([item(reviewFix(), "builtin"), item(digest())], () => ({ runs30d: 3, successRate: 1 }), "v-test", "en"),
  project: "not_requested" as const,
});

async function mount(props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { WorkflowMap } = await import("../src/rooms/workflow/ui/workflow-map");
  const rpc = { workflow_map: async () => data(), get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }) };
  return renderSlot({ component: () => <WorkflowMap locale="en" projectId={null} {...props} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("Workflow map", () => {
  it("shows the counts, draws a box per graph and opens a step's card", async () => {
    const opened: string[] = [];
    const slot = await mount({ onOpenGraph: (id: string) => opened.push(id) });
    const canvas = await slot.findByTestId("wf-map-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-layout")).toBe("ready"));
    expect(slot.getByTestId("wf-map-stats").textContent).toContain("2 graphs · 4 steps · 7 links");
    expect(slot.getByTestId("wf-map-stats").textContent).toContain("v-test");

    // Collapsed by default: a box per graph, no step cards.
    expect(slot.getByTestId("wm-graph-review-fix")).toBeTruthy();
    expect(slot.getByTestId("wm-graph-x-digest")).toBeTruthy();
    expect(slot.queryByTestId("wm-step-review-fix/build")).toBeNull();

    // Click a graph: its steps appear; click a step: its card opens.
    fireEvent.click(slot.getByTestId("wm-graph-review-fix"));
    await slot.findByTestId("wm-step-review-fix/build");
    fireEvent.click(slot.getByTestId("wm-step-review-fix/build"));
    const card = await slot.findByTestId("wf-map-card");
    expect(card.textContent).toContain("Review and fix");
    expect(card.textContent).toContain("builder");
    // The full step description: the task and where the run goes next, ready to copy.
    expect(card.textContent).toContain("Build the thing.");
    expect(slot.getAllByTestId("wf-map-fact").map((node) => node.querySelector("dt")?.textContent)).toContain("Next");
    expect(slot.getByTestId("wf-map-copy")).toBeTruthy();
    fireEvent.click(slot.getByTestId("wf-map-open"));
    expect(opened).toEqual(["review-fix"]);
  });

  it("dims non-matching boxes on search and filters by category", async () => {
    const slot = await mount();
    const canvas = await slot.findByTestId("wf-map-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-layout")).toBe("ready"));

    fireEvent.change(slot.getByTestId("wf-map-search"), { target: { value: "digest" } });
    await waitFor(() => expect(slot.getByTestId("wm-graph-review-fix").getAttribute("data-dim")).toBe("1"));
    expect(slot.getByTestId("wm-graph-x-digest").getAttribute("data-dim")).toBe("0");
    fireEvent.change(slot.getByTestId("wf-map-search"), { target: { value: "" } });

    // The category filter keeps only its shelf: «content» holds the digest (tag «social»), «code» the rest.
    fireEvent.click(slot.getByTestId("wf-map-cat"));
    fireEvent.click(await slot.findByRole("option", { name: "Content" }));
    await waitFor(() => expect(slot.queryByTestId("wm-graph-review-fix")).toBeNull());
    expect(slot.getByTestId("wm-graph-x-digest")).toBeTruthy();
    expect(slot.getByTestId("wf-map-stats").textContent).toContain("1 graphs");
  });
});
