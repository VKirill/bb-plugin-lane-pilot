import { describe, expect, it, vi } from "vitest";
import { modelCatalogOf } from "../../src/rooms/core/server/model-catalog-reader";
import { withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";
import { createWorkflowModels } from "../../src/rooms/workflow/server/workflow-models";
import { resolveStepExecutors } from "../../src/rooms/workflow/server/workflow-step-executors";
import { offeredOnHost, validateChoice, type ModelCatalog } from "@lane-pilot/models";
import { modelsSection } from "../../src/rooms/workflow/capabilities";
import { presetKey } from "@lane-pilot/models";
import type { ServerCore } from "../../src/rooms/core/server/core";
import { journalDb } from "./engine-helpers";

/** Two machines: the Mac mini (where the project's PM chat lives) has Claude and Codex; the MacBook has Gemini through OpenCode as well. */
const catalog = (runHostId: string | null | undefined = "mini"): ModelCatalog => ({
  runHostId,
  hosts: [{ id: "mini", name: "Mac mini", connected: true }, { id: "book", name: "MacBook", connected: true }, { id: "old", name: "Old laptop", connected: false }],
  providers: [
    { id: "claude-code", displayName: "Claude Code", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini", "book"],
      models: [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus", efforts: ["low", "high"], defaultEffort: "high", isDefault: true, hostIds: ["mini", "book"] },
        { id: "claude-haiku-5-5", model: "claude-haiku-5-5", displayName: "Haiku", efforts: ["low"], defaultEffort: "low", isDefault: false, hostIds: ["book"] }] },
    { id: "acp-opencode", displayName: "OpenCode", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["book"],
      models: [{ id: "gemini-3.8", model: "gemini-3.8", displayName: "Gemini", efforts: ["high"], defaultEffort: "high", isDefault: true, hostIds: ["book"] }] },
  ],
});

describe("a model is judged on the machine the step runs on (audit r2, B2)", () => {
  it("offeredOnHost: true or false when the catalog can say, null when it cannot (an unknown machine, one that did not answer, a model not listed)", () => {
    const c = catalog();
    expect(offeredOnHost(c, "claude-code", "claude-opus-5-5", "mini")).toBe(true);
    expect(offeredOnHost(c, "claude-code", "claude-haiku-5-5", "mini")).toBe(false);
    expect(offeredOnHost(c, "claude-code", "claude-haiku-5-5", "book")).toBe(true);
    expect(offeredOnHost(c, "acp-opencode", "gemini-3.8", "mini")).toBe(false);
    expect(offeredOnHost(c, "claude-code", "claude-haiku-5-5", "old")).toBeNull();
    expect(offeredOnHost(c, "claude-code", "claude-haiku-5-5", "nowhere")).toBeNull();
    expect(offeredOnHost(c, "claude-code", "never-heard-of-it", "mini")).toBeNull();
    expect(offeredOnHost(c, "claude-code", "claude-haiku-5-5", null)).toBeNull();
  });

  it("validateChoice refuses a model only another machine has, naming where it is, and says nothing when no machine is set", () => {
    expect(validateChoice(catalog("mini"), { providerId: "claude-code", model: "claude-haiku-5-5" })).toMatchObject({ ok: false, code: "model_unavailable_here", detail: expect.stringContaining("only on MacBook") });
    expect(validateChoice(catalog("mini"), { providerId: "claude-code", model: "claude-opus-5-5" })).toEqual({ ok: true });
    expect(validateChoice(catalog(null), { providerId: "claude-code", model: "claude-haiku-5-5" })).toEqual({ ok: true });
    const { runHostId: _none, ...unset } = catalog();
    expect(validateChoice(unset, { providerId: "acp-opencode", model: "gemini-3.8" })).toEqual({ ok: true });
    expect(validateChoice(catalog("book"), { providerId: "acp-opencode", model: "gemini-3.8" })).toEqual({ ok: true });
  });

  it("the Models view flags a step that names such a model, and the architect's list marks it", () => {
    const rows = resolveStepExecutors({ nodes: [{ id: "a", type: "agent", role: "analyst", provider: "claude-code", model: "claude-haiku-5-5", reasoning: "low" }, { id: "b", type: "agent", role: "analyst", provider: "claude-code", model: "claude-opus-5-5" }],
      settings: {}, pm: null, catalog: catalog("mini") });
    expect(rows.map((row) => [row.nodeId, row.issues])).toEqual([["a", ["model_unavailable_here"]], ["b", []]]);
    const section = modelsSection(catalog("mini"), {});
    const claude = section.providers!.find((row) => row.provider === "claude-code")!;
    expect(claude.models.find((row) => row.id === "claude-haiku-5-5")).toMatchObject({ notOnThisMachine: true });
    expect(claude.models.find((row) => row.id === "claude-opus-5-5")).not.toHaveProperty("notOnThisMachine");
  });
});

describe("a preset or a Settings selection the machine does not offer falls through (audit r2, B3)", () => {
  const offered = (providerId: string, model: string) => offeredOnHost(catalog("mini"), providerId, model, "mini");
  const pm = { providerId: "claude-code", model: "claude-opus-5-5" };
  const strong = { [presetKey("strong", "provider")]: "acp-opencode", [presetKey("strong", "model")]: "gemini-3.8" };

  it("a preset whose model is not on the machine is passed over for the next level, and says so", () => {
    expect(resolveAgentModel({ role: "analyst", node: { model_preset: "strong" }, settings: strong, pm, offered })).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "pm", issues: ["preset_unavailable"] });
    expect(resolveAgentModel({ role: "analyst", node: { model_preset: "strong" }, settings: { ...strong, "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-opus-5-5" }, pm, offered })).toMatchObject({ source: "agent", issues: ["preset_unavailable"] });
    // On a machine that has it, the preset stands; with no machine known, nothing is passed over.
    expect(resolveAgentModel({ role: "analyst", node: { model_preset: "strong" }, settings: strong, pm, offered: (p, m) => offeredOnHost(catalog("book"), p, m, "book") })).toMatchObject({ source: "preset", model: "gemini-3.8", issues: [] });
    expect(resolveAgentModel({ role: "analyst", node: { model_preset: "strong" }, settings: strong, pm })).toMatchObject({ source: "preset" });
  });

  it("a stage or generic selection of Settings is skipped the same way; the PM's own model is never judged", () => {
    const stage = { "pm_read.provider": "acp-opencode", "pm_read.model": "gemini-3.8", "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-opus-5-5" };
    expect(resolveAgentModel({ role: "analyst", node: {}, settings: stage, pm, offered })).toMatchObject({ source: "agent", model: "claude-opus-5-5", issues: ["selection_unavailable"] });
    expect(resolveAgentModel({ role: "analyst", node: {}, settings: {}, pm: { providerId: "acp-opencode", model: "gemini-3.8" }, offered })).toMatchObject({ source: "pm", model: "gemini-3.8", issues: [] });
  });

  it("a model the step names itself, or an override, is kept and flagged: it is the owner's choice and is refused at start instead of replaced", () => {
    expect(resolveAgentModel({ role: "analyst", node: { provider: "acp-opencode", model: "gemini-3.8" }, settings: {}, pm, offered })).toMatchObject({ model: "gemini-3.8", source: "node", issues: ["model_unavailable_here"] });
    const key = "workflow.model_override.w/n";
    expect(resolveAgentModel({ role: "analyst", node: {}, settings: { [key]: { provider: "acp-opencode", model: "gemini-3.8" } }, pm, offered, at: { workflowId: "w", nodeId: "n" } }))
      .toMatchObject({ source: "override", model: "gemini-3.8", issues: ["model_unavailable_here"] });
  });

  it("the architect's presets list says offered: false for a preset the run machine lacks", () => {
    const section = modelsSection(catalog("mini"), strong);
    expect((section.presets as Record<string, { offered: boolean }>).strong!.offered).toBe(false);
    expect((modelsSection(catalog("book"), strong).presets as Record<string, { offered: boolean }>).strong!.offered).toBe(true);
  });
});

describe("the executor and the catalog RPC use the machine of the PM chat", () => {
  async function world(hostId: string) {
    const fake = {
      sdk: {
        hosts: { list: async () => [{ id: "mini", name: "Mac mini", status: "connected" }, { id: "book", name: "MacBook", status: "connected" }] },
        providers: {
          list: async ({ hostId: host }: { hostId: string }) => [{ id: "claude-code", displayName: "Claude Code", available: true, logoUrl: null, capabilities: { supportsServiceTier: false } },
            ...(host === "book" ? [{ id: "acp-opencode", displayName: "OpenCode", available: true, logoUrl: null, capabilities: { supportsServiceTier: false } }] : [])],
          models: async ({ providerId }: { providerId: string }) => ({ models: providerId === "claude-code"
            ? [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true }]
            : [{ id: "gemini-3.8", model: "gemini-3.8", displayName: "Gemini", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true }] }),
        },
        threads: { get: async () => ({ id: "pm", environmentId: "env" }), defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }) },
        environments: { get: async () => ({ id: "env", hostId, path: "/p" }) },
      },
    };
    const db = journalDb();
    db.exec("CREATE TABLE IF NOT EXISTS lane_pilot_run (id TEXT, kind TEXT, project_id TEXT, closed_at INTEGER, pm_thread_id TEXT, created_at INTEGER, settings_scopes_json TEXT)");
    db.prepare("INSERT INTO lane_pilot_run(id,kind,project_id,closed_at,pm_thread_id,created_at) VALUES ('r','cli','proj',NULL,'pm',1)").run();
    const ctx = { bb: fake, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as unknown as ServerCore;
    await modelCatalogOf(ctx).get();
    return { ctx, db };
  }

  it("withResolvedModel refuses a model named by the step that the machine lacks, with where it is; the machine that has it starts", async () => {
    const mini = await world("mini");
    const request = (ctx: ServerCore) => ({ rt: { ctx, pmThreadId: "pm", projectId: "proj", runId: "r" }, workflowRunId: "w", stepKey: "s", nodeId: "n", spawnKey: "k", role: "analyst", title: "t", prompt: "", fields: [], provider: "acp-opencode", model: "gemini-3.8" }) as unknown as HelperRequest;
    await expect(withResolvedModel(request(mini.ctx))).rejects.toThrow(/gemini-3\.8 is not offered by the machine.*Mac mini.*it is on MacBook/);
    const book = await world("book");
    await expect(withResolvedModel(request(book.ctx))).resolves.toMatchObject({ provider: "acp-opencode", model: "gemini-3.8" });
  });

  it("a preset the machine lacks runs on the next level instead of failing at the spawn", async () => {
    const mini = await world("mini");
    const settings = { [presetKey("strong", "provider")]: "acp-opencode", [presetKey("strong", "model")]: "gemini-3.8" };
    mini.ctx.effectiveProjectSettings = (async () => ({ values: settings })) as never;
    const request = { rt: { ctx: mini.ctx, pmThreadId: "pm", projectId: "proj", runId: "r" }, workflowRunId: "w", stepKey: "s", nodeId: "n", spawnKey: "k", role: "analyst", title: "t", prompt: "", fields: [], preset: "strong" } as unknown as HelperRequest;
    vi.spyOn(mini.db, "prepare");
    await expect(withResolvedModel(request)).resolves.toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
  });

  it("workflow_model_catalog with a project says which machine its helpers run on", async () => {
    const mini = await world("mini");
    const models = createWorkflowModels(mini.ctx, { drafts: { get: () => undefined } as never, source: async () => null });
    expect(await models.modelCatalog({ projectId: "proj" })).toMatchObject({ runHostId: "mini" });
    expect(await models.modelCatalog({})).not.toHaveProperty("runHostId");
  });
});
