/** @vitest-environment jsdom */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { loadProjectSettings, migrations } from "../src/rooms/storage/database";
import { createWorkflowArchitect } from "../src/rooms/workflow/server/workflow-architect";
import type { ArchitectDeps } from "../src/rooms/workflow/server/workflow-architect";
import { createWorkflowLibrary } from "../src/rooms/workflow/server/workflow-library";
import { createWorkflowModels } from "../src/rooms/workflow/server/workflow-models";
import type { ServerCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { BROWSER_DIGEST_STEPS } from "./workflow/architect-fixture";
import { engineOn } from "./workflow/engine-helpers";
import { workflow } from "./workflow/fixtures";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  class Matrix { m22 = 1; m41 = 0; m42 = 0; constructor(_init?: string) {} }
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
});
afterEach(() => { cleanup(); setLocaleOverride(null); });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const projectId = "proj_models";
const settings = { "writer.provider": "codex", "writer.model": "gpt-6-luna", "writer.reasoning_effort": "high", "writer.service_tier": "fast", "jev.LANE_JEV_EFFORT": false };

const info = (id: string, name: string, available = true) => ({ id, displayName: name, available, logoUrl: null, capabilities: { supportsServiceTier: id === "codex" }, ...(id === "codex" ? { serviceTiers: [{ id: "default" }, { id: "fast" }] } : {}) });
const model = (id: string, name: string, efforts: string[], isDefault = false) => ({ id, model: id, displayName: name, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: efforts[0], isDefault });
/** The Mac mini has Claude, Codex and OpenCode (Gemini, DeepSeek gone); OVH has Codex only; router9 is nowhere. */
const bb = {
  sdk: {
    hosts: { list: async () => [{ id: "mac", name: "Mac mini", status: "connected" }, { id: "ovh", name: "OVH", status: "connected" }] },
    providers: {
      list: async ({ hostId }: { hostId: string }) => (hostId === "mac" ? [info("claude-code", "Claude Code"), info("codex", "Codex"), info("acp-opencode", "OpenCode"), info("router9", "router9", false)] : [info("codex", "Codex")]),
      models: async ({ providerId, hostId }: { providerId: string; hostId: string }) => ({
        models: providerId === "claude-code" ? [model("claude-opus-5-5", "Opus 5.5", ["low", "medium", "high", "xhigh"], true), model("claude-sonnet-5-5", "Sonnet 5.5", ["low", "medium", "high"])]
          : providerId === "codex" ? [model("gpt-6-luna", "GPT-6 Luna", ["low", "medium", "high"], true)]
            : providerId === "acp-opencode" && hostId === "mac" ? [model("router9/ag/gemini-3.8-flash-high", "Gemini 3.8 Flash", ["medium", "high"], true), model("deepseek/v4", "DeepSeek V4", ["high"])] : [],
      }),
    },
  },
};

async function world() {
  const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = host.storage.database();
  host.storage.migrate(db, migrations);
  const globalDir = await mkdtemp(join(tmpdir(), "lp-models-ui-"));
  dirs.push(globalDir);
  await writeFile(join(globalDir, "mine.json"), JSON.stringify(workflow({
    id: "mine", name: { en: "Mine", ru: "Мой" }, status: "published",
    nodes: [{ id: "search", type: "agent", role: "researcher", prompt: "Search.", output: [{ name: "items", type: "array" }] }],
    edges: [{ from: "start", to: "search" }, { from: "search", to: "end", with: { result: "search.handoff" } }],
  })));
  const emit: { current: ((payload: unknown) => Promise<unknown>) | null } = { current: null };
  const kv = new Map<string, unknown>();
  const ctx = { bb: { ...bb, log: { info: () => undefined }, storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } } }, db, log: () => undefined, effectiveProjectSettings: async (scope: string) => ({ values: { ...settings, ...loadProjectSettings(db, scope) } }),
    realtime: { notify: (_project: string, kind: string, threadId?: string, draftId?: string) => { void emit.current?.({ kind, ...(draftId ? { draftId } : {}), ...(threadId ? { threadId } : {}) }); } },
    host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
  const deps: ArchitectDeps = {
    globalDir: () => globalDir, projectPlace: async () => null, writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "no machine" }), hasExecutor: () => true,
    capabilityPorts: () => ({ hosts: async () => [{ id: "mac", name: "Mac mini", connected: true }] }),
  };
  const engine = engineOn(db, {}, { resolveWorkflow: () => null });
  const services = { workflowEngine: engine, docsPlaces: async () => [] } as unknown as Services;
  const architect = createWorkflowArchitect(ctx, services, deps);
  const library = createWorkflowLibrary(ctx, services, { globalDir });
  const models = createWorkflowModels(ctx, { drafts: architect.drafts, source: library.source });
  const draft = architect.drafts.create({ projectId, threadId: null, scope: "global", name: "Browser digest", description: "Search, summarise and send" });
  for (const ops of BROWSER_DIGEST_STEPS) architect.drafts.patch(draft.id, ops);
  const calls: Array<{ method: string; input: unknown }> = [];
  const track = <T extends (input: never) => unknown>(method: string, handler: T) => (input: unknown) => { calls.push({ method, input }); return handler(input as never); };
  const rpc = {
    get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
    workflow_list: (input: { projectId?: string }) => library.list(input),
    workflow_get: (input: { id: string; projectId?: string }) => library.get(input),
    workflow_run_snapshot: (input: { runId: string }) => library.runSnapshot(input),
    workflow_draft_list: architect.rpc.workflow_draft_list,
    workflow_draft_get: architect.rpc.workflow_draft_get,
    workflow_draft_patch: track("workflow_draft_patch", architect.rpc.workflow_draft_patch),
    workflow_draft_restore: architect.rpc.workflow_draft_restore,
    workflow_draft_test: architect.rpc.workflow_draft_test,
    workflow_draft_publish: architect.rpc.workflow_draft_publish,
    workflow_draft_create: track("workflow_draft_create", () => ({ draftId: draft.id, workflowId: "x", reused: false })),
    workflow_capabilities: architect.rpc.workflow_capabilities,
    workflow_step_executors: track("workflow_step_executors", (input: never) => models.stepExecutors(input)),
    workflow_model_catalog: track("workflow_model_catalog", (input: never) => models.modelCatalog(input)),
    workflow_model_override: track("workflow_model_override", (input: never) => models.setOverride(input)),
  };
  return { architect, draftId: draft.id, rpc, calls, emit };
}

const patches = (calls: Array<{ method: string; input: unknown }>) => calls.filter((call) => call.method === "workflow_draft_patch").map((call) => call.input as { ops: Array<{ op: string; id: string; set: Record<string, unknown> }> });
type PickerValue = { providerId: string; model: string; reasoningLevel: string; serviceTier?: "default" | "fast" };
type PickerNode = HTMLElement & { __value?: PickerValue; __onChange?: (next: PickerValue) => void; __props?: Record<string, unknown> };

/** BB's own window stands in as a node that records its value and routing and lets the test answer as the owner would. */
async function loadAppWithPicker() {
  installTestPluginRuntime();
  const host = globalThis as typeof globalThis & { __bbPluginRuntime?: { pluginSdkApp: Record<string, unknown> } };
  const sdk = host.__bbPluginRuntime!.pluginSdkApp;
  host.__bbPluginRuntime!.pluginSdkApp = {
    ...sdk,
    experimental_ProviderModelPicker: (props: { value: PickerValue; onChange: (next: PickerValue) => void; routing?: { kind: string; hostId?: string }; disabled?: boolean }) => React.createElement("div", {
      "data-testid": "bb-provider-model-picker", "data-provider": props.value.providerId, "data-model": props.value.model, "data-effort": props.value.reasoningLevel,
      "data-tier": props.value.serviceTier ?? "none", "data-host": props.routing?.hostId ?? "primary", "data-disabled": props.disabled ? "1" : "0",
      ref: (node: PickerNode | null) => { if (node) { node.__value = props.value; node.__onChange = props.onChange; } },
    }),
  };
  // The SDK shim reads the runtime once, when the app is first imported: the window is swapped in before that.
  await loadPluginApp(await import("../app"));
}
/** What BB's window shows for a step: provider, model, effort and tier. */
const shownFor = (slot: Awaited<ReturnType<typeof renderSlot>>, nodeId: string) => { const node = nativeOf(slot, `wf-model-picker-${nodeId}`); return ["provider", "model", "effort", "tier"].map((key) => node.getAttribute(`data-${key}`)).join("|"); };
const nativeOf = (slot: Awaited<ReturnType<typeof renderSlot>>, testId: string) => slot.getByTestId(testId).querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
/** The owner answers in BB's window. */
async function choose(slot: Awaited<ReturnType<typeof renderSlot>>, testId: string, next: Partial<PickerValue>) {
  const node = nativeOf(slot, testId);
  node.__onChange!({ ...node.__value!, ...next });
}

async function openDraft(options: { locale?: "en" | "ru"; width?: number } = {}) {
  const w = await world();
  await loadAppWithPicker();
  const { WorkflowDraftDetail } = await import("../src/rooms/workflow/ui/workflow-draft-detail");
  const locale = options.locale ?? "en";
  const slot = await renderSlot({ component: () => <div style={{ width: options.width ?? 1100 }}><WorkflowDraftDetail draftId={w.draftId} projectId={projectId} locale={locale} onBack={() => undefined} /></div> }, {},
    { context: { projectId, threadId: null }, rpc: w.rpc as never });
  w.emit.current = (payload) => slot.behavior.emitRealtime(`lp:${projectId}`, payload);
  await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
  await slot.findByTestId("wf-model-row-search");
  return { ...w, slot };
}

describe("the Models table of a draft", () => {
  it("lists a row per step with a model: agent, BB's own picker on the step's model, where it comes from and the price class", async () => {
    const { slot } = await openDraft();
    const row = slot.getByTestId("wf-model-row-search");
    expect(within(row).getByTestId("wf-model-agent-search").textContent).toBe("researcher");
    // The window opens on what the step runs on and asks a machine that has the provider.
    const native = nativeOf(slot, "wf-model-picker-search");
    expect(native.getAttribute("data-provider")).toBe("claude-code");
    expect(native.getAttribute("data-model")).toBe("claude-opus-5-5");
    expect(native.getAttribute("data-effort")).toBe("high");
    expect(native.getAttribute("data-host")).toBe("mac");
    expect(within(row).getByTestId("wf-model-source-search").textContent).toContain("role default");
    expect(within(row).getByTestId("wf-model-cost-search").textContent).toBe("High");
    expect(row.getAttribute("data-inherited")).toBe("1");
    // The delegated action runs in the errand helper; the question to the owner has no model and is only named.
    expect(slot.getByTestId("wf-model-agent-send").textContent).toBe("telegram.send_rich");
    expect(slot.queryByTestId("wf-model-row-approve")).toBeNull();
    expect(slot.getByTestId("wf-models-none").textContent).toContain("approve");
    expect(slot.getByTestId("wf-models-summary").textContent).toContain("claude-code 4");
  });

  it("puts BB's picker on the graph card too, on the same value, and a read-only card keeps the badge", async () => {
    const { slot } = await openDraft();
    const card = await slot.findByTestId("wf-card-picker-search");
    expect(card.querySelector("[data-testid='bb-provider-model-picker']")!.getAttribute("data-model")).toBe("claude-opus-5-5");
    // The delegated action and the question have no model of their own to choose.
    expect(slot.queryByTestId("wf-card-picker-approve")).toBeNull();
    expect(slot.queryByTestId("wf-model-approve")).toBeNull();
  });

  it("choosing in BB's window writes a draft patch (provider, model, effort, fast mode), and the window follows", async () => {
    const { slot, calls } = await openDraft();
    await choose(slot, "wf-model-picker-search", { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "high" });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: "high", service_tier: null } }]);
    await waitFor(() => expect(shownFor(slot, "search")).toBe("acp-opencode|router9/ag/gemini-3.8-flash-high|high|none"));
    expect(slot.getByTestId("wf-model-row-search").getAttribute("data-inherited")).toBe("0");
    expect(slot.getByTestId("wf-model-source-search").textContent).toContain("this step");
    expect(slot.getByTestId("wf-model-cost-search").textContent).toBe("Low");
    // Fast mode goes into the node as `service_tier`.
    await choose(slot, "wf-model-picker-search", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" });
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.ops[0]!.set).toEqual({ provider: "codex", model: "gpt-6-luna", reasoning: "high", service_tier: "fast" });
    await waitFor(() => expect(shownFor(slot, "search")).toBe("codex|gpt-6-luna|high|fast"));
    await choose(slot, "wf-model-picker-search", { reasoningLevel: "low", serviceTier: "default" });
    await waitFor(() => expect(patches(calls)).toHaveLength(3));
    expect(patches(calls)[2]!.ops[0]!.set).toEqual({ provider: "codex", model: "gpt-6-luna", reasoning: "low", service_tier: null });
  });

  it("the reset hands the step back to its default and clears the fast mode with it", async () => {
    const { slot, calls, architect, draftId } = await openDraft();
    await choose(slot, "wf-model-picker-search", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" });
    await waitFor(() => expect(shownFor(slot, "search")).toBe("codex|gpt-6-luna|high|fast"));
    fireEvent.click(await slot.findByTestId("wf-model-reset-search"));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.ops[0]!.set).toEqual({ provider: null, model: null, reasoning: null, service_tier: null });
    await waitFor(() => expect(shownFor(slot, "search")).toBe("claude-code|claude-opus-5-5|high|none"));
    const node = (architect.drafts.get(draftId)!.definition.nodes as Array<Record<string, unknown>>).find((item) => item.id === "search")!;
    expect(node.provider).toBeUndefined();
    expect(node.service_tier).toBeUndefined();
  });

  it("refuses a provider or model no machine offers, and says so under the picker; one a machine has goes through", async () => {
    const { slot, calls } = await openDraft();
    await choose(slot, "wf-model-picker-search", { providerId: "router9", model: "gemini-9", reasoningLevel: "high" });
    expect((await slot.findByTestId("wf-model-error-search")).textContent).toContain("Not applied");
    expect(patches(calls)).toHaveLength(0);
    // OpenCode is on the Mac mini only: every provider the hub offers can be picked, DeepSeek included.
    await choose(slot, "wf-model-picker-search", { providerId: "acp-opencode", model: "deepseek/v4", reasoningLevel: "high" });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops[0]!.set).toMatchObject({ provider: "acp-opencode", model: "deepseek/v4", reasoning: "high" });
    expect(slot.queryByTestId("wf-model-error-search")).toBeNull();
  });

  it("the badge on the card is BB's picker too, and a choice there is the same patch", async () => {
    const { slot, calls } = await openDraft();
    const card = await slot.findByTestId("wf-card-picker-search");
    expect(card.querySelector("[data-testid='bb-provider-model-picker']")!.getAttribute("data-model")).toBe("claude-opus-5-5");
    await choose(slot, "wf-card-picker-search", { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "claude-code", model: "claude-sonnet-5-5", reasoning: "medium", service_tier: null } }]);
    await choose(slot, "wf-card-picker-search", { providerId: "router9", model: "gemini-9", reasoningLevel: "high" });
    expect((await slot.findByTestId("wf-card-refused-search")).textContent).toContain("Not applied");
    expect(patches(calls)).toHaveLength(1);
  });

  it("shows the writer chain of a code task and where Settings decide a step's model", async () => {
    const { slot, architect, draftId } = await openDraft();
    architect.rpc.workflow_draft_patch({ draftId, ops: [
      { op: "add_node", node: { id: "build", type: "lp-task", owns_paths: ["src/a.ts"], stages: ["writer-agent", "code-critique"] } },
      { op: "add_node", node: { id: "plan-check", type: "agent", role: "plan-critic", uses: "lp.plan-critique" } },
    ] } as never);
    const card = await slot.findByTestId("wf-model-build", {}, { timeout: 10_000 });
    expect(card.textContent).toContain("codex · gpt-6-luna · high");
    expect((await slot.findByTestId("wf-chain-build")).textContent).toBe("→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    const chain = slot.getByTestId("wf-model-chain-build").textContent!;
    expect(chain).toContain("opencode · gemini-3.8-flash-high · medium");
    expect(chain).toContain("Code critic: codex · gpt-6-luna · high");
    const stage = slot.getByTestId("wf-model-row-plan-check");
    expect(stage.textContent).toContain("Set in Settings: plan_critique");
    expect(within(stage).queryByTestId("wf-model-picker-plan-check")).toBeNull();
    expect(slot.getByTestId("wf-model-source-plan-check").textContent).toContain("writer settings");
  });

  it("is readable in Russian at 375 px: the rows stack and nothing runs past the edge", async () => {
    setLocaleOverride("ru");
    const { slot } = await openDraft({ locale: "ru", width: 375 });
    const row = slot.getByTestId("wf-model-row-search");
    expect(row.getAttribute("data-wide")).toBe("0");
    expect(slot.getByTestId("wf-models-panel").textContent).toContain("Модели");
    expect(within(row).getByTestId("wf-model-source-search").textContent).toContain("по умолчанию для роли");
    expect(slot.getByTestId("wf-card-picker-search").getAttribute("aria-label")).toContain("Модель шага");
  });
});

describe("the model picker of the node panel", () => {
  it("is BB's window over the hub's catalog and writes provider, model, effort and fast mode into the step", async () => {
    const { slot, calls } = await openDraft();
    fireEvent.click(slot.getByTestId("wf-edit-toggle"));
    fireEvent.click(await slot.findByTestId("wf-node-search"));
    await slot.findByTestId("wf-edit-model-picker");
    expect(slot.getByTestId("wf-edit-model-inherited").textContent).toContain("role default");
    await choose(slot, "wf-edit-model-picker", { providerId: "router9", model: "x", reasoningLevel: "high" });
    expect((await slot.findByTestId("wf-edit-model-refused")).textContent).toContain("Not applied");
    expect(patches(calls)).toHaveLength(0);
    await choose(slot, "wf-edit-model-picker", { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "medium" });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: "medium", service_tier: null } }]);
    expect(slot.queryByTestId("wf-edit-model-refused")).toBeNull();
    fireEvent.click(await slot.findByTestId("wf-edit-model-default"));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.ops[0]!.set).toEqual({ provider: null, model: null, reasoning: null, service_tier: null });
  });
});

describe("the Models table of a library workflow", () => {
  async function openLibrary(id: string, scope: "builtin" | "global") {
    const w = await world();
    await loadAppWithPicker();
    const { WorkflowDetail } = await import("../src/rooms/workflow/ui/workflow-detail");
    const opened: string[] = [];
    const slot = await renderSlot({ component: () => <div style={{ width: 1100 }}><WorkflowDetail id={id} projectId={projectId} locale="en" onBack={() => undefined} editProjectId={projectId} onEditDraft={(draftId) => opened.push(draftId)} /></div> }, {},
      { context: { projectId, threadId: null }, rpc: w.rpc as never });
    await slot.findByTestId("wf-models-panel");
    await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
    return { ...w, slot, opened, scope };
  }

  it("the built-in task pipeline shows its stages and the writer chain on the cards, and is read-only: duplicating is offered instead of pickers", async () => {
    const { slot, calls } = await openLibrary("lp-task-pipeline", "builtin");
    const writer = await slot.findByTestId("wf-model-writer");
    expect(writer.textContent).toBe("codex · gpt-6-luna · high · fast→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    expect(writer.getAttribute("data-mode")).toBe("chain");
    expect(slot.getByTestId("wf-chain-writer").textContent).toBe("→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    expect(slot.getByTestId("wf-model-pm-read").getAttribute("title")).toContain("from: writer settings (writer.model)");
    expect(slot.getByTestId("wf-model-plan-critique").textContent).toBe("codex · gpt-6-luna · high · fast");
    expect(slot.queryByTestId("wf-model-ownership-base")).toBeNull();
    expect(slot.getByTestId("wf-models-hint").textContent).toContain("built-in");
    expect(slot.getByTestId("wf-models-duplicate")).toBeTruthy();
    expect(slot.container.querySelector("[data-testid^='wf-model-picker-']")).toBeNull();
    expect(slot.getByTestId("wf-model-source-writer").textContent).toContain("writer settings");
    expect(calls.some((call) => call.method === "workflow_step_executors" && (call.input as { workflowId?: string }).workflowId === "lp-task-pipeline")).toBe(true);
  });

  it("a built-in's step takes another model without a copy: the card's picker writes a project override, the badge follows, Reset drops it", async () => {
    const { slot, calls } = await openLibrary("debug", "builtin");
    const card = await slot.findByTestId("wf-override-card-investigate");
    // The window is on the card at once; no «Duplicate to edit» stands between the owner and the choice.
    expect(slot.queryByTestId("wf-card-model-investigate")).toBeNull();
    const before = card.querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    expect(before.getAttribute("data-model")).toBe("claude-opus-5-5");
    before.__onChange!({ ...before.__value!, providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "high" });
    await waitFor(() => expect(calls.filter((call) => call.method === "workflow_model_override")).toHaveLength(1));
    expect(calls.find((call) => call.method === "workflow_model_override")!.input).toMatchObject({ projectId, scope: "project", workflowId: "debug", nodeId: "investigate", choice: { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", effort: "high" } });
    await waitFor(() => expect(slot.getByTestId("wf-override-card-investigate").getAttribute("data-active")).toBe("project"));
    expect(slot.getByTestId("wf-override-card-investigate").querySelector("[data-testid='bb-provider-model-picker']")!.getAttribute("data-model")).toBe("router9/ag/gemini-3.8-flash-high");
    expect(slot.getByTestId("wf-model-source-investigate").textContent).toContain("overridden for this project");
    expect(calls.filter((call) => call.method === "workflow_draft_create")).toHaveLength(0);
    fireEvent.click(slot.getByTestId("wf-override-reset-row-investigate"));
    await waitFor(() => expect(slot.getByTestId("wf-override-card-investigate").getAttribute("data-active")).toBe(""));
    expect(slot.getByTestId("wf-model-source-investigate").textContent).not.toContain("overridden");
  });

  it("the step panel shows the model line, where it comes from and a picker with the scope «Only this project / All projects»", async () => {
    const { slot, calls } = await openLibrary("debug", "builtin");
    fireEvent.click(await slot.findByTestId("wf-node-investigate"));
    const block = await slot.findByTestId("wf-panel-model");
    expect(within(block).getByTestId("wf-panel-model-line").textContent).toContain("claude-opus-5-5");
    expect(within(block).getByTestId("wf-panel-model-source").textContent).toContain("from:");
    fireEvent.click(within(block).getByTestId("wf-override-scope-global-panel-investigate"));
    const picker = within(block).getByTestId("wf-override-picker-panel-investigate").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    picker.__onChange!({ ...picker.__value!, providerId: "codex", model: "gpt-6-luna", reasoningLevel: "low" });
    await waitFor(() => expect(calls.filter((call) => call.method === "workflow_model_override")).toHaveLength(1));
    expect(calls.find((call) => call.method === "workflow_model_override")!.input).toMatchObject({ scope: "global", projectId, nodeId: "investigate" });
    await waitFor(() => expect(slot.getByTestId("wf-panel-model").getAttribute("data-scope")).toBe("global"));
    expect(slot.getByTestId("wf-panel-model-source").textContent).toContain("overridden for all projects");
    expect(slot.getByTestId("wf-panel-model-line").textContent).toContain("gpt-6-luna");
  });

  it("choosing a model for an own workflow opens a draft with the change; a model no machine has opens nothing", async () => {
    const { slot, calls, opened } = await openLibrary("mine", "global");
    await slot.findByTestId("wf-model-picker-search");
    await choose(slot, "wf-model-picker-search", { providerId: "router9", model: "gemini-9", reasoningLevel: "high" });
    expect((await slot.findByTestId("wf-model-error-search")).textContent).toContain("Not applied");
    expect(calls.filter((call) => call.method === "workflow_draft_create")).toHaveLength(0);
    await choose(slot, "wf-model-picker-search", { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "high" });
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls.filter((call) => call.method === "workflow_draft_create")).toHaveLength(1);
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: "high", service_tier: null } }]);
  });

  it("a workflow whose agents live in a called workflow lists them under that workflow, keyed <workflow>/<node>, and the override is set from the parent's view", async () => {
    const { slot, calls } = await openLibrary("analyze-code", "builtin");
    // The Models card is not empty: the steps of lp.analyze are in it.
    await slot.findByTestId("wf-model-row-lp.analyze/gather");
    expect(slot.queryByTestId("wf-models-empty")).toBeNull();
    expect(slot.getByTestId("wf-model-group-lp.analyze").textContent).toContain("lp.analyze");
    expect(slot.getByTestId("wf-model-row-lp.analyze/assess")).toBeTruthy();
    // assess goes on in gather's session: it names the session, has no picker of its own and shows gather's model.
    expect(slot.getByTestId("wf-model-source-lp.analyze/assess").textContent).toContain("same session as gather");
    expect(slot.queryByTestId("wf-override-row-lp.analyze/assess")).toBeNull();
    const picker = () => slot.getByTestId("wf-override-row-lp.analyze/gather").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    const before = picker();
    expect(slot.getByTestId("wf-model-line-lp.analyze/assess").textContent).toContain(before.getAttribute("data-model")!);
    // The override of gather is written under the called workflow's id, which is the key the executor reads, and assess follows it.
    before.__onChange!({ ...before.__value!, providerId: "codex", model: "gpt-6-luna", reasoningLevel: "low" });
    await waitFor(() => expect(calls.filter((call) => call.method === "workflow_model_override")).toHaveLength(1));
    expect(calls.find((call) => call.method === "workflow_model_override")!.input).toMatchObject({ projectId, scope: "project", workflowId: "lp.analyze", nodeId: "gather", choice: { providerId: "codex", model: "gpt-6-luna", effort: "low" } });
    await waitFor(() => expect(slot.getByTestId("wf-override-row-lp.analyze/gather").getAttribute("data-active")).toBe("project"));
    expect(slot.getByTestId("wf-model-line-lp.analyze/assess").textContent).toContain("gpt-6-luna");
    expect(slot.getByTestId("wf-model-source-lp.analyze/gather").textContent).toContain("overridden for this project");
  });
});
