/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { setPendingNativeAgent } from "../src/ui/pending-native-agent";
import { requestArchitectLaunch, takeArchitectLaunch } from "../src/rooms/workflow/ui/architect-launch";

const hiddenData = vi.hoisted(() => ({ value: null as null | { token: string } }));
const installStarts = vi.hoisted(() => [] as string[]);
const prepared: string[] = [];
vi.mock("@get-bb/plugin-sdk/app", async (original) => {
  const sdk = await original<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...sdk,
    useComposer: () => ({ ...sdk.useComposer(), experimental_vkSetDispatchData: (data: null | { token: string }) => { hiddenData.value = data; } }),
    experimental_useComposerSelection: () => ({
      status: "ready", scope: { kind: "new-thread", projectId: "p1" }, projectId: "p1", providerId: "claude-code", model: "claude-opus-5-5[1m]", reasoningLevel: "medium",
      environment: { kind: "provisioning", type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_a" } },
      environmentRequest: { type: "provider" }, environmentProvenance: { projectId: "p1", sectionId: null },
    }),
  };
});

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
    mainAgent?: string | null;
  };
  activate?: (args: unknown) => Promise<{ threadId: string; runId: string }>;
}) {
  const app = await loadPluginApp(() => import("../app"));
  const action = app.composerCustomizations[0]?.actions?.[0];
  if (!action) throw new Error("missing composer action");
  return renderSlot({ component: action.component }, {}, {
    context: { projectId: input.projectId, threadId: input.threadId },
    composer: { scope: input.scope, text: "Please review this project" },
    rpc: {
      get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
      activation_context: (request: unknown) => { const args = request as { projectId: string | null }; return {
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
        mainAgent: input.context.mainAgent ?? null,
      }; },
      activate_pm: input.activate ?? (async () => ({ threadId: "thr_pm", runId: "run_1" })),
      native_install_start: async (input: unknown) => { installStarts.push((input as { hostId: string }).hostId); return { started: true }; },
      prepare_native_session: async (request: unknown) => { const { agentId } = request as { agentId: string }; prepared.push(agentId); return {
        token: "11111111-1111-1111-1111-111111111111",
        label: agentId === "copy-lead" ? "Night desk" : "Development coordinator",
        agentId: agentId || "dev-orchestrator",
        profileMode: "installed",
        cliAgentsCollision: null,
      }; },
    },
  });
}

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
  hiddenData.value = null;
  installStarts.length = 0;
  prepared.length = 0;
  setPendingNativeAgent(null);
});

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

  it("switches native pickers, attaches hidden selection and preserves the draft", async () => {
    const slot = await mountComposer({
      projectId: "proj_route",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }] },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Enable Lane Pilot" }));
    await slot.findByTestId("activation-popover");
    fireEvent.click(slot.getByRole("button", { name: "Enable for this chat" }));
    await waitFor(() => expect(hiddenData.value).toEqual({ token: "11111111-1111-1111-1111-111111111111" }));
    await waitFor(() => expect(installStarts).toEqual(["host_a"]));
    expect(slot.inspection.composer.mentions).toEqual([]);
    expect(slot.inspection.composer.text).toBe("Please review this project");
    expect(slot.inspection.composer.selections).toEqual([{ providerId: "claude-code", model: "claude-opus-5-5[1m]", permissionMode: "full" }]);
    fireEvent.click(slot.getByRole("button", { name: "Lane Pilot enabled" }));
    fireEvent.click(await slot.findByRole("button", { name: "Disable for this chat" }));
    expect(hiddenData.value).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("starts a new chat with Lane Pilot on and the project's main agent, and stays off once turned off", async () => {
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }], mainAgent: "copy-lead",
        mainAgents: [{ id: "dev-orchestrator", description: "Development coordinator" }, { id: "copy-lead", description: "Night desk" }] },
    });
    await waitFor(() => expect(hiddenData.value).toEqual({ token: "11111111-1111-1111-1111-111111111111" }));
    expect(prepared).toEqual(["copy-lead"]);
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot enabled" }));
    fireEvent.click(await slot.findByRole("button", { name: "Disable for this chat" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hiddenData.value).toBeNull();
    expect(prepared).toEqual(["copy-lead"]);
    slot.lifecycle.unmount();
  });

  it("leaves Lane Pilot off in a project without a main agent", async () => {
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }] },
    });
    await slot.findByRole("button", { name: "Enable Lane Pilot" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prepared).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("prepares the Workflow architect when the Workflows tab asked for it, over the project's main agent, once", async () => {
    requestArchitectLaunch("proj_a");
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }], mainAgent: "copy-lead",
        mainAgents: [{ id: "dev-orchestrator", description: "Development coordinator" }, { id: "copy-lead", description: "Night desk" }, { id: "workflow-architect", description: "Workflow architect" }] },
    });
    await waitFor(() => expect(hiddenData.value).toEqual({ token: "11111111-1111-1111-1111-111111111111" }));
    expect(prepared).toEqual(["workflow-architect"]);
    // The request was taken: another composer of the project starts as it always did.
    expect(takeArchitectLaunch("proj_a")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("takes an architect request once, only for its project, and not after it lapsed", () => {
    requestArchitectLaunch("proj_a", 1_000);
    expect(takeArchitectLaunch("proj_b", 1_001)).toBeNull();
    expect(takeArchitectLaunch(null, 1_001)).toBeNull();
    expect(takeArchitectLaunch("proj_a", 1_002)).toBe("workflow-architect");
    expect(takeArchitectLaunch("proj_a", 1_003)).toBeNull();
    requestArchitectLaunch("proj_a", 1_000);
    expect(takeArchitectLaunch("proj_a", 1_000 + 61_000)).toBeNull();
    requestArchitectLaunch("proj_a", 1_000);
    expect(takeArchitectLaunch("proj_a", 1_000 + 30_000)).toBe("workflow-architect");
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
    await waitFor(() => expect(hiddenData.value?.token).toBeTruthy());
    expect(slot.inspection.composer.mentions).toEqual([]);
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
