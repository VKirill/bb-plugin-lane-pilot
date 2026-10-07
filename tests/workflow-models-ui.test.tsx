/** @vitest-environment jsdom */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createWorkflowLibrary } from "../src/server/workflow-library";
import { createWorkflowModels } from "../src/server/workflow-models";
import type { ServerCore } from "../src/server/core";
import type { Services } from "../src/server/services";
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
const model = (id: string, name: string, efforts: string[]) => ({ id, model: id, displayName: name, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: efforts[0] });
/** The Mac mini has Claude, Codex and OpenCode (Gemini, DeepSeek gone); OVH has Codex only; router9 is nowhere. */
const bb = {
  sdk: {
    hosts: { list: async () => [{ id: "mac", name: "Mac mini", status: "connected" }, { id: "ovh", name: "OVH", status: "connected" }] },
    providers: {
      list: async ({ hostId }: { hostId: string }) => (hostId === "mac" ? [info("claude-code", "Claude Code"), info("codex", "Codex"), info("acp-opencode", "OpenCode"), info("router9", "router9", false)] : [info("codex", "Codex")]),
      models: async ({ providerId, hostId }: { providerId: string; hostId: string }) => ({
        models: providerId === "claude-code" ? [model("claude-opus-5-5", "Opus 5.5", ["low", "medium", "high", "xhigh"]), model("claude-sonnet-5-5", "Sonnet 5.5", ["low", "medium", "high"])]
          : providerId === "codex" ? [model("gpt-6-luna", "GPT-6 Luna", ["low", "medium", "high"])]
            : providerId === "acp-opencode" && hostId === "mac" ? [model("router9/ag/gemini-3.8-flash-high", "Gemini 3.8 Flash", ["medium", "high"]), model("deepseek/v4", "DeepSeek V4", ["high"])] : [],
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
  const ctx = { bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: settings }),
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
  };
  return { architect, draftId: draft.id, rpc, calls, emit };
}

const patches = (calls: Array<{ method: string; input: unknown }>) => calls.filter((call) => call.method === "workflow_draft_patch").map((call) => call.input as { ops: Array<{ op: string; id: string; set: Record<string, unknown> }> });
const optionOf = async (slot: Awaited<ReturnType<typeof renderSlot>>, trigger: string, option: string) => {
  fireEvent.click(slot.getByTestId(trigger));
  return await slot.findByTestId(option);
};

async function openDraft(options: { locale?: "en" | "ru"; width?: number } = {}) {
  const w = await world();
  await loadPluginApp(() => import("../app"));
  const { WorkflowDraftDetail } = await import("../src/ui/workflow-draft-detail");
  const locale = options.locale ?? "en";
  const slot = await renderSlot({ component: () => <div style={{ width: options.width ?? 1100 }}><WorkflowDraftDetail draftId={w.draftId} projectId={projectId} locale={locale} onBack={() => undefined} /></div> }, {},
    { context: { projectId, threadId: null }, rpc: w.rpc as never });
  w.emit.current = (payload) => slot.behavior.emitRealtime(`lp:${projectId}`, payload);
  await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
  await slot.findByTestId("wf-model-row-search");
  return { ...w, slot };
}

describe("the Models table of a draft", () => {
  it("lists a row per step with a model: agent, provider, model, effort, where it comes from and the price class", async () => {
    const { slot } = await openDraft();
    const row = slot.getByTestId("wf-model-row-search");
    expect(within(row).getByTestId("wf-model-agent-search").textContent).toBe("researcher");
    expect(within(row).getByTestId("wf-model-provider-search").textContent).toContain("Claude Code");
    expect(within(row).getByTestId("wf-model-model-search").textContent).toContain("Opus 5.5");
    expect(within(row).getByTestId("wf-model-effort-search").textContent).toContain("high");
    expect(within(row).getByTestId("wf-model-source-search").textContent).toContain("role default");
    expect(within(row).getByTestId("wf-model-cost-search").textContent).toBe("High");
    expect(row.getAttribute("data-inherited")).toBe("1");
    // The delegated action runs in the errand helper; the question to the owner has no model and is only named.
    expect(slot.getByTestId("wf-model-agent-send").textContent).toBe("telegram.send_rich");
    expect(slot.queryByTestId("wf-model-row-approve")).toBeNull();
    expect(slot.getByTestId("wf-models-none").textContent).toContain("approve");
    expect(slot.getByTestId("wf-models-summary").textContent).toContain("claude-code 4");
  });

  it("puts the same badge on the graph card, dimmed while the value is inherited", async () => {
    const { slot } = await openDraft();
    const badge = await slot.findByTestId("wf-model-search");
    expect(badge.textContent).toBe("claude-code · claude-opus-5-5 · high");
    expect(badge.getAttribute("data-inherited")).toBe("1");
    expect(badge.getAttribute("title")).toContain("from: role default");
    expect(slot.queryByTestId("wf-model-approve")).toBeNull();
  });

  it("choosing another provider writes a draft patch with its first available model, and the badge follows", async () => {
    const { slot, calls } = await openDraft();
    const option = await optionOf(slot, "wf-model-provider-search", "wf-model-provider-option-acp-opencode");
    fireEvent.click(option);
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: "high" } }]);
    await waitFor(() => expect(slot.getByTestId("wf-model-search").textContent).toBe("opencode · gemini-3.8-flash-high · high"));
    expect(slot.getByTestId("wf-model-search").getAttribute("data-inherited")).toBe("0");
    expect(slot.getByTestId("wf-model-source-search").textContent).toContain("this step");
    expect(slot.getByTestId("wf-model-cost-search").textContent).toBe("Low");
  });

  it("changing the model keeps the effort when the model has it, and the reset hands the step back to its default", async () => {
    const { slot, calls, architect, draftId } = await openDraft();
    fireEvent.click(await optionOf(slot, "wf-model-provider-search", "wf-model-provider-option-codex"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    await waitFor(() => expect(slot.getByTestId("wf-model-search").textContent).toBe("codex · gpt-6-luna · high"));
    fireEvent.click(await optionOf(slot, "wf-model-effort-search", "wf-model-effort-option-low"));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.ops[0]!.set).toEqual({ provider: "codex", model: "gpt-6-luna", reasoning: "low" });
    fireEvent.click(await slot.findByTestId("wf-model-reset-search"));
    await waitFor(() => expect(patches(calls)).toHaveLength(3));
    expect(patches(calls)[2]!.ops[0]!.set).toEqual({ provider: null, model: null, reasoning: null });
    await waitFor(() => expect(slot.getByTestId("wf-model-search").textContent).toBe("claude-code · claude-opus-5-5 · high"));
    const node = (architect.drafts.get(draftId)!.definition.nodes as Array<Record<string, unknown>>).find((item) => item.id === "search")!;
    expect(node.provider).toBeUndefined();
    expect(node.model).toBeUndefined();
  });

  it("lists a provider or model no machine offers but does not let it be picked", async () => {
    const { slot, calls } = await openDraft();
    const router9 = await optionOf(slot, "wf-model-provider-search", "wf-model-provider-option-router9");
    expect(router9.getAttribute("aria-disabled")).toBe("true");
    expect(router9.textContent).toContain("not available");
    fireEvent.click(router9);
    fireEvent.keyDown(document.body, { key: "Escape" });
    // OpenCode is on the Mac mini only: its models say so, and a model the machine lost would be disabled the same way.
    fireEvent.click(await optionOf(slot, "wf-model-provider-search", "wf-model-provider-option-acp-opencode"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    const deepseek = await optionOf(slot, "wf-model-model-search", "wf-model-option-deepseek/v4");
    expect(deepseek.textContent).toContain("DeepSeek V4");
    expect(deepseek.textContent).toContain("on Mac mini");
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
    expect(within(stage).queryByTestId("wf-model-provider-plan-check")).toBeNull();
    expect(slot.getByTestId("wf-model-source-plan-check").textContent).toContain("writer settings");
  });

  it("is readable in Russian at 375 px: the rows stack and nothing runs past the edge", async () => {
    setLocaleOverride("ru");
    const { slot } = await openDraft({ locale: "ru", width: 375 });
    const row = slot.getByTestId("wf-model-row-search");
    expect(row.getAttribute("data-wide")).toBe("0");
    expect(slot.getByTestId("wf-models-panel").textContent).toContain("Модели");
    expect(within(row).getByTestId("wf-model-source-search").textContent).toContain("по умолчанию для роли");
    expect(slot.getByTestId("wf-model-search").getAttribute("title")).toContain("откуда: по умолчанию для роли");
  });
});

describe("the model picker of the node panel", () => {
  it("lists the hub's providers and writes provider, model and effort into the step", async () => {
    const { slot, calls } = await openDraft();
    fireEvent.click(slot.getByTestId("wf-edit-toggle"));
    fireEvent.click(await slot.findByTestId("wf-node-search"));
    await slot.findByTestId("wf-edit-model-catalog");
    fireEvent.click(slot.getByTestId("wf-edit-provider"));
    const gone = await slot.findByTestId("wf-edit-provider-option-router9");
    expect(gone.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(await slot.findByTestId("wf-edit-provider-option-acp-opencode"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: null } }]);
    fireEvent.click(slot.getByTestId("wf-edit-provider"));
    fireEvent.click(await slot.findByRole("option", { name: "Default" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.ops[0]!.set).toEqual({ provider: null, model: null, reasoning: null });
  });
});

describe("the Models table of a library workflow", () => {
  async function openLibrary(id: string, scope: "builtin" | "global") {
    const w = await world();
    await loadPluginApp(() => import("../app"));
    const { WorkflowDetail } = await import("../src/ui/workflow-detail");
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
    expect(writer.textContent).toBe("codex · gpt-6-luna · high→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    expect(writer.getAttribute("data-mode")).toBe("chain");
    expect(slot.getByTestId("wf-chain-writer").textContent).toBe("→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    expect(slot.getByTestId("wf-model-pm-read").getAttribute("title")).toContain("from: writer settings (writer.model)");
    expect(slot.getByTestId("wf-model-plan-critique").textContent).toBe("codex · gpt-6-luna · high");
    expect(slot.queryByTestId("wf-model-ownership-base")).toBeNull();
    expect(slot.getByTestId("wf-models-hint").textContent).toContain("built-in");
    expect(slot.getByTestId("wf-models-duplicate")).toBeTruthy();
    expect(slot.container.querySelector("[data-testid^='wf-model-provider-']")).toBeNull();
    expect(slot.getByTestId("wf-model-source-writer").textContent).toContain("writer settings");
    expect(calls.some((call) => call.method === "workflow_step_executors" && (call.input as { workflowId?: string }).workflowId === "lp-task-pipeline")).toBe(true);
  });

  it("choosing a model for an own workflow opens a draft with the change; a model no machine has opens nothing", async () => {
    const { slot, calls, opened } = await openLibrary("mine", "global");
    await slot.findByTestId("wf-model-provider-search");
    fireEvent.click(slot.getByTestId("wf-model-provider-search"));
    const gone = await slot.findByTestId("wf-model-provider-option-router9");
    expect(gone.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(gone);
    expect(calls.filter((call) => call.method === "workflow_draft_create")).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(await slot.findByTestId("wf-model-provider-search"));
    fireEvent.click(await slot.findByTestId("wf-model-provider-option-acp-opencode"));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls.filter((call) => call.method === "workflow_draft_create")).toHaveLength(1);
    expect(patches(calls)[0]!.ops).toEqual([{ op: "update_node", id: "search", set: { provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: "high" } }]);
  });
});
