/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseLpSignal } from "@lane-pilot/ui-kit/realtime-channel";

afterEach(() => cleanup());


const summary = (version: number, nodes: number) => ({
  id: "wfd_1", projectId: "proj_1", threadId: "thr_1", workflowId: "demo", scope: "global", name: { en: "Demo", ru: "Демо" }, status: "draft", version, nodes, edges: nodes, errors: 0,
  tested: "none", publishedPath: null, updatedAt: version,
});

describe("the open draft follows the architect's patches", () => {
  it("re-reads on a workflow-draft signal for its draft and ignores other drafts, kinds and projects", async () => {
    await loadPluginApp(() => import("../app"));
    // Imported after the app, so it binds to the SDK the test harness provides.
    const { useWorkflowDraft } = await import("../src/rooms/workflow/ui/workflow-draft");
    const Probe = ({ projectId, draftId }: { projectId: string; draftId: string }) => {
      const view = useWorkflowDraft(projectId, draftId);
      return <div data-testid="draft">{view.loading ? "loading" : `v${view.draft?.version ?? "-"} nodes ${view.check?.nodes ?? "-"} ${view.error ?? ""}`}</div>;
    };
    const state = { version: 2, nodes: 1, reads: 0 };
    const slot = await renderSlot({ component: () => <Probe projectId="proj_1" draftId="wfd_1" /> }, {}, {
      context: { projectId: "proj_1", threadId: null },
      rpc: {
        workflow_draft_get: () => {
          state.reads += 1;
          return { draft: summary(state.version, state.nodes), definition: { id: "demo", nodes: [], edges: [] }, check: { valid: false, errors: 1, warnings: 0, nodes: state.nodes, edges: state.nodes, problems: [] }, tests: null, history: [] };
        },
      },
    });
    await waitFor(() => expect(slot.getByTestId("draft").textContent).toBe("v2 nodes 1 "));
    const before = state.reads;

    state.version = 3; state.nodes = 2;
    await slot.behavior.emitRealtime("lp:proj_1", { kind: "workflow-draft", draftId: "wfd_1", threadId: "thr_1" });
    await waitFor(() => expect(slot.getByTestId("draft").textContent).toBe("v3 nodes 2 "));
    expect(state.reads).toBe(before + 1);

    await slot.behavior.emitRealtime("lp:proj_1", { kind: "workflow-draft", draftId: "wfd_other" });
    await slot.behavior.emitRealtime("lp:proj_1", { kind: "council" });
    await slot.behavior.emitRealtime("lp:proj_2", { kind: "workflow-draft", draftId: "wfd_1" });
    expect(state.reads).toBe(before + 1);
    slot.lifecycle.unmount();
  });

  it("carries the draft id on the signal and drops a malformed one", () => {
    expect(parseLpSignal({ kind: "workflow-draft", draftId: "wfd_1", threadId: "thr_1" })).toEqual({ kind: "workflow-draft", threadId: "thr_1", draftId: "wfd_1" });
    expect(parseLpSignal({ kind: "workflow-draft", draftId: 7 })).toEqual({ kind: "workflow-draft" });
    expect(parseLpSignal({ kind: "workflows" })).toBeNull();
  });
});
