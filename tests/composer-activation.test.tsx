/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "../i18n";

async function mountComposer(input: {
  projectId: string | null;
  threadId: string | null;
  scope: { kind: "new-thread"; projectId: string | null } | { kind: "thread"; threadId: string };
  context: {
    bindingStatus: "resolved" | "setup_required" | null;
    projects: Array<{ id: string; name: string }>;
    compiledMainAgent?: "supported" | "none";
    pluginRole?: string | null;
    threadStatus?: string | null;
    liveRun?: { threadId: string; runId: string } | null;
  };
  activate?: (args: unknown) => Promise<{ threadId: string; runId: string }>;
}) {
  const app = await loadPluginApp(() => import("../app"));
  const action = app.composerCustomizations[0]?.actions?.[0];
  if (!action) throw new Error("missing composer action");
  return renderSlot({ component: action.component }, {}, {
    context: { projectId: input.projectId, threadId: input.threadId },
    composer: { scope: input.scope },
    rpc: {
      get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
      activation_context: () => ({
        projectId: input.projectId,
        projects: input.context.projects,
        bindingStatus: input.context.bindingStatus,
        compiledMainAgent: input.context.compiledMainAgent ?? "none",
        mainAgents: [{ id: "dev-orchestrator", description: "Lane Pilot development orchestrator" }],
        writer: { providerId: "codex", model: "test-model", reasoningEffort: "medium" },
        liveRun: input.context.liveRun ?? null,
        pluginRole: input.context.pluginRole ?? null,
        threadStatus: input.context.threadStatus ?? null,
      }),
      activate_pm: input.activate ?? (async () => ({ threadId: "thr_pm", runId: "run_1" })),
    },
  });
}

afterEach(() => { cleanup(); setLocaleOverride(null); });

describe("Enable Lane Pilot composer action", () => {
  it("keeps Enable clickable with no project and requires a project before start", async () => {
    const slot = await mountComposer({
      projectId: null,
      threadId: null,
      scope: { kind: "new-thread", projectId: null },
      context: { bindingStatus: null, projects: [{ id: "proj_a", name: "Alpha" }] },
    });
    const enable = await slot.findByRole("button", { name: "Enable Lane Pilot" });
    expect((enable as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(enable);
    await slot.findByTestId("activation-popover");
    expect((slot.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.getByText(/project is required/i)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("starts a new-thread session with a selected project and null sourceThreadId", async () => {
    const calls: unknown[] = [];
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }] },
      activate: async (args) => { calls.push(args); return { threadId: "thr_pm", runId: "run_1" }; },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Enable Lane Pilot" }));
    fireEvent.click(await slot.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ projectId: "proj_a", sourceThreadId: null, agentId: "" });
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_pm" }]);
    slot.lifecycle.unmount();
  });
});
