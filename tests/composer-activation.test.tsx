/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { getPendingNativeAgent, setPendingNativeAgent } from "../src/rooms/native-agent/ui/pending-native-agent";
import { requestArchitectLaunch, takeArchitectLaunch } from "../src/rooms/workflow/ui/architect-launch";

const hiddenData = vi.hoisted(() => ({ value: null as null | { token: string } }));
const installStarts = vi.hoisted(() => [] as string[]);
const running = vi.hoisted(() => ({ value: false }));
const prepared: string[] = [];
const switches: Array<{ threadId: string; agentId: string | null }> = [];
vi.mock("@get-bb/plugin-sdk/app", async (original) => {
  const sdk = await original<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...sdk,
    useComposer: () => { const view = sdk.useComposer(); return { ...(running.value ? { ...view, isRunning: true } : view), experimental_vkSetDispatchData: (data: null | { token: string }) => { hiddenData.value = data; } }; },
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
    mainAgents?: Array<{ id: string; description: string; custom?: boolean; kind?: "coordinator" | "specialist" | "internal" }>;
    pluginRole?: string | null;
    threadStatus?: string | null;
    liveRun?: { threadId: string; runId: string } | null;
    mainAgent?: string | null;
  };
  activate?: (args: unknown) => Promise<{ threadId: string; runId: string }>;
  chat?: { eligible?: boolean; reason?: "helper" | "provider" | "lane_started" | "specialist_run" | null; current?: { agentId: string; description: string; pending: boolean } | null };
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
      chat_agent_state: () => ({ projectId: input.projectId ?? "proj_a", eligible: input.chat?.eligible ?? true, reason: input.chat?.reason ?? null, current: input.chat?.current ?? null }),
      switch_chat_agent: async (request: unknown) => {
        const { threadId, agentId } = request as { threadId: string; agentId: string | null };
        switches.push({ threadId, agentId });
        return { agentId, description: agentId === "copy-lead" ? "Night desk" : agentId ? "Development coordinator" : null };
      },
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
  switches.length = 0;
  running.value = false;
  setPendingNativeAgent(null);
});

/** Opens the «Agent» dropdown of the popover and picks a row by its label. */
function pickAgent(slot: { getByRole: (role: string, options?: { name: string }) => HTMLElement }, name: string): void {
  fireEvent.click(slot.getByRole("combobox", { name: "Agent" }));
  fireEvent.click(slot.getByRole("option", { name }));
}

describe("Enable Lane Pilot composer action", () => {
  it("registers the launch action only on the new-thread composer", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations[0]?.scopes).toEqual(["new-thread", "thread"]);
  });

  const chatAgents = [
    { id: "dev-orchestrator", description: "Lane Pilot development orchestrator" },
    { id: "copy-lead", description: "Lane Pilot copy lead" },
  ];
  const existingChat = (chat: Parameters<typeof mountComposer>[0]["chat"] = {}) => mountComposer({
    projectId: "proj_a",
    threadId: "thr_existing",
    scope: { kind: "thread", threadId: "thr_existing" },
    context: { bindingStatus: "resolved", projects: [{ id: "proj_a", name: "Alpha" }], mainAgents: chatAgents },
    chat,
  });

  it("shows the switch and the dropdown in an existing chat with the chat's current agent selected", async () => {
    const slot = await existingChat({ current: { agentId: "copy-lead", description: "Lane Pilot copy lead", pending: false } });
    fireEvent.click(await slot.findByRole("button", { name: "Copy editor" }));
    await slot.findByTestId("activation-popover");
    expect(slot.getByRole("switch", { name: "Lane Pilot" }).getAttribute("aria-checked")).toBe("false");
    expect(slot.getByRole("combobox", { name: "Agent" }).textContent).toBe("Copy editor");
    expect(slot.getByText(/from your next message/i)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("turns Lane Pilot on in a plain chat from its next message: the server switches it, no dispatch token is attached", async () => {
    const slot = await existingChat();
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    await slot.findByTestId("activation-popover");
    const laneSwitch = () => slot.getByRole("switch", { name: "Lane Pilot" });
    expect(laneSwitch().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(laneSwitch());
    await waitFor(() => expect(laneSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(switches).toEqual([{ threadId: "thr_existing", agentId: "dev-orchestrator" }]);
    expect(prepared).toEqual([]);
    expect(hiddenData.value).toBeNull();
    expect(getPendingNativeAgent()).toBeNull();
    expect(slot.inspection.composer.text).toBe("Please review this project");
    expect(slot.inspection.composer.selections).toEqual([{ providerId: "claude-code", model: "claude-opus-5-5[1m]", permissionMode: "full" }]);
    slot.lifecycle.unmount();
  });

  it("moves an existing chat from one agent to another and back to a plain chat", async () => {
    const slot = await existingChat({ current: { agentId: "dev-orchestrator", description: "Lane Pilot development orchestrator", pending: false } });
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot" }));
    await slot.findByTestId("activation-popover");
    const laneSwitch = () => slot.getByRole("switch", { name: "Lane Pilot" });
    expect(laneSwitch().getAttribute("aria-checked")).toBe("true");
    pickAgent(slot, "Copy editor");
    await waitFor(() => expect(slot.getByRole("combobox", { name: "Agent" }).textContent).toBe("Copy editor"));
    expect(laneSwitch().getAttribute("aria-checked")).toBe("false");
    pickAgent(slot, "No agent");
    await waitFor(() => expect(switches.at(-1)).toEqual({ threadId: "thr_existing", agentId: null }));
    await waitFor(() => expect(slot.getByRole("combobox", { name: "Agent" }).textContent).toBe("No agent"));
    expect(switches.map((row) => row.agentId)).toEqual(["copy-lead", null]);
    slot.lifecycle.unmount();
  });

  it("locks the controls with the reason for a chat on another provider and hides them in a run's helper chat", async () => {
    const other = await existingChat({ eligible: false, reason: "provider" });
    fireEvent.click(await other.findByRole("button", { name: "Lane Pilot / agent" }));
    await other.findByTestId("activation-popover");
    expect((other.getByRole("switch", { name: "Lane Pilot" }) as HTMLButtonElement).disabled).toBe(true);
    expect(other.getByText(/Start a new Claude Code chat/)).toBeTruthy();
    other.lifecycle.unmount();
    const helper = await existingChat({ eligible: false, reason: "helper" });
    await waitFor(() => expect(switches).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(helper.queryByRole("button", { name: "Lane Pilot / agent" })).toBeNull();
    helper.lifecycle.unmount();
  });

  it("keeps the controls off while the chat is replying", async () => {
    running.value = true;
    const slot = await existingChat();
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    await slot.findByTestId("activation-popover");
    expect((slot.getByRole("switch", { name: "Lane Pilot" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.getByText(/Wait until the reply ends/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps Enable clickable with no project and requires a project before start", async () => {
    const slot = await mountComposer({
      projectId: null,
      threadId: null,
      scope: { kind: "new-thread", projectId: null },
      context: { bindingStatus: null, projects: [{ id: "proj_a", name: "Alpha" }] },
    });
    const enable = await slot.findByRole("button", { name: "Lane Pilot / agent" });
    expect((enable as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(enable);
    await slot.findByTestId("activation-popover");
    expect(slot.queryByLabelText("Choose a project")).toBeNull();
    expect((slot.getByRole("switch", { name: "Lane Pilot" }) as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    await slot.findByTestId("activation-popover");
    fireEvent.click(slot.getByRole("switch", { name: "Lane Pilot" }));
    await waitFor(() => expect(hiddenData.value).toEqual({ token: "11111111-1111-1111-1111-111111111111" }));
    expect(prepared).toEqual(["dev-orchestrator"]);
    expect(slot.getByRole("switch", { name: "Lane Pilot" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(installStarts).toEqual(["host_a"]));
    expect(slot.inspection.composer.mentions).toEqual([]);
    expect(slot.inspection.composer.text).toBe("Please review this project");
    expect(slot.inspection.composer.selections).toEqual([{ providerId: "claude-code", model: "claude-opus-5-5[1m]", permissionMode: "full" }]);
    fireEvent.click(slot.getByRole("switch", { name: "Lane Pilot" }));
    expect(hiddenData.value).toBeNull();
    expect(slot.getByRole("switch", { name: "Lane Pilot" }).getAttribute("aria-checked")).toBe("false");
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
    fireEvent.click(await slot.findByRole("button", { name: "Night desk" }));
    await slot.findByTestId("activation-popover");
    pickAgent(slot, "No agent");
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
    await slot.findByRole("button", { name: "Lane Pilot / agent" });
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
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    const start = await slot.findByRole("switch", { name: "Lane Pilot" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(hiddenData.value?.token).toBeTruthy());
    expect(slot.inspection.composer.mentions).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("lists specialists and custom agents, not the coordinator or internal agents", async () => {
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: {
        bindingStatus: "resolved",
        projects: [{ id: "proj_a", name: "Alpha" }],
        mainAgents: [
          { id: "dev-orchestrator", description: "Lane Pilot development orchestrator" },
          { id: "copy-lead", description: "Lane Pilot copy lead" },
          { id: "project-onboarder", description: "Lane Pilot project onboarder" },
          { id: "my-video", description: "Video agent", custom: true, kind: "specialist" },
          { id: "hidden-helper", description: "Hidden helper", kind: "internal" },
          { id: "my-lead", description: "Own coordinator", kind: "coordinator" },
        ],
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    await slot.findByTestId("activation-popover");
    fireEvent.click(slot.getByRole("combobox", { name: "Agent" }));
    expect(slot.getAllByRole("option").map((row) => row.textContent)).toEqual(["No agent", "Copy editor", "Video agent"]);
    expect(slot.queryByText("Development coordinator")).toBeNull();
    expect(slot.queryByText("Project onboarding")).toBeNull();
    expect(slot.queryByText("Lane Pilot development orchestrator")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("picking a specialist turns Lane Pilot off, and the switch turns the specialist off", async () => {
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
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    await slot.findByTestId("activation-popover");
    const laneSwitch = () => slot.getByRole("switch", { name: "Lane Pilot" });
    fireEvent.click(laneSwitch());
    await waitFor(() => expect(laneSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(getPendingNativeAgent()?.agentId).toBe("dev-orchestrator");
    expect(slot.getByRole("button", { name: "Lane Pilot" }).getAttribute("data-lp-agent")).toBe("lane-pilot");
    pickAgent(slot, "Night desk");
    await waitFor(() => expect(laneSwitch().getAttribute("aria-checked")).toBe("false"));
    expect(slot.getByRole("button", { name: "Night desk" }).getAttribute("data-lp-agent")).toBe("specialist");
    expect(slot.getByRole("combobox", { name: "Agent" }).textContent).toBe("Night desk");
    expect(prepared).toEqual(["dev-orchestrator", "copy-lead"]);
    expect(getPendingNativeAgent()?.agentId).toBe("copy-lead");
    expect(hiddenData.value).toEqual({ token: "11111111-1111-1111-1111-111111111111" });
    expect(slot.inspection.composer.text).toBe("Please review this project");
    // The switch back on replaces the specialist; «No agent» clears everything.
    fireEvent.click(laneSwitch());
    await waitFor(() => expect(laneSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(slot.getByRole("combobox", { name: "Agent" }).textContent).toBe("No agent");
    fireEvent.click(laneSwitch());
    await waitFor(() => expect(laneSwitch().getAttribute("aria-checked")).toBe("false"));
    expect(getPendingNativeAgent()).toBeNull();
    expect(hiddenData.value).toBeNull();
    expect(slot.getByRole("button", { name: "Lane Pilot / agent" }).getAttribute("data-lp-agent")).toBe("off");
    slot.lifecycle.unmount();
  });

  it("names the trigger after the chosen agent and the coordinator «Lane Pilot»", async () => {
    const slot = await mountComposer({
      projectId: "proj_a",
      threadId: null,
      scope: { kind: "new-thread", projectId: "proj_a" },
      context: {
        bindingStatus: "resolved",
        projects: [{ id: "proj_a", name: "Alpha" }],
        mainAgents: [
          { id: "dev-orchestrator", description: "Lane Pilot development orchestrator" },
          { id: "copy-lead", description: "Lane Pilot copy lead" },
        ],
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Lane Pilot / agent" }));
    await slot.findByTestId("activation-popover");
    pickAgent(slot, "Copy editor");
    await slot.findByRole("button", { name: "Copy editor" });
    fireEvent.click(slot.getByRole("switch", { name: "Lane Pilot" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Lane Pilot" })).toBeTruthy());
    slot.lifecycle.unmount();
  });
});
