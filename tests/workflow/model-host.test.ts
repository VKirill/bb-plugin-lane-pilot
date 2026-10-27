import { describe, expect, it, vi } from "vitest";
import { modelCatalogOf } from "../../src/rooms/core/server/model-catalog-reader";
import { withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";
import { createWorkflowModels } from "../../src/rooms/workflow/server/workflow-models";
import { resolveStepExecutors } from "../../src/rooms/workflow/server/workflow-step-executors";
import { offeredForRole, offeredOnHost, validateChoice, type ModelCatalog } from "@lane-pilot/models";
import { modelsSection } from "@lane-pilot/workflow-engine";
import { roleModelKey } from "@lane-pilot/models";
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
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["book"],
      models: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Sol", efforts: ["high"], defaultEffort: "high", isDefault: true, hostIds: ["book"] }] },
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

  it("the Models view flags a step whose role's model only another machine has, and the architect's list marks it", () => {
    const mine = { [roleModelKey("analyst")]: { model: "claude-haiku-5-5" } };
    const rows = resolveStepExecutors({ nodes: [{ id: "a", type: "agent", role: "analyst" }, { id: "b", type: "agent", role: "planner" }], settings: mine, pm: null, catalog: catalog("mini") });
    expect(rows.map((row) => [row.nodeId, row.issues])).toEqual([["a", ["selection_unavailable"]], ["b", []]]);
    // The card shows what will run: the table's model is not on this machine, so the role's default is.
    expect(rows[0]).toMatchObject({ model: "claude-opus-5-5", source: "role-default" });
    const section = modelsSection(catalog("mini"), mine);
    expect(section.roles.analyst).toMatchObject({ model: "claude-haiku-5-5", source: "table", offered: false });
    expect(section.roles.planner).toMatchObject({ model: "claude-opus-5-5", source: "default", offered: true });
    expect(section.roles.auditor).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", offered: false });
    expect(section.roles["code-critic"]).toMatchObject({ provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoning: "medium", offered: false });
    expect(modelsSection(catalog("book"), mine).roles.analyst).toMatchObject({ offered: true, machines: ["MacBook"] });
  });
});

describe("a table model the machine does not offer falls through (audit r2, B3)", () => {
  const offered = (providerId: string, model: string) => offeredOnHost(catalog("mini"), providerId, model, "mini");
  const pm = { providerId: "claude-code", model: "claude-opus-5-5" };
  const haiku = { [roleModelKey("analyst")]: { model: "claude-haiku-5-5" } };

  it("is passed over for the role's default, then for the PM's model, and says so", () => {
    expect(resolveAgentModel({ role: "analyst", settings: haiku, pm, offered })).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "role-default", issues: ["selection_unavailable"] });
    expect(resolveAgentModel({ role: "analyst", settings: { [roleModelKey("analyst")]: { model: "gpt-6-luna" }, [roleModelKey("workflow-architect")]: { model: "gpt-6-luna" } }, pm: { providerId: "claude-code", model: "claude-opus-5-5" }, offered: (p, m) => m === "claude-opus-5-5" && p === "claude-code" }))
      .toMatchObject({ source: "role-default", issues: ["selection_unavailable"] });
    // A judge whose default (Sol) the machine lacks goes to the PM's model.
    expect(resolveAgentModel({ role: "auditor", settings: {}, pm, offered })).toMatchObject({ source: "pm", model: "claude-opus-5-5", issues: ["selection_unavailable"] });
    // A review whose default (the Gemini) the machine lacks goes to its fallback, Sol, and only if Sol is not here either, to the PM's model. The Gemini is
    // not listed at all on this catalog: for a Gemini that means «not offered» (offeredForRole), where a native model not listed is unknown.
    const here = (providerId: string, model: string) => offeredForRole(catalog("mini"), providerId, model, "mini");
    expect(here("opencode2", "router9/ag/gemini-3.8-flash-high")).toBe(false);
    expect(resolveAgentModel({ role: "code-critic", settings: {}, pm, offered: (p, m) => (m === "gpt-6.1-sol" ? true : here(p, m)) })).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", reasoningEffort: "high", source: "role-default", issues: ["selection_unavailable"] });
    expect(resolveAgentModel({ role: "code-critic", settings: {}, pm, offered: here })).toMatchObject({ source: "pm", model: "claude-opus-5-5", issues: ["selection_unavailable"] });
    expect(resolveAgentModel({ role: "triager", settings: {}, pm, offered: (p, m) => (m === "gpt-6-luna" ? true : here(p, m)) })).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "high", issues: ["selection_unavailable"] });
    // On a machine that has it, the pick stands; with no machine known, nothing is passed over.
    expect(resolveAgentModel({ role: "analyst", settings: haiku, pm, offered: (p, m) => offeredOnHost(catalog("book"), p, m, "book") })).toMatchObject({ source: "table", model: "claude-haiku-5-5", issues: [] });
    expect(resolveAgentModel({ role: "analyst", settings: haiku, pm })).toMatchObject({ source: "table" });
  });

  it("a stage selection of Settings is skipped the same way; the PM's own model is never judged", () => {
    const stage = { "pm_read.provider": "acp-opencode", "pm_read.model": "gemini-3.8" };
    // Haiku, the role's default, is on the MacBook only: the PM's model, which this machine runs, is the last stop.
    expect(resolveAgentModel({ role: "pm-reader", settings: stage, pm, offered })).toMatchObject({ source: "pm", model: "claude-opus-5-5", issues: ["selection_unavailable"] });
    expect(resolveAgentModel({ role: "pm-reader", settings: stage, pm, offered }).issues).not.toContain("model_unavailable_here");
    expect(resolveAgentModel({ role: "auditor", settings: {}, pm: { providerId: "acp-opencode", model: "gemini-3.8" }, offered }))
      .toMatchObject({ source: "pm", model: "gemini-3.8", issues: ["selection_unavailable"] });
  });

  it("a model a run pins is kept and flagged: it is the owner's choice and is refused at start instead of replaced", () => {
    expect(resolveAgentModel({ role: "analyst", pinned: { provider: "acp-opencode", model: "gemini-3.8" }, settings: {}, pm, offered })).toMatchObject({ model: "gemini-3.8", source: "pinned", issues: ["model_unavailable_here"] });
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
          models: async ({ providerId, hostId: host }: { providerId: string; hostId?: string }) => ({ models: providerId === "claude-code"
            ? [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true },
              ...(host === "book" ? [{ id: "claude-haiku-5-5", model: "claude-haiku-5-5", displayName: "Haiku", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", isDefault: false }] : [])]
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

  it("withResolvedModel refuses a model a run pins that the machine lacks, with where it is; the machine that has it starts", async () => {
    const mini = await world("mini");
    const request = (ctx: ServerCore) => ({ rt: { ctx, pmThreadId: "pm", projectId: "proj", runId: "r" }, workflowRunId: "w", stepKey: "s", nodeId: "n", spawnKey: "k", role: "analyst", title: "t", prompt: "", fields: [], provider: "acp-opencode", model: "gemini-3.8" }) as unknown as HelperRequest;
    await expect(withResolvedModel(request(mini.ctx))).rejects.toThrow(/gemini-3\.8 is not offered by the machine.*Mac mini.*it is on MacBook.*role table/);
    const book = await world("book");
    await expect(withResolvedModel(request(book.ctx))).resolves.toMatchObject({ provider: "acp-opencode", model: "gemini-3.8" });
  });

  it("a table model the machine lacks runs on the next level instead of failing at the spawn", async () => {
    const mini = await world("mini");
    mini.ctx.effectiveProjectSettings = (async () => ({ values: { [roleModelKey("analyst")]: { model: "claude-haiku-5-5" } } })) as never;
    const request = { rt: { ctx: mini.ctx, pmThreadId: "pm", projectId: "proj", runId: "r" }, workflowRunId: "w", stepKey: "s", nodeId: "n", spawnKey: "k", role: "analyst", title: "t", prompt: "", fields: [] } as unknown as HelperRequest;
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
