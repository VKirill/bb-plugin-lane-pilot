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
    mainAgents?: Array<{ id: string; description: string }>;
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
      activation_context: (args: { projectId: string | null }) => ({
        projectId: args.projectId,
        projects: input.context.projects,
        bindingStatus: input.context.bindingStatus,
        compiledMainAgent: input.context.compiledMainAgent ?? "none",
        mainAgents: input.context.mainAgents ?? [
          { id: "dev-orchestrator", description: "Lane Pilot development orchestrator" },
        ],
        writer: { providerId: "codex", model: "test-model", reasoningEffort: "medium" },
        liveRun: input.context.liveRun ?? null,
        pluginRole: input.context.pluginRole ?? null,
        threadStatus: input.context.threadStatus ?? null,
        requiredSessionPolicy: "none",
      }),
      activate_pm: input.activate ?? (async () => ({ threadId: "thr_pm", runId: "run_1" })),
      prepare_native_session: async ({ agentId }: { agentId: string }) => ({
        token: "11111111-1111-1111-1111-111111111111",
        label: agentId === "copy-lead" ? "Night desk" : "Development coordinator",
        agentId: agentId || "dev-orchestrator",
        profileMode: "installed",
        cliAgentsCollision: null,
      }),
    },
  });
}

afterEach(() => { cleanup(); setLocaleOverride(null); });

describe("Enable Lane Pilot composer action", () => {
  it("registers the launch action only on the new-thread composer", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations[0]?.scopes).toEqual(["new-thread"]);
  });

  it("renders no Lane Pilot action in an existing conversation, idle or with a live run", async () => {
    for (const context of [
      { bindingStatus: "resolved" as const, projects: [{ id: "proj_a", name: "Alpha" }], threadStatus: null, pluginRole: null },
      { bindingStatus: "resolved" as const, projects: [{ id: "proj_a", name: "Alpha" }], threadStatus: "active", pluginRole: null, liveRun: { threadId: "thr_pm", runId: "run_1" } },
    ]) {
      const slot = await mountComposer({
        projectId: "proj_a",
        threadId: "thr_existing",
        scope: { kind: "thread", threadId: "thr_existing" },
        context,
      });
      expect(slot.queryByRole("button", { name: "Enable Lane Pilot" })).toBeNull();
      expect(slot.queryByRole("button", { name: /New Lane Pilot session/ })).toBeNull();
      expect(slot.queryByRole("button", { name: "Open Lane Pilot run" })).toBeNull();
      slot.lifecycle.unmount();
    }
  });

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
    expect(slot.queryByLabelText("Choose a project")).toBeNull();
    expect((slot.getByRole("button", { name: "Enable for this chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.getByText(/BB composer first/i)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("inserts a unique mention and does not spawn", async () => {
    const slot = await mountComposer({
      projectId: "proj_route",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }] },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Enable Lane Pilot" }));
    await slot.findByTestId("activation-popover");
    fireEvent.click(slot.getByRole("button", { name: "Enable for this chat" }));
    await waitFor(() => expect(slot.inspection.composer.mentions).toEqual([
      { provider: "lane-pilot", id: "11111111-1111-1111-1111-111111111111", label: "Development coordinator" },
    ]));
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("enables a section session even when the parent project has no folder binding", async () => {
    const slot = await mountComposer({
      projectId: "clients",
      threadId: null,
      scope: { kind: "new-thread", projectId: "clients" },
      context: {
        bindingStatus: "setup_required",
        projects: [{ id: "clients", name: "Clients" }],
        mainAgents: [{ id: "dev-orchestrator", description: "Section developer" }],
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Enable Lane Pilot" }));
    await slot.findByText("Section developer");
    const start = slot.getByRole("button", { name: "Enable for this chat" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(slot.inspection.composer.mentions).toHaveLength(1));
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("shows locale stock labels and keeps a custom agent name", async () => {
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: {
        bindingStatus: "resolved",
        projects: [{ id: "proj_a", name: "Alpha" }],
        mainAgents: [
          { id: "dev-orchestrator", description: "Lane Pilot development orchestrator" },
          { id: "copy-lead", description: "Night desk" },
        ],
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Enable Lane Pilot" }));
    await slot.findByTestId("activation-popover");
    fireEvent.click(slot.getByLabelText("Lane Pilot agent"));
    expect(slot.queryByText("No specialist agent")).toBeNull();
    expect(slot.getAllByText("Development coordinator").length).toBeGreaterThan(0);
    expect(slot.getByText("Night desk")).toBeTruthy();
    expect(slot.queryByText("Lane Pilot development orchestrator")).toBeNull();
    expect(slot.queryByText("Lane Pilot copy lead")).toBeNull();
    slot.lifecycle.unmount();
  });
});
