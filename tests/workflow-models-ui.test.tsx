/** @vitest-environment jsdom */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor, within } from "@testing-library/react";
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
      list: async ({ hostId }: { hostId: string }) => (hostId === "mac" ? [info("claude-code", "Claude Code"), info("codex", "Codex"), info("opencode2", "OpenCode"), info("router9", "router9", false)] : [info("codex", "Codex")]),
      models: async ({ providerId, hostId }: { providerId: string; hostId: string }) => ({
        models: providerId === "claude-code" ? [model("claude-opus-5-5", "Opus 5.5", ["low", "medium", "high", "xhigh"], true), model("claude-sonnet-5-5", "Sonnet 5.5", ["low", "medium", "high"])]
          : providerId === "codex" ? [model("gpt-6-luna", "GPT-6 Luna", ["low", "medium", "high"], true)]
            : providerId === "opencode2" && hostId === "mac" ? [model("router9/ag/gemini-3.8-flash-high", "Gemini 3.8 Flash", ["medium", "high"], true), model("deepseek/v4", "DeepSeek V4", ["high"])] : [],
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
  };
  return { architect, draftId: draft.id, rpc, calls, emit };
}

const patches = (calls: Array<{ method: string; input: unknown }>) => calls.filter((call) => call.method === "workflow_draft_patch").map((call) => call.input as { ops: Array<{ op: string; id: string; set: Record<string, unknown> }> });

async function loadApp() {
  installTestPluginRuntime();
  await loadPluginApp(await import("../app"));
}

async function openDraft(options: { locale?: "en" | "ru"; width?: number } = {}) {
  const w = await world();
  await loadApp();
  const { WorkflowDraftDetail } = await import("../src/rooms/workflow/ui/workflow-draft-detail");
  const locale = options.locale ?? "en";
  const slot = await renderSlot({ component: () => <div style={{ width: options.width ?? 1100 }}><WorkflowDraftDetail draftId={w.draftId} projectId={projectId} locale={locale} onBack={() => undefined} /></div> }, {},
    { context: { projectId, threadId: null }, rpc: w.rpc as never });
  w.emit.current = (payload) => slot.behavior.emitRealtime(`lp:${projectId}`, payload);
  await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
  await slot.findByTestId("wf-model-row-search");
  return { ...w, slot };
}

/** No control of the Models view changes a model: the model is the role's, set in Settings. */
const noPickers = (slot: Awaited<ReturnType<typeof renderSlot>>) => {
  expect(slot.container.querySelector("[data-testid^='wf-model-picker-'], [data-testid^='wf-card-picker-'], [data-testid^='wf-override-'], [data-testid='bb-provider-model-picker']")).toBeNull();
  expect(slot.container.querySelector("[data-testid^='wf-model-reset-'], [data-testid='wf-models-duplicate']")).toBeNull();
};

describe("the Models table of a draft", () => {
  it("lists a row per step with a model: agent, the model of its role as text, where it comes from and the price class; nothing to pick", async () => {
    const { slot } = await openDraft();
    const row = slot.getByTestId("wf-model-row-search");
    expect(within(row).getByTestId("wf-model-agent-search").textContent).toBe("researcher");
    // «researcher» is no role of the table: it is read as the analyst, Claude Opus 5.5 high.
    expect(within(row).getByTestId("wf-model-line-search").textContent).toBe("claude-code · claude-opus-5-5 · high");
    expect(within(row).getByTestId("wf-model-source-search").textContent).toContain("role default");
    expect(within(row).getByTestId("wf-model-cost-search").textContent).toBe("High");
    expect(row.getAttribute("data-inherited")).toBe("1");
    expect(slot.getByTestId("wf-models-hint").textContent).toContain("belongs to the role");
    // The delegated action runs in the errand helper (the errand row: Sonnet 5.5); the question to the owner has no model and is only named.
    expect(slot.getByTestId("wf-model-agent-send").textContent).toBe("telegram.send_rich");
    expect(slot.getByTestId("wf-model-line-send").textContent).toBe("claude-code · claude-sonnet-5-5 · medium");
    expect(slot.queryByTestId("wf-model-row-approve")).toBeNull();
    expect(slot.getByTestId("wf-models-none").textContent).toContain("approve");
    expect(slot.getByTestId("wf-models-summary").textContent).toContain("claude-code 4");
    noPickers(slot);
  });

  it("shows the model on the graph card as a badge only", async () => {
    const { slot } = await openDraft();
    const badge = await slot.findByTestId("wf-model-search");
    expect(badge.textContent).toContain("claude-opus-5-5");
    expect(badge.getAttribute("title")).toContain("from: role default");
    expect(slot.queryByTestId("wf-model-approve")).toBeNull();
    noPickers(slot);
  });

  it("a node that still names a model changes nothing in the table", async () => {
    const { slot, architect, draftId } = await openDraft();
    architect.rpc.workflow_draft_patch({ draftId, ops: [{ op: "update_node", id: "search", set: { provider: "codex", model: "gpt-6-luna", reasoning: "low", service_tier: "fast" } }] } as never);
    // The step keeps the model of its role.
    await waitFor(() => expect(slot.getByTestId("wf-model-line-search").textContent).toBe("claude-code · claude-opus-5-5 · high"));
    const node = (architect.drafts.get(draftId)!.definition.nodes as Array<Record<string, unknown>>).find((item) => item.id === "search")!;
    expect(node.model).toBe("gpt-6-luna");
  });

  it("shows the writer chain of a code task and the role table's row for a stage and the code critic", async () => {
    const { slot, architect, draftId } = await openDraft();
    architect.rpc.workflow_draft_patch({ draftId, ops: [
      { op: "add_node", node: { id: "build", type: "lp-task", owns_paths: ["src/a.ts"], stages: ["writer-agent", "code-critique"] } },
      { op: "add_node", node: { id: "plan-check", type: "agent", role: "plan-critic", uses: "lp.plan-critique" } },
    ] } as never);
    const card = await slot.findByTestId("wf-model-build", {}, { timeout: 10_000 });
    expect(card.textContent).toContain("codex · gpt-6-luna · high");
    expect((await slot.findByTestId("wf-chain-build")).textContent).toBe("→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    const chain = slot.getByTestId("wf-model-chain-build").textContent!;
    expect(chain).toContain("opencode2 · gemini-3.8-flash-high · medium");
    // The code critic is the code-critic row: GPT-6.1 Sol (the pipeline swaps it for Opus when the writer is a GPT model).
    expect(chain).toContain("Code critic: codex · gpt-6.1-sol · high");
    const stage = slot.getByTestId("wf-model-row-plan-check");
    expect(stage.textContent).toContain("Set in Settings: role_model.plan-critic");
    expect(slot.getByTestId("wf-model-line-plan-check").textContent).toBe("codex · gpt-6.1-sol · high · fast");
    expect(slot.getByTestId("wf-model-source-plan-check").textContent).toContain("role default");
    noPickers(slot);
  });

  it("is readable in Russian at 375 px: the rows stack and nothing runs past the edge", async () => {
    setLocaleOverride("ru");
    const { slot } = await openDraft({ locale: "ru", width: 375 });
    const row = slot.getByTestId("wf-model-row-search");
    expect(row.getAttribute("data-wide")).toBe("0");
    expect(slot.getByTestId("wf-models-panel").textContent).toContain("Модели");
    expect(within(row).getByTestId("wf-model-source-search").textContent).toContain("по умолчанию для роли");
    const hint = slot.getByTestId("wf-models-hint").textContent!;
    expect(hint).toContain("принадлежит роли");
    expect(hint).not.toMatch(/воркфлоу|цепочк/i);
  });
});

describe("the node panel of a draft", () => {
  it("names the role's model as text, without a picker; a node of an older file that names a model gets a button that takes it off", async () => {
    const { slot, calls, architect, draftId } = await openDraft();
    fireEvent.click(slot.getByTestId("wf-edit-toggle"));
    fireEvent.click(await slot.findByTestId("wf-node-search"));
    const line = await slot.findByTestId("wf-edit-model-inherited");
    expect(line.textContent).toContain("claude-code · claude-opus-5-5 · high");
    expect(line.textContent).toContain("set once in Settings for every graph");
    expect(slot.queryByTestId("wf-edit-model-picker")).toBeNull();
    expect(slot.queryByTestId("wf-edit-model-default")).toBeNull();
    architect.rpc.workflow_draft_patch({ draftId, ops: [{ op: "update_node", id: "search", set: { model: "gpt-6-luna" } }] } as never);
    fireEvent.click(await slot.findByTestId("wf-edit-model-default"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.ops[0]!.set).toEqual({ provider: null, model: null, reasoning: null, service_tier: null, model_preset: null });
  });
});

describe("the Models table of a library workflow", () => {
  async function openLibrary(id: string) {
    const w = await world();
    await loadApp();
    const { WorkflowDetail } = await import("../src/rooms/workflow/ui/workflow-detail");
    const slot = await renderSlot({ component: () => <div style={{ width: 1100 }}><WorkflowDetail id={id} projectId={projectId} locale="en" onBack={() => undefined} editProjectId={projectId} onEditDraft={() => undefined} /></div> }, {},
      { context: { projectId, threadId: null }, rpc: w.rpc as never });
    await slot.findByTestId("wf-models-panel");
    await waitFor(() => expect(slot.getByTestId("workflow-graph").getAttribute("data-layout")).toBe("ready"));
    return { ...w, slot };
  }

  it("the built-in task pipeline shows its stages and the writer chain on the cards, read-only", async () => {
    const { slot, calls } = await openLibrary("lp-task-pipeline");
    const writer = await slot.findByTestId("wf-model-writer");
    expect(writer.textContent).toBe("codex · gpt-6-luna · high · fast→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    expect(writer.getAttribute("data-mode")).toBe("chain");
    expect(slot.getByTestId("wf-chain-writer").textContent).toBe("→ glm-5.3-flash → gemini-3.8-flash-high → PM model");
    // The stages are the rows of their roles; the writer is the writer settings' (Jev's pick per task).
    expect(slot.getByTestId("wf-model-pm-read").getAttribute("title")).toContain("from: role default");
    expect(slot.getByTestId("wf-model-pm-read").textContent).toContain("claude-haiku-5-5");
    expect(slot.getByTestId("wf-model-plan-critique").textContent).toBe("codex · gpt-6.1-sol · high · fast");
    expect(slot.queryByTestId("wf-model-ownership-base")).toBeNull();
    expect(slot.getByTestId("wf-models-hint").textContent).toContain("belongs to the role");
    expect(slot.getByTestId("wf-model-source-writer").textContent).toContain("writer settings");
    noPickers(slot);
    expect(calls.some((call) => call.method === "workflow_step_executors" && (call.input as { workflowId?: string }).workflowId === "lp-task-pipeline")).toBe(true);
  });

  it("a built-in's step shows its role's model on the card and in the step panel, with nothing to change and no override call", async () => {
    const { slot, calls } = await openLibrary("debug");
    const badge = await slot.findByTestId("wf-model-investigate");
    expect(badge.getAttribute("data-source")).toBe("role-default");
    fireEvent.click(await slot.findByTestId("wf-node-investigate"));
    const block = await slot.findByTestId("wf-panel-model");
    // «investigate» is the debugger: a judge of causes, GPT-6.1 Sol.
    expect(within(block).getByTestId("wf-panel-model-line").textContent).toContain("gpt-6.1-sol");
    expect(within(block).getByTestId("wf-panel-model-source").textContent).toContain("from: role default");
    expect(block.textContent).toContain("belongs to the role");
    noPickers(slot);
    expect(calls.filter((call) => call.method === "workflow_model_override" || call.method === "workflow_draft_create")).toHaveLength(0);
  });

  it("an own workflow's step has no picker either", async () => {
    const { slot } = await openLibrary("mine");
    await slot.findByTestId("wf-model-row-search");
    expect(slot.getByTestId("wf-model-line-search").textContent).toBe("claude-code · claude-opus-5-5 · high");
    noPickers(slot);
  });

  it("a workflow whose agents live in a called workflow lists them under that workflow, keyed <workflow>/<node>", async () => {
    const { slot } = await openLibrary("analyze-code");
    // The Models card is not empty: the steps of lp.analyze are in it.
    await slot.findByTestId("wf-model-row-lp.analyze/gather");
    expect(slot.queryByTestId("wf-models-empty")).toBeNull();
    expect(slot.getByTestId("wf-model-group-lp.analyze").textContent).toContain("lp.analyze");
    expect(slot.getByTestId("wf-model-row-lp.analyze/assess")).toBeTruthy();
    // assess goes on in gather's session: it names the session and shows gather's model.
    expect(slot.getByTestId("wf-model-source-lp.analyze/assess").textContent).toContain("same session as gather");
    expect(slot.getByTestId("wf-model-line-lp.analyze/assess").textContent).toBe(slot.getByTestId("wf-model-line-lp.analyze/gather").textContent);
    noPickers(slot);
  });
});
