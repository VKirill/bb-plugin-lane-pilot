import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, createTask, createAttempt, openDatabase, saveProjectSetting, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createCore } from "../../src/rooms/core/server/core";
import { modelCatalogOf } from "../../src/rooms/core/server/model-catalog-reader";
import type { Services } from "../../src/rooms/core/server/services";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, humanOptions, humanOutput, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { answerWorkflowQuestion } from "../../src/rooms/workflow/server/workflow-answer";
import { reportEndToOwner } from "../../src/rooms/workflow/server/pm-notice";
import type { ChainRuntime } from "../../src/rooms/workflow/server/workflow-runtime";
import { registerPureActions } from "@lane-pilot/workflow-engine";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { registerReducers } from "@lane-pilot/workflow-engine";
import { parseWorkflow } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";

/**
 * The executors of a chain on the host, against a fake BB: a helper thread is a scripted answer, the PM's checkout is a real git
 * repository in a temp folder (so an edit by a helper is really seen), the owner's form is the harness's pending interaction.
 */
const PROJECT = "chain-project", PM = "chain-pm", RUN = "chain-run";
type Row = Record<string, unknown>;

type Script = Record<string, Array<string | ((checkout: string) => string)>>;
const reply = (body: Row, lead = "Done.") => `${lead}\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

/** What a helper thread of a node spent, as BB reports it: one token-usage event of one turn, on this model. */
type Spent = { input: number; output: number; model?: string };
async function setup(script: Script, options: { pmEvents?: () => Row[]; dirty?: boolean; spent?: Record<string, Spent>; failWrites?: boolean; noPm?: boolean; invalidParent?: boolean; offers?: Array<{ providerId: string; model: string; host?: string }> } = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-chain-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const spawned: Array<Row> = [], sent: Array<{ threadId: string; text: string }> = [], writes: Array<{ path: string; content: string }> = [];
  const nodeOf = new Map<string, string>(), counts = new Map<string, number>();
  let next = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        spawn: async (args) => {
          const request = args as unknown as Row;
          spawned.push(request);
          if (options.invalidParent && (request.pluginMetadata as Row)?.parentPmThreadId) throw new Error("HTTP 400: Parent thread is invalid");
          const id = `helper-${next += 1}`;
          nodeOf.set(id, String((request.pluginMetadata as Row).lanePilotWorkflowNode ?? (request.pluginMetadata as Row).role));
          return { id };
        },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        // A follow-up sent to a thread shows up as a new requested turn that starts and completes.
        events: { list: async ({ threadId }) => [...(threadId === PM ? options.pmEvents?.() ?? [] : []), { type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
          ...(options.spent?.[nodeOf.get(threadId) ?? ""] ? [
            { type: "client/thread/start", threadId, seq: 3, createdAt: 1, data: { request: { params: { execution: { model: options.spent[nodeOf.get(threadId)!]!.model ?? "claude-opus-5-5" } } } } },
            { type: "thread/tokenUsage/updated", threadId, seq: 4, createdAt: 2, data: { turnId: "t1", tokenUsage: { last: { inputTokens: options.spent[nodeOf.get(threadId)!]!.input, outputTokens: options.spent[nodeOf.get(threadId)!]!.output, totalTokens: options.spent[nodeOf.get(threadId)!]!.input + options.spent[nodeOf.get(threadId)!]!.output }, total: { inputTokens: options.spent[nodeOf.get(threadId)!]!.input, outputTokens: options.spent[nodeOf.get(threadId)!]!.output, totalTokens: options.spent[nodeOf.get(threadId)!]!.input + options.spent[nodeOf.get(threadId)!]!.output } } } }] : []),
          ...sent.filter((message) => message.threadId === threadId).flatMap((_message, at) => [{ type: "client/turn/requested", threadId, seq: 10 * (at + 1) + 3, createdAt: Date.now() + 60_000 },
            { type: "turn/started", threadId, seq: 10 * (at + 1) + 4 }, { type: "turn/completed", threadId, seq: 10 * (at + 1) + 5, data: { status: "completed" } }])] },
        send: async (args) => { const input = (args as unknown as { threadId: string; input: Array<{ text: string }> }); sent.push({ threadId: input.threadId, text: input.input.map((part) => part.text).join("\n") }); return {} as never; },
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => {
          const node = nodeOf.get(threadId) ?? "";
          const at = counts.get(threadId) ?? 0;
          counts.set(threadId, at + 1);
          const answers = script[node] ?? [];
          const answer = answers[Math.min(at, answers.length - 1)];
          const text = typeof answer === "function" ? answer(checkout) : answer ?? "no script";
          return { output: text };
        },
      },
      // The machine's catalog, when a test says which models it offers (otherwise the catalog is cold and every model counts as offered).
      ...(options.offers ? {
        hosts: { list: async () => [...new Set(options.offers!.map((row) => row.host ?? "local"))].map((id) => ({ id, name: id, status: "connected" })) },
        providers: {
          list: async (args?: { hostId?: string }) => [...new Set(options.offers!.filter((row) => (row.host ?? "local") === args?.hostId).map((row) => row.providerId))].map((id) => ({ id, displayName: id, available: true, capabilities: {}, serviceTiers: [] })),
          models: async (args?: { providerId?: string; hostId?: string }) => ({ models: options.offers!.filter((row) => row.providerId === args?.providerId && (row.host ?? "local") === args?.hostId).map((row) => ({ id: row.model, model: row.model, displayName: row.model, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true })) }),
        },
      } : {}),
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        write: async (args: unknown) => {
          if (options.failWrites) throw new Error("disk full");
          const input = args as { path: string; content: string };
          mkdirSync(dirname(input.path), { recursive: true });
          writeFileSync(input.path, input.content);
          writes.push({ path: input.path, content: input.content });
          return { ok: true } as never;
        },
      },
    },
  });
  const db = openDatabase(bb);
  // A project without Lane Pilot has no PM chat and no run of the plugin: the workflow run stands alone.
  if (!options.noPm) {
    createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
    setRunThread(db, RUN, PM);
  }
  const ctx = createCore(bb, db);
  const dispatched: Row[] = [];
  const services = { dispatchWriter: vi.fn(async (args: Row) => { dispatched.push(args); return { runId: RUN, taskId: (args.task as Row).id, state: "queued" }; }), stability: { loadParked: async () => [] } } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  const rt: ChainRuntime = { ctx, services, pmThreadId: options.noPm ? null : PM, projectId: PROJECT, runId: options.noPm ? null : RUN };
  const start = (workflow: Workflow, inputs: Row = {}) => engine.start({ workflow, inputs, runtime: rt, link: options.noPm ? { projectId: PROJECT } : { projectId: PROJECT, runId: RUN } });
  void options;
  return { bb, harness, db, engine, checkout, spawned, sent, writes, dispatched, services, start, rt, dispose: () => harness.lifecycle.dispose() };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const chain = (extra: Row): Workflow => parseWorkflow({
  schemaVersion: 1, id: "chain-under-test", name: "Chain under test", description: { en: "A chain", ru: "Цепочка" }, inputs: [], outputs: [],
  ...extra,
});

describe("what a step spends counts against the run's budget", () => {
  const agent = (id: string, extra: Row = {}) => ({ id, type: "agent", role: "analyst", prompt: `Work ${id}.`, output: [{ name: "n", type: "number" }], ...extra });
  const twoSteps = (budget: Row) => chain({
    nodes: [agent("first"), agent("second"), { id: "done", type: "action", action: "emit", map: { n: "second.n" } }],
    outputs: [{ name: "n", type: "number", required: false }],
    edges: [{ from: "start", to: "first" }, { from: "first", to: "second" }, { from: "second", to: "done" }],
    budget,
  });
  const answers = { first: [reply({ n: 1, handoff: "a" })], second: [reply({ n: 2, handoff: "b" })] };

  it("an agent step reports the tokens and the price its thread spent, into its receipt and the run's totals", async () => {
    const t = await setup(answers, { spent: { first: { input: 1000, output: 500 }, second: { input: 2000, output: 100, model: "claude-sonnet-5-5" } } });
    dispose = t.dispose;
    const summary = await t.start(twoSteps({})).done;
    expect(summary.status).toBe("succeeded");
    const receipt = (node: string) => JSON.parse(t.engine.snapshot(summary.runId)!.steps.find((step) => step.node_id === node)!.receipt_json!);
    expect(receipt("first").usage).toEqual({ tokens: 1500, costUsd: expect.closeTo(0.014, 6) });
    expect(receipt("second").usage).toEqual({ tokens: 2100, costUsd: expect.closeTo(0.005, 6) });
    expect(t.engine.snapshot(summary.runId)!.run).toMatchObject({ tokens_used: 3600 });
    expect(t.engine.snapshot(summary.runId)!.run.cost_micro_usd).toBeGreaterThan(18_000);
  });

  it("maxTokens blocks the run before the next step, as blocked and not failed", async () => {
    const t = await setup(answers, { spent: { first: { input: 1000, output: 500 }, second: { input: 10, output: 10 } } });
    dispose = t.dispose;
    const summary = await t.start(twoSteps({ max_steps: 10, maxTokens: 1000 })).done;
    expect(summary).toMatchObject({ status: "blocked", reason: "budget_exceeded:tokens" });
    expect(t.spawned).toHaveLength(1);
  });

  it("maxCostUsd (max_usd) blocks the run on the price of what was spent, from the model's rate", async () => {
    const t = await setup(answers, { spent: { first: { input: 1000, output: 500 }, second: { input: 10, output: 10 } } });
    dispose = t.dispose;
    const summary = await t.start(twoSteps({ max_usd: 0.01 })).done;
    expect(summary).toMatchObject({ status: "blocked", reason: "budget_exceeded:cost" });
    expect(t.spawned).toHaveLength(1);
    const cheap = await setup(answers, { spent: { first: { input: 1000, output: 500 }, second: { input: 10, output: 10 } } });
    const ok = await cheap.start(twoSteps({ max_usd: 0.5 })).done;
    await cheap.dispose();
    expect(ok.status).toBe("succeeded");
  });

  it("a model the price table does not know is priced at the dearest known rate, so a budget is never blind", async () => {
    const t = await setup(answers, { spent: { first: { input: 1_000_000, output: 0, model: "mystery-model-9" }, second: { input: 1, output: 1 } } });
    dispose = t.dispose;
    const summary = await t.start(twoSteps({ max_usd: 1 })).done;
    expect(summary).toMatchObject({ status: "blocked", reason: "budget_exceeded:cost" });
  });

  it("a child run's spending is added to the parent step that called it", async () => {
    const t = await setup(answers, { spent: { first: { input: 1000, output: 500 }, second: { input: 10, output: 10 } } });
    dispose = t.dispose;
    const inner = chain({ id: "inner", nodes: [agent("first"), { id: "done", type: "action", action: "emit", map: { n: "first.n" } }], outputs: [{ name: "n", type: "number", required: false }], edges: [{ from: "start", to: "first" }, { from: "first", to: "done" }] });
    const outer = chain({
      id: "outer", nodes: [{ id: "call", type: "subworkflow", workflow: "inner" }, { id: "done", type: "action", action: "emit", map: { n: "call.n" } }],
      outputs: [{ name: "n", type: "number", required: false }], edges: [{ from: "start", to: "call" }, { from: "call", to: "done" }],
    });
    (t.engine as unknown as { options: { resolveWorkflow?: unknown } }).options.resolveWorkflow = (id: string) => (id === "inner" ? inner : null);
    const summary = await t.start(outer).done;
    expect(summary.status).toBe("succeeded");
    const snapshot = t.engine.snapshot(summary.runId)!;
    expect(snapshot.run).toMatchObject({ tokens_used: 1500 });
    expect(JSON.parse(snapshot.steps.find((step) => step.node_id === "call")!.receipt_json!).usage.tokens).toBe(1500);
  });

  it("a thread that reports no usage events (an ACP provider) is `usage: unknown` in the receipt and the journal, not 0, and the parent step of a child run says so too", async () => {
    // `second` has no usage events at all; `first` has them and stays known.
    const t = await setup({ ...answers, lone: [reply({ n: 3, handoff: "c" })] }, { spent: { first: { input: 1000, output: 500 } } });
    dispose = t.dispose;
    const summary = await t.start(twoSteps({})).done;
    expect(summary.status).toBe("succeeded");
    const snapshot = t.engine.snapshot(summary.runId)!;
    const receipt = (node: string) => JSON.parse(snapshot.steps.find((step) => step.node_id === node)!.receipt_json!);
    expect(receipt("first").usage).toEqual({ tokens: 1500, costUsd: expect.closeTo(0.014, 6) });
    expect(receipt("second").usage).toEqual({ tokens: 0, costUsd: 0, unknown: true });
    expect(snapshot.run.tokens_used).toBe(1500);
    expect(t.engine.unknownUsageSteps(summary.runId)).toEqual(["second#1"]);

    const inner = chain({ id: "inner", nodes: [agent("lone"), { id: "done", type: "action", action: "emit", map: { n: "lone.n" } }], outputs: [{ name: "n", type: "number", required: false }], edges: [{ from: "start", to: "lone" }, { from: "lone", to: "done" }] });
    const outer = chain({
      id: "outer", nodes: [{ id: "call", type: "subworkflow", workflow: "inner" }, { id: "done", type: "action", action: "emit", map: { n: "call.n" } }],
      outputs: [{ name: "n", type: "number", required: false }], edges: [{ from: "start", to: "call" }, { from: "call", to: "done" }],
    });
    (t.engine as unknown as { options: { resolveWorkflow?: unknown } }).options.resolveWorkflow = (id: string) => (id === "inner" ? inner : null);
    const nested = await t.start(outer, {}).done;
    expect(nested.status).toBe("succeeded");
    expect(t.engine.unknownUsageSteps(nested.runId)).toEqual(["call#1"]);
  });
});

describe("the agent step", () => {
  const oneAgent = (node: Row = {}) => chain({
    nodes: [
      { id: "look", type: "agent", role: "analyst", prompt: "Count the files in {{$inputs.dir}}.", output: [{ name: "count", type: "number" }, { name: "summary", type: "string" }], ...node },
      { id: "done", type: "action", action: "emit", map: { count: "look.count" } },
    ],
    inputs: [{ name: "dir", type: "string", required: false, default: "src" }],
    outputs: [{ name: "count", type: "number", required: false }],
    edges: [{ from: "start", to: "look" }, { from: "look", to: "done" }],
  });

  it("a step whose provider answers with its plan limit runs once more in a fresh thread on the default model (insights-post critic, 2026-10-09)", async () => {
    let calls = 0;
    const answer = () => ((calls += 1) === 1 ? "Upgrade your plan to continue" : reply({ count: 3, summary: "three", handoff: "counted" }));
    const t = await setup({ look: [answer] });
    dispose = t.dispose;
    // The analyst's row of the role table is a Codex model: its plan limit sends the step back to Claude Code.
    saveProjectSetting(t.db, PROJECT, "role_model.analyst", { model: "gpt-6-luna" });
    const summary = await t.start(oneAgent()).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { count: 3 } });
    expect(t.spawned).toHaveLength(2);
    expect(JSON.stringify(t.spawned[0])).toContain("codex");
    expect(JSON.stringify(t.spawned[1])).toContain("claude-code");
    expect(String((t.spawned[1]!.pluginMetadata as Row).spawnId)).toMatch(/:limit$/);
  });

  it("a Claude helper that hits its plan limit reruns once on the other family, as a Codex one reruns on Claude (no asymmetry)", async () => {
    let calls = 0;
    const answer = () => ((calls += 1) === 1 ? "Upgrade your plan to continue" : reply({ count: 3, summary: "three", handoff: "counted" }));
    const t = await setup({ look: [answer] });
    dispose = t.dispose;
    // The analyst's row of the role table is Claude Opus by default: its limit sends the step to GPT-6.1 Sol.
    const summary = await t.start(oneAgent()).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { count: 3 } });
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(t.spawned[1]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
    expect(String((t.spawned[1]!.pluginMetadata as Row).spawnId)).toMatch(/:limit$/);
  });

  it.each([
    ["the quota notice", "[antigravity/gemini-3.8-flash-high] [429]: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h"],
    ["the unavailable notice", "[antigravity/gemini-3.8-flash-high] Unavailable (reset after 2h 7s)"],
  ])("a review on the Gemini through 9router (opencode2) that answers with %s reruns once on GPT-6.1 Sol, never on the Gemini again", async (_name, notice) => {
    let calls = 0;
    const answer = () => ((calls += 1) === 1 ? notice : reply({ count: 3, summary: "three", handoff: "counted" }));
    const t = await setup({ look: [answer] });
    dispose = t.dispose;
    const summary = await t.start(oneAgent({ role: "plan-critic" })).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { count: 3 } });
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[0]).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high" });
    expect(t.spawned[1]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
    expect(String((t.spawned[1]!.pluginMetadata as Row).spawnId)).toMatch(/:limit$/);
  });

  it.each([
    ["busy, as the answer", "ZCode is busy with another chat (one task at a time); try again in a few minutes."],
    ["text not visible, as the answer", "ZCode (text-not-visible): the answer is not on screen"],
    ["the signed-out notice, as the answer", "Authentication required: sign in inside the ZCode app. ZCode (session_expired): login"],
  ])("a step the owner put on ZCode whose app answers %s runs once more on another model, as for a provider limit", async (_name, notice) => {
    let calls = 0;
    const answer = () => ((calls += 1) === 1 ? notice : reply({ count: 3, summary: "three", handoff: "counted" }));
    const t = await setup({ look: [answer] }, { offers: [{ providerId: "claude-code", model: "claude-opus-5-5" }, { providerId: "zcode", model: "glm-5.3-flash-free" }] });
    dispose = t.dispose;
    await modelCatalogOf(t.rt.ctx).get();
    saveProjectSetting(t.db, PROJECT, "role_model.analyst", { model: "glm-5.3-flash-free" });
    saveProjectSetting(t.db, PROJECT, "zcode.window", "always");
    const summary = await t.start(oneAgent()).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { count: 3 } });
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[0]).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash-free" });
    expect(t.spawned[1]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(String((t.spawned[1]!.pluginMetadata as Row).spawnId)).toMatch(/:limit$/);
  });

  it("a Gemini review whose 9router is not on the machine (a warm catalog without it) spawns on Sol at once, not on the Gemini", async () => {
    const t = await setup({ look: [reply({ count: 1, summary: "one", handoff: "counted" })] }, { offers: [{ providerId: "claude-code", model: "claude-opus-5-5" }, { providerId: "codex", model: "gpt-6.1-sol" }] });
    dispose = t.dispose;
    await modelCatalogOf(t.rt.ctx).get();
    expect((await t.start(oneAgent({ role: "code-critic" })).done).status).toBe("succeeded");
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
  });

  it("a limit notice with the other family not on offer fails the step with the notice, it does not run the same pair twice", async () => {
    const t = await setup({ look: ["Upgrade your plan to continue"] }, { offers: [{ providerId: "claude-code", model: "claude-opus-5-5" }, { providerId: "codex", model: "gpt-6.1-sol", host: "other" }] });
    dispose = t.dispose;
    await modelCatalogOf(t.rt.ctx).get();
    const summary = await t.start(oneAgent()).done;
    expect(summary.status).toBe("failed");
    expect(JSON.stringify(summary)).toMatch(/provider_limit.*no other model family/);
    expect(t.spawned).toHaveLength(1);
  });

  it("the limit rerun asks for a peer that is on offer: Claude to Sol when the machine has it", async () => {
    let calls = 0;
    const answer = () => ((calls += 1) === 1 ? "Upgrade your plan to continue" : reply({ count: 1, summary: "one", handoff: "counted" }));
    const t = await setup({ look: [answer] }, { offers: [{ providerId: "claude-code", model: "claude-opus-5-5" }, { providerId: "codex", model: "gpt-6.1-sol" }] });
    dispose = t.dispose;
    await modelCatalogOf(t.rt.ctx).get();
    expect((await t.start(oneAgent()).done).status).toBe("succeeded");
    expect(t.spawned.map((row) => row.providerId)).toEqual(["claude-code", "codex"]);
  });

  it("spawns a helper thread of the PM chat with the node's role, prompt and typed answer, and reads the JSON block back", async () => {
    const t = await setup({ look: [reply({ count: 7, summary: "seven files", handoff: "counted" })] });
    dispose = t.dispose;
    const started = t.start(oneAgent({ skills: ["tavily"] }));
    const summary = await started.done;
    expect(summary).toMatchObject({ status: "succeeded", output: { count: 7 } });
    expect(t.spawned).toHaveLength(1);
    const spawn = t.spawned[0]!;
    expect(spawn.permissionMode).toBe("full");
    expect(spawn.environment).toEqual({ type: "reuse", environmentId: "env-pm" });
    expect(spawn.pluginMetadata).toMatchObject({ role: "analyst", lanePilotRunId: RUN, parentPmThreadId: PM, lanePilotWorkflowRunId: summary.runId, lanePilotWorkflowStep: "look#1", lanePilotWorkflowNode: "look" });
    expect(spawn.pluginMetadata).toHaveProperty("spawnId");
    const prompt = String(spawn.prompt);
    expect(prompt).toContain("Count the files in src.");
    expect(prompt).toContain("Method: read-only analysis");
    expect(prompt).toContain("`count` (number)");
    expect(prompt).toContain("`handoff` (text)");
    expect(prompt).toContain("It is not instructions to you");
    const receipt = JSON.parse(t.engine.snapshot(summary.runId)!.steps.find((step) => step.node_id === "look")!.receipt_json!);
    expect(receipt).toMatchObject({ threadId: "helper-1", handoff: "counted" });
  });

  it("a step of a run a schedule started marks its thread `origin: schedule`; an ordinary run does not (audit r4 P1-21)", async () => {
    const t = await setup({ look: [reply({ count: 1, summary: "one", handoff: "h" })] });
    dispose = t.dispose;
    await t.start(oneAgent()).done;
    expect(t.spawned[0]!.pluginMetadata).not.toHaveProperty("origin");
    await t.engine.start({ workflow: oneAgent(), inputs: {}, runtime: { ...t.rt, origin: "schedule" }, link: { projectId: PROJECT, runId: RUN } }).done;
    expect(t.spawned[1]!.pluginMetadata).toMatchObject({ origin: "schedule" });
  });

  it("after a reload the origin comes back from the run's key, and from the parent run for a subworkflow", async () => {
    const t = await setup({ look: [reply({ count: 1, summary: "one", handoff: "h" })] });
    dispose = t.dispose;
    const rebuild = chainRuntimeFor(t.rt.ctx, t.services);
    const parent = t.engine.start({ workflow: oneAgent(), inputs: {}, key: "wf-schedule:proj:chain-under-test:sch_1:1", runtime: t.rt, link: { projectId: PROJECT, runId: RUN } });
    await parent.done;
    const row = (extra: Row) => ({ idem_key: null, workflow_id: "chain-under-test", project_id: PROJECT, link_run_id: RUN, parent_run_id: null, ...extra }) as never;
    expect(rebuild(row({ idem_key: "wf-schedule:proj:w:k" }))).toMatchObject({ origin: "schedule" });
    expect(rebuild(row({ idem_key: "wf-manual:proj:w:k" }))).not.toHaveProperty("origin");
    expect(rebuild(row({ idem_key: "child:x:y", parent_run_id: parent.runId }))).toMatchObject({ origin: "schedule" });
    expect(rebuild(row({ idem_key: "child:x:y", parent_run_id: null }))).not.toHaveProperty("origin");
  });

  it("asks once more in the same thread when the final message has no JSON block, then fails with the reason", async () => {
    const t = await setup({ look: ["I counted 7 files, trust me.", reply({ count: 7, summary: "x", handoff: "h" })] });
    dispose = t.dispose;
    const summary = await t.start(oneAgent()).done;
    expect(summary.status).toBe("succeeded");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain("ended without the required JSON block");
    const bad = await setup({ look: ["no json at all"] });
    const failed = await bad.start(oneAgent()).done;
    await bad.dispose();
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toContain("could not be read");
  });

  it("a helper that edits the repository fails the step; its own chat folder and, for specialists, .agents/ are allowed", async () => {
    const t = await setup({
      look: [(checkout) => { writeFileSync(join(checkout, "src.ts"), "oops"); return reply({ count: 1, summary: "s", handoff: "h" }); }],
    });
    dispose = t.dispose;
    const summary = await t.start(oneAgent()).done;
    expect(summary).toMatchObject({ status: "failed" });
    expect(summary.error).toContain("repo_edited");
    expect(summary.error).toContain("src.ts");
    const ok = await setup({ look: [(checkout) => { mkdirSync(join(checkout, ".agents"), { recursive: true }); writeFileSync(join(checkout, ".agents", "brief.md"), "ok"); mkdirSync(join(checkout, ".bb/chats/x"), { recursive: true }); writeFileSync(join(checkout, ".bb/chats/x/note.md"), "ok"); return reply({ count: 1, summary: "s", handoff: "h" }); }] });
    const allowed = await ok.start(oneAgent({ role: "specialist:copy-lead" })).done;
    await ok.dispose();
    expect(allowed.status).toBe("succeeded");
    expect(JSON.stringify(ok.spawned[0]!.pluginMetadata)).toContain("\"role\":\"specialist\"");
    expect(ok.spawned[0]!.pluginMetadata).toMatchObject({ specialist: "copy-lead" });
  });

  it("Lane Pilot's own harness folders are not a helper's edit; its workflows folder still is", async () => {
    const harness = await setup({ look: [(checkout) => { mkdirSync(join(checkout, ".lane-pilot/harness-edit/project__w/1/inv"), { recursive: true }); writeFileSync(join(checkout, ".lane-pilot/harness-edit/project__w/1/inv/evidence.md"), "e"); return reply({ count: 1, summary: "s", handoff: "h" }); }] });
    const ok = await harness.start(oneAgent()).done;
    await harness.dispose();
    expect(ok.status).toBe("succeeded");
    const graph = await setup({ look: [(checkout) => { mkdirSync(join(checkout, ".lane-pilot/workflows"), { recursive: true }); writeFileSync(join(checkout, ".lane-pilot/workflows/x.json"), "{}"); return reply({ count: 1, summary: "s", handoff: "h" }); }] });
    const refused = await graph.start(oneAgent()).done;
    await graph.dispose();
    expect(refused.error).toContain(".lane-pilot/workflows/x.json");
  });

  // magicseo replay 2026-10-31: the PM put recon samples into .agents/recon/ while the planner ran, and the planner failed repo_edited (18 minutes).
  it("a file the PM's chat named while the helper ran is the PM's edit, not the helper's; one named before, or not at all, still fails the step", async () => {
    const sample = ".agents/recon/magicseo/samples/keywords.json";
    const write = (checkout: string) => { mkdirSync(join(checkout, ".agents/recon/magicseo/samples"), { recursive: true }); writeFileSync(join(checkout, sample), "{}"); return reply({ count: 1, summary: "s", handoff: "h" }); };
    const named = (createdAt: () => number) => () => [{ type: "item/completed", threadId: PM, seq: 90, createdAt: createdAt(), data: { item: { type: "commandExecution", command: "cp /tmp/samples/*.json .agents/recon/magicseo/samples/" } } }];
    const pm = await setup({ look: [write] }, { pmEvents: named(() => Date.now()) });
    const own = await pm.start(oneAgent()).done;
    await pm.dispose();
    expect(own.status).toBe("succeeded");
    const earlier = await setup({ look: [write] }, { pmEvents: named(() => 1) });
    const before = await earlier.start(oneAgent()).done;
    await earlier.dispose();
    expect(before.error).toContain("repo_edited");
    const nobody = await setup({ look: [write] });
    const helper = await nobody.start(oneAgent()).done;
    await nobody.dispose();
    expect(helper.error).toContain(sample);
  });

  // Live ph_26f65b142d: the stages failed with repo_edited on their own files (CONTEXT.md, plan-items.json, the drawing's fonts).
  // A judge must not edit what it judges (Fable's recheck E7): only the stage's author writes, and each author only its own folders.
  it("the author of a phase stage may write its own folders, a judge nothing, and nobody anything else", async () => {
    const write = (...files: string[]) => (checkout: string) => {
      for (const file of files) { mkdirSync(dirname(join(checkout, file)), { recursive: true }); writeFileSync(join(checkout, file), "x"); }
      return reply({ count: 1, summary: "s", handoff: "h" });
    };
    const stage = async (files: string[], role = "analyst", key = "phase:ph_abc123:analyze:1:1") => {
      const t = await setup({ look: [write(...files)] });
      const summary = await t.engine.start({ workflow: oneAgent({ role }), inputs: {}, key, runtime: t.rt, link: { projectId: PROJECT, runId: RUN } }).done;
      await t.dispose();
      return summary;
    };
    const context = ".agents/phases/ph_abc123/CONTEXT.md", plans = ".agents/plans/ui3/plan-items.json";
    expect((await stage([context])).status).toBe("succeeded");
    expect((await stage([context, plans], "planner")).status).toBe("succeeded");
    // The analyst has no business in the plans folder; the critics of the plan and of the drawing edit neither the plans nor the drawing they judge.
    const analyst = await stage([context, plans]);
    expect(analyst.error).toContain("repo_edited");
    expect(analyst.error).toContain(plans);
    for (const role of ["plan-critic", "code-critic", "auditor"]) {
      const judge = await stage([".agents/phases/ph_abc123/design/src/fonts/a.ttf", plans], role);
      expect(judge.error, role).toContain("repo_edited");
      expect(judge.error, role).toContain("a.ttf");
    }
    const source = await stage([context, "src/app.ts"], "planner");
    expect(source.status).toBe("failed");
    expect(source.error).toContain("repo_edited");
    expect(source.error).toContain("src/app.ts");
    expect(source.error).not.toContain("CONTEXT.md");
    const other = await stage([".agents/phases/ph_other/CONTEXT.md"]);
    expect(other.error).toContain("repo_edited");
    // A run that is not a phase stage keeps the old rule, plans folder included.
    expect((await stage([plans], "planner", "wf-manual:proj:w:k")).error).toContain("repo_edited");
  });

  it("a step in the same session sends into the earlier helper's thread instead of spawning a new one", async () => {
    const t = await setup({ plan: [reply({ plan: "v1", handoff: "first" }), reply({ plan: "v2", handoff: "revised" })] });
    dispose = t.dispose;
    const workflow = chain({
      nodes: [
        { id: "plan", type: "agent", role: "planner", prompt: "Plan it.", output: [{ name: "plan", type: "string" }], maxVisits: 2 },
        { id: "review", type: "action", action: "review", output: [{ name: "ok", type: "boolean" }] },
        { id: "done", type: "action", action: "emit", map: { plan: "plan.plan" } },
      ],
      outputs: [{ name: "plan", type: "string", required: false }],
      edges: [{ from: "start", to: "plan" }, { from: "plan", to: "review" }, { from: "review", to: "plan", pass: "same-session", when: "!review.ok && visits('plan') < 2" }, { from: "review", to: "done" }],
    });
    let reviews = 0;
    t.engine.register("review", { reentrant: true, run: async () => ({ output: { ok: (reviews += 1) > 1 } }) });
    const summary = await t.start(workflow).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { plan: "v2" } });
    expect(t.spawned).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ threadId: "helper-1" });
    expect(t.sent[0]!.text).toContain("Continue the workflow step \"plan\"");
  });

  it("a dead parent chat does not kill the spawn: the helper goes hidden instead (lp.analyze's 400)", async () => {
    const t = await setup({ plan: [reply({ plan: "v1", handoff: "done" })] }, { invalidParent: true });
    dispose = t.dispose;
    const workflow = chain({
      inputs: [], outputs: [{ name: "plan", type: "string", required: false }],
      nodes: [
        { id: "plan", type: "agent", role: "planner", prompt: "Plan.", output: [{ name: "plan", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { plan: "plan.plan" } },
      ],
      edges: [{ from: "start", to: "plan" }, { from: "plan", to: "done" }],
    });
    const summary = await t.start(workflow).done;
    expect(summary).toMatchObject({ status: "succeeded" });
    expect(t.spawned).toHaveLength(2);
    expect((t.spawned[0]!.pluginMetadata as Row).parentPmThreadId).toBe("chain-pm");
    expect((t.spawned[1]!.pluginMetadata as Row).parentPmThreadId).toBeUndefined();
  });

  it("a same-session step re-run after a reload does not send its task into the thread a second time", async () => {
    const t = await setup({ plan: [reply({ plan: "v2", handoff: "revised" })] });
    dispose = t.dispose;
    const request = { rt: t.rt, workflowRunId: "wfrun_x", stepKey: "plan#2", nodeId: "plan", spawnKey: "key-1", role: "planner", title: "plan", prompt: "Revise the plan.", fields: [{ name: "plan", type: "string" }] as never, intoThread: "helper-1" };
    const agents = createWorkflowAgents();
    await agents.run(request).catch(() => undefined); // the thread has no scripted node here: the answer may not parse, the send is what counts
    await agents.run(request).catch(() => undefined); // the same step key again: the reload's re-run
    expect(t.sent.filter((message) => message.text.includes("Revise the plan."))).toHaveLength(1);
    await agents.run({ ...request, stepKey: "plan#3", spawnKey: "key-2" }).catch(() => undefined); // another step sends its own task
    expect(t.sent.filter((message) => message.text.includes("Revise the plan."))).toHaveLength(2);
  });

  it("votes: the node runs three times in three helper threads and the majority decides", async () => {
    const answers = [true, true, false].map((confirmed) => reply({ confirmed, handoff: "voted" }));
    const t = await setup({ "check:child": answers });
    dispose = t.dispose;
    const workflow = chain({
      inputs: [{ name: "items", type: "array", required: false, default: ["a"] }],
      outputs: [{ name: "ids", type: "array", required: false }],
      nodes: [
        { id: "check", type: "parallel", for_each: "$inputs.items", child: { type: "agent", role: "code-critic", prompt: "Confirm {{item}}.", votes: 3, out: { confirmed: "bool" } }, join: { policy: "all", out: { ids: "string[]" }, uses: "reduce.test.ids" } },
        { id: "done", type: "action", action: "emit", map: { ids: "check.ids" } },
      ],
      edges: [{ from: "start", to: "check" }, { from: "check", to: "done" }],
    });
    t.engine.register("reduce.test.ids", { reentrant: true, run: async (c) => ({ output: { ids: (c.input.with.results as Array<{ confirmed: boolean }>).map((row) => String(row.confirmed)) } }) });
    const summary = await t.start(workflow).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { ids: ["true"] } });
    expect(t.spawned).toHaveLength(3);
    expect(new Set(t.spawned.map((spawn) => (spawn.pluginMetadata as Row).spawnId)).size).toBe(3);
  });
});

describe("the owner's question", () => {
  const ask = chain({
    nodes: [
      { id: "ask", type: "human", role: "owner", question: "Ship it? {{$inputs.what}}", output: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["go", "fix", "abort", "timeout"] }], timeoutSec: 600 },
      { id: "done", type: "action", action: "emit", map: { kind: "ask.answer_kind", words: "ask.answer" } },
    ],
    inputs: [{ name: "what", type: "string", required: false, default: "the release" }],
    outputs: [{ name: "kind", type: "string", required: false }, { name: "words", type: "string", required: false }],
    edges: [{ from: "start", to: "ask" }, { from: "ask", to: "done" }],
  });
  const waitFor = async (read: () => unknown) => { for (let tries = 0; tries < 200 && !read(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

  it("opens a BB form in the PM chat with the question and the answer kinds as options; the choice settles the step", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const started = t.start(ask);
    await waitFor(() => t.harness.pendingInteractions.length);
    const form = t.harness.pendingInteractions[0]!;
    expect(form).toMatchObject({ threadId: PM, rendererId: "lane-pilot-ask", title: "Ship it? the release" });
    expect(form.payload).toMatchObject({ options: [{ id: "1", label: "go" }, { id: "2", label: "fix" }, { id: "3", label: "abort" }], allowText: true });
    t.harness.behavior.submitInteraction(form.id, { choice: "2", text: "tests first" });
    await started.done;
    await waitFor(() => t.engine.get(started.runId)?.status === "succeeded");
    const summary = t.engine.get(started.runId)!;
    expect(summary).toMatchObject({ status: "succeeded", output: { kind: "fix", words: "tests first" } });
  });

  it("words alone are an answer too; a timeout kind answers by the clock; humanOutput fills the other fields with empty values", () => {
    const node = ask.nodes[0] as never;
    expect(humanOptions(node)).toEqual(["go", "fix", "abort"]);
    expect(humanOutput(node, { choiceIndex: null, text: "Fix." })).toEqual({ answer: "Fix.", answer_kind: "fix" });
    expect(humanOutput(node, { choiceIndex: null, text: "ok, go ahead" })).toBeNull(); // words around an option name are not a choice
    const rich = { out: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["answered", "abort", "timeout"] }, { name: "resolutions", type: "array" }, { name: "n", type: "number" }], options: [] } as never;
    expect(humanOutput(rich, { choiceIndex: null, text: "use postgres" })).toEqual({ answer: "use postgres", answer_kind: "answered", resolutions: [{ answer: "use postgres" }], n: 0 });
    expect(humanOutput(rich, { choiceIndex: 2, text: "" })).toMatchObject({ answer_kind: "abort", resolutions: [] });
  });

  it("the form shows the question a cheap helper wrote from the step's instruction, in the owner's language (live 2026-10-25)", async () => {
    const t = await setup({ ask: [reply({ question: "Выпускаем релиз? go — выпустить, fix — сначала поправить, abort — отменить." })] });
    dispose = t.dispose;
    t.start(ask);
    await waitFor(() => t.harness.pendingInteractions.length);
    expect(JSON.stringify(t.harness.pendingInteractions[0]!.payload)).toContain("Выпускаем релиз?");
    expect(JSON.stringify(t.harness.pendingInteractions[0]!.payload)).not.toContain("Ship it?");
  });

  it("a typed answer that names no option does not settle the step: the owner is asked again with the options", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const started = t.start(ask);
    await waitFor(() => t.harness.pendingInteractions.length);
    t.harness.behavior.submitInteraction(t.harness.pendingInteractions[0]!.id, { text: "no, wait, not yet" });
    // The notice is in the owner's language (Russian by default) and goes in front of the question once.
    await waitFor(() => t.harness.pendingInteractions.some((item) => JSON.stringify(item.payload).includes("не выбрал вариант")));
    expect(t.engine.get(started.runId)?.status).toBe("waiting");
    const again = t.harness.pendingInteractions.at(-1)!;
    expect(JSON.stringify(again.payload).match(/не выбрал вариант/g)).toHaveLength(1);
    t.harness.behavior.submitInteraction(again.id, { choice: "3", text: "" });
    await waitFor(() => t.engine.get(started.runId)?.status === "succeeded");
    expect(t.engine.get(started.runId)).toMatchObject({ output: { kind: "abort" } });
  });

  it("an unanswered question past its deadline is answered `timeout` when the node allows it", async () => {
    vi.useFakeTimers();
    const t = await setup({});
    dispose = t.dispose;
    const started = t.start(ask);
    await vi.advanceTimersByTimeAsync(50);
    expect(t.engine.get(started.runId)?.status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(601_000);
    await t.engine.poll();
    await vi.advanceTimersByTimeAsync(50);
    expect(t.engine.get(started.runId)).toMatchObject({ status: "succeeded", output: { kind: "timeout" } });
    vi.useRealTimers();
  });
});

describe("files, diffs and the plugin's own state", () => {
  it("fs.write writes a report into the PM's checkout with the run's variables in the path and gives the path as the declared field", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const workflow = chain({
      inputs: [{ name: "question", type: "string", required: false, default: "How do tides work?" }],
      outputs: [{ name: "path", type: "string", required: false }],
      nodes: [
        { id: "put", type: "action", action: "fs.write", path: "reports/{{date}}-{{slug}}.md", template: "the report", out: { report_path: "string" } },
        { id: "done", type: "action", action: "emit", map: { path: "put.report_path" } },
      ],
      edges: [{ from: "start", to: "put" }, { from: "put", to: "done" }],
    });
    const summary = await t.start(workflow).done;
    expect(summary.status).toBe("succeeded");
    expect(String(summary.output!.path)).toMatch(/^reports\/\d{4}-\d\d-\d\d-how-do-tides-work\.md$/);
    expect(t.writes).toHaveLength(1);
    expect(existsSync(join(t.checkout, String(summary.output!.path)))).toBe(true);
    expect(readFileSync(join(t.checkout, String(summary.output!.path)), "utf8")).toContain("# Chain under test");
  });

  it("fs.write refuses a path that leaves the checkout, and writes named files of a folder from templates", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const bad = await t.start(chain({ nodes: [{ id: "put", type: "action", action: "fs.write", path: "../escape.md", out: { report_path: "string" } }, { id: "done", type: "action", action: "emit", map: {} }], edges: [{ from: "start", to: "put" }, { from: "put", to: "done" }] })).done;
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("not inside the checkout");
    const folder = chain({
      outputs: [{ name: "folder", type: "string", required: false }],
      inputs: [{ name: "n", type: "number", required: false, default: 2 }],
      nodes: [{ id: "put", type: "action", action: "fs.write", path: "archive/{{date}}/", contents: { "items.json": "{{$inputs.n}}", "summary.md": "hello" }, out: { archive_path: "string" } }, { id: "done", type: "action", action: "emit", map: { folder: "put.archive_path" } }],
      edges: [{ from: "start", to: "put" }, { from: "put", to: "done" }],
    });
    const summary = await t.start(folder).done;
    expect(summary.status).toBe("succeeded");
    expect(t.writes.map((write) => write.path.replace(t.checkout, "").replace(/\d{4}-\d\d-\d\d/, "D"))).toEqual(["/archive/D/items.json", "/archive/D/summary.md"]);
  });

  it("git.diff_files lists the changed files of a range minus lock and vendor files, and sizes the review", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: t.checkout });
    git("add", "README.md"); git("commit", "-q", "-m", "one");
    mkdirSync(join(t.checkout, "src")); writeFileSync(join(t.checkout, "src/a.ts"), "1"); writeFileSync(join(t.checkout, "package-lock.json"), "{}");
    git("add", "."); git("commit", "-q", "-m", "two");
    const workflow = chain({
      inputs: [{ name: "range", type: "string", required: false, default: "HEAD~1..HEAD" }],
      outputs: [{ name: "files", type: "array", required: false }, { name: "level", type: "string", required: false }],
      nodes: [{ id: "scope", type: "action", action: "git.diff_files", out: { files: "string[]", count: "int", level: "quick|standard|deep" } }, { id: "done", type: "action", action: "emit", map: { files: "scope.files", level: "scope.level" } }],
      edges: [{ from: "start", to: "scope" }, { from: "scope", to: "done" }],
    });
    const summary = await t.start(workflow).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { files: ["src/a.ts"], level: "quick" } });
  });

  it("lp.lint_contract refuses tasks that are not task-v2 and tasks of one wave that own the same path", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const base = { schema_version: 2, risk: "low", lane: "writer", read_first: ["README.md"], interfaces: ["x"], invariants: ["y"], out_of_scope: ["z"], expected_outputs: ["a.txt"], never_touch: [".git/**"], depends_on: [], objective: "o", acceptance: ["a"], verify: "tests", verification: [{ command: "true", cwd: t.checkout, timeout_sec: 30 }] };
    const tasks = [{ ...base, id: "t1", title: "one", owns_paths: ["src/a.ts"] }, { ...base, id: "t2", title: "two", owns_paths: ["src"] }, { id: "broken" }];
    const workflow = chain({
      outputs: [{ name: "errors", type: "array", required: false }],
      nodes: [{ id: "plan", type: "action", action: "make_plan", output: [{ name: "tasks", type: "array" }, { name: "waves", type: "array" }] }, { id: "lint", type: "action", action: "lp.lint_contract", reads: ["plan.tasks"], out: { ok: "bool", errors: "string[]" } }, { id: "done", type: "action", action: "emit", map: { errors: "lint.errors" } }],
      edges: [{ from: "start", to: "plan" }, { from: "plan", to: "lint" }, { from: "lint", to: "done" }],
    });
    t.engine.register("make_plan", { reentrant: true, run: async () => ({ output: { tasks, waves: [["t1", "t2"]] } }) });
    const summary = await t.start(workflow).done;
    const errors = (summary.output!.errors as string[]).join(" | ");
    expect(errors).toContain("task #3 (broken)");
    expect(errors).not.toMatch(/display_title|kind_missing|area_missing/);
    expect(errors).toContain("t1 and t2 run in the same wave but both own src");
  });

  it("lp.lint_contract takes an empty plan only when the planner says the goal is already met", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const lintOf = async (alreadyMet: boolean) => {
      const workflow = chain({
        outputs: [{ name: "ok", type: "boolean", required: false }],
        nodes: [{ id: "plan", type: "action", action: "make_plan", output: [{ name: "tasks", type: "array" }, { name: "waves", type: "array" }, { name: "already_met", type: "boolean" }] }, { id: "lint", type: "action", action: "lp.lint_contract", reads: ["plan.tasks"], out: { ok: "bool", errors: "string[]" } }, { id: "done", type: "action", action: "emit", map: { ok: "lint.ok" } }],
        edges: [{ from: "start", to: "plan" }, { from: "plan", to: "lint" }, { from: "lint", to: "done" }],
      });
      t.engine.register("make_plan", { reentrant: true, run: async () => ({ output: { tasks: [], waves: [], already_met: alreadyMet } }) });
      return (await t.start(workflow).done).output!.ok;
    };
    expect(await lintOf(true)).toBe(true);
    expect(await lintOf(false)).toBe(false);
  });
});

describe("a code task of a chain", () => {
  const taskChain = (contract: unknown) => chain({
    outputs: [{ name: "state", type: "string", required: false }, { name: "commit", type: "string", required: false }],
    nodes: [
      { id: "build", type: "lp-task", contract, quality_mode: "quick", output: [{ name: "state", type: "enum", values: ["accepted", "failed", "blocked", "needs_human", "cancelled"] }, { name: "attempts", type: "number" }, { name: "merge_commit", type: "string" }, { name: "files", type: "array" }, { name: "verdict", type: "object" }] },
      { id: "done", type: "action", action: "emit", map: { state: "build.state", commit: "build.merge_commit" } },
    ],
    edges: [{ from: "start", to: "build" }, { from: "build", to: "done" }],
  });
  const task = (checkout: string) => ({ schema_version: 2, id: "c1", title: "Write a note", risk: "low", lane: "writer", read_first: ["README.md"], interfaces: ["note.txt exists"], invariants: ["only note.txt"], out_of_scope: ["the rest"], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [".git/**"], depends_on: [], objective: "Write note.txt", acceptance: ["note.txt exists"], verify: "tests", verification: [{ command: "test -f note.txt", cwd: checkout, timeout_sec: 30 }] });

  it("dispatches the task through the writer pipeline with the run's workspace and waits for the attempt; an accepted attempt gives the merge commit by its trailer", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: t.checkout, encoding: "utf8" });
    git("add", "README.md"); git("commit", "-q", "-m", "base");
    const started = t.start(taskChain(task(t.checkout)));
    const first = await started.done;
    expect(first.status).toBe("waiting");
    expect(t.dispatched).toHaveLength(1);
    const dispatched = t.dispatched[0]!.task as Row;
    expect(dispatched).toMatchObject({ project_cwd: t.checkout, title: "Write a note", display_title: "Write a note", kind: "feature", area: "workflow:build" });
    expect(String(dispatched.id)).toMatch(/^w[0-9a-f]{8}-c1$/);
    // The attempt is accepted and its merge commit carries the attempt trailer.
    createTask(t.db, { id: String(dispatched.id), runId: RUN, kind: "bb", contract: dispatched });
    const attemptId = "attempt-1";
    createAttempt(t.db, { id: attemptId, runId: RUN, taskId: String(dispatched.id) });
    writeFileSync(join(t.checkout, "note.txt"), "x");
    git("add", "note.txt"); git("commit", "-q", "-m", `${String(dispatched.id)}: Write a note\n\nLane-Pilot-Attempt: ${attemptId}`);
    transitionAttempt(t.db, attemptId, "accepted");
    await t.engine.poll();
    const done = t.engine.get(started.runId)!;
    expect(done).toMatchObject({ status: "succeeded", output: { state: "accepted" } });
    expect(String(done.output!.commit)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a contract that is not task-v2 is a failed task, not a crash; a blocked attempt maps to blocked or needs_human", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const failed = await t.start(taskChain({ id: "nope" })).done;
    expect(failed).toMatchObject({ status: "succeeded", output: { state: "failed" } });
    expect(t.dispatched).toHaveLength(0);
  });

  it("a chain run that outlives a reload gets its runtime back from its row; the per-task pipeline's runs do not", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const rebuild = chainRuntimeFor(t.rt.ctx, t.services);
    const row = { workflow_id: "x", idem_key: null, project_id: PROJECT, link_run_id: RUN } as never;
    expect(rebuild(row)).toMatchObject({ pmThreadId: PM, projectId: PROJECT, runId: RUN });
    expect(rebuild({ workflow_id: "lp-task-pipeline", idem_key: "lp-task:a", project_id: PROJECT, link_run_id: RUN } as never)).toBeUndefined();
    expect(rebuild({ workflow_id: "x", idem_key: null, project_id: null, link_run_id: null } as never)).toBeUndefined();
  });
});

describe("the step contract of an agent step (W0)", () => {
  const audit = (node: Row = {}) => chain({
    nodes: [
      { id: "audit", type: "agent", role: "analyst", prompt: "Audit {{$inputs.dir}}.", output: [{ name: "findings", type: "array", ref: "Finding" }, { name: "count", type: "number" }],
        produces: [{ kind: "findings", version: 1 }], gates: ["audit.count == audit.findings.length"], ...node },
      { id: "done", type: "action", action: "emit", map: { count: "audit.count" } },
    ],
    inputs: [{ name: "dir", type: "string", required: false, default: "src" }],
    outputs: [{ name: "count", type: "number", required: false }],
    edges: [{ from: "start", to: "audit" }, { from: "audit", to: "done" }],
  });
  const good = reply({ findings: [{ severity: "high", file: "src/a.ts", title: "unchecked limit", evidence: "n > 0" }], count: 1, handoff: "h" });
  const noSeverity = reply({ findings: [{ file: "src/a.ts", title: "unchecked limit" }], count: 1, handoff: "h" });

  it("an answer that is the declared artifact passes with no repair turn", async () => {
    const t = await setup({ audit: [good] });
    dispose = t.dispose;
    expect((await t.start(audit()).done).status).toBe("succeeded");
    expect(t.sent).toHaveLength(0);
  });

  it("an answer with the wrong shape gets one repair turn that names the problem and shows the shape; a right second answer is accepted", async () => {
    const t = await setup({ audit: [noSeverity, good] });
    dispose = t.dispose;
    const summary = await t.start(audit()).done;
    expect(summary.status).toBe("succeeded");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain("does not meet this step's contract");
    expect(t.sent[0]!.text).toContain("findings.0.severity");
    expect(t.sent[0]!.text).toContain("Shape of findings/1");
    expect(t.sent[0]!.text).toContain("do not redo the work");
    // The thread is the same one: nothing new was spawned for the repair.
    expect(t.spawned).toHaveLength(1);
  });

  it("a gate that is not met is repaired the same way", async () => {
    const t = await setup({ audit: [reply({ findings: [], count: 3, handoff: "h" }), good] });
    dispose = t.dispose;
    expect((await t.start(audit()).done).status).toBe("succeeded");
    expect(t.sent[0]!.text).toContain("gate not met: audit.count == audit.findings.length");
  });

  it("an answer that is still wrong after the repair turn fails the step: it is not done, and the reason is the contract", async () => {
    const t = await setup({ audit: [noSeverity] });
    dispose = t.dispose;
    const summary = await t.start(audit()).done;
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("artifact_invalid");
    expect(summary.error).toContain("findings.0.severity");
    expect(t.sent).toHaveLength(1);
  });

  it("a step without a contract is unchanged: the same answer passes and nothing is repaired", async () => {
    const t = await setup({ audit: [noSeverity] });
    dispose = t.dispose;
    expect((await t.start(audit({ produces: undefined, gates: undefined })).done).status).toBe("succeeded");
    expect(t.sent).toHaveLength(0);
  });
});

describe("handoff by reference and the start packet (W0)", () => {
  const big = Array.from({ length: 40 }, (_, at) => ({ id: `T${at + 1}`, title: `Task number ${at + 1} of the plan`, objective: "x".repeat(120) }));
  const bigText = JSON.stringify(big, null, 1);
  const reader = (node: Row = {}, inputs: Row = {}) => chain({
    nodes: [
      { id: "read", type: "agent", role: "analyst", prompt: "Read the plan.", output: [{ name: "count", type: "number" }], produces: [{ kind: "report", version: 1 }], ...node },
      { id: "done", type: "action", action: "emit", map: { count: "read.count" } },
    ],
    inputs: [{ name: "goal", type: "string" }, { name: "tasks", type: "array" }, { name: "note", type: "string", required: false }],
    outputs: [{ name: "count", type: "number", required: false }],
    edges: [{ from: "start", to: "read" }, { from: "read", to: "done" }],
    ...inputs,
  });
  const run = { goal: "Rate-limit the export endpoint", tasks: big, note: "short note" };
  const packetOf = (prompt: string) => /<step-packet>[\s\S]*<\/step-packet>/.exec(prompt)![0];

  it("a big input is written to a file of the chat's folder and stands in the prompt as its path and a summary; a small one stays inline", async () => {
    const t = await setup({ read: [reply({ count: 40, handoff: "h" })] });
    dispose = t.dispose;
    const summary = await t.start(reader(), run).done;
    expect(summary.status).toBe("succeeded");
    const prompt = String(t.spawned[0]!.prompt);
    const packet = packetOf(prompt);
    expect(packet).toContain("Goal: Rate-limit the export endpoint");
    expect(packet).toContain("- note: short note");
    expect(packet).toMatch(/- tasks — by reference, \d+\.\d KB: list of 40: Task number 1 of the plan; Task number 2 of the plan; Task number 3 of the plan; \.\.\.\n {2}file: \.bb\/chats\/chain-pm\/artifacts\/wf-[A-Za-z0-9_-]+\/tasks\.[0-9a-f]{8}\.json/);
    expect(packet).toContain("Produce:\n- report/1 as the whole answer; needs handoff");
    // The full text is not in the prompt, it is in the file, exactly as the engine passed it.
    expect(prompt).not.toContain("Task number 17 of the plan");
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]!.path).toMatch(/\/\.bb\/chats\/chain-pm\/artifacts\/wf-[^/]+\/tasks\.[0-9a-f]{8}\.json$/);
    expect(JSON.parse(t.writes[0]!.content)).toEqual(big);
    expect(existsSync(t.writes[0]!.path)).toBe(true);
    expect(prompt).toContain(t.writes[0]!.path.slice(t.checkout.length + 1));
  });

  it("the packet is about 3 KB however much the step was given", async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, at) => [`extra${at}`, `value ${at} ${"y".repeat(200)}`]));
    const t = await setup({ read: [reply({ count: 1, handoff: "h" })] });
    dispose = t.dispose;
    const wide = reader({ gates: ["read.count >= 0"] }, { inputs: [{ name: "goal", type: "string" }, { name: "tasks", type: "array" }, ...Object.keys(many).map((name) => ({ name, type: "string", required: false }))] });
    await t.start(wide, { goal: "g ".repeat(2000), tasks: big, ...many }).done;
    const packet = packetOf(String(t.spawned[0]!.prompt));
    expect(Buffer.byteLength(packet, "utf8")).toBeLessThanOrEqual(3072);
    expect(packet).toContain("Gates (all must hold):\n- read.count >= 0");
    expect(packet).toContain("Produce:");
    // Inputs that did not fit became one file rather than being cut away: all of them are in it.
    expect(packet).toMatch(/- inputs — by reference, [\d.]+ KB: 32 values: goal, tasks, extra0, extra1/);
    expect(t.writes).toHaveLength(1);
    const kept = JSON.parse(t.writes[0]!.content) as Row;
    expect(Object.keys(kept)).toHaveLength(32);
    expect(kept.extra29).toBe(many.extra29);
    expect(String(kept.goal)).toHaveLength(4000);
  });

  it("the same value is the same file: two steps given the same input point at one path", async () => {
    const twice = chain({
      nodes: [
        { id: "first", type: "agent", role: "analyst", prompt: "First.", output: [{ name: "n", type: "number" }], produces: [{ kind: "report", version: 1 }] },
        { id: "second", type: "agent", role: "analyst", prompt: "Second.", output: [{ name: "n", type: "number" }], produces: [{ kind: "report", version: 1 }], session: "new" },
        { id: "done", type: "action", action: "emit", map: { n: "second.n" } },
      ],
      inputs: [{ name: "tasks", type: "array" }], outputs: [{ name: "n", type: "number", required: false }],
      edges: [{ from: "start", to: "first" }, { from: "first", to: "second" }, { from: "second", to: "done" }],
    });
    const t = await setup({ first: [reply({ n: 1, handoff: "a" })], second: [reply({ n: 2, handoff: "b" })] });
    dispose = t.dispose;
    await t.start(twice, { tasks: big }).done;
    expect(t.writes).toHaveLength(2);
    expect(t.writes[1]!.path).toBe(t.writes[0]!.path);
    expect(t.writes[1]!.content).toBe(t.writes[0]!.content);
  });

  it("when the file cannot be written the packet shows the input cut, and the step still runs", async () => {
    const t = await setup({ read: [reply({ count: 1, handoff: "h" })] }, { failWrites: true });
    dispose = t.dispose;
    const summary = await t.start(reader(), run).done;
    expect(summary.status).toBe("succeeded");
    const packet = packetOf(String(t.spawned[0]!.prompt));
    expect(packet).toContain("(cut)");
    expect(packet).not.toContain("by reference");
  });

  it("a node without a contract keeps the whole inputs in its prompt, as before", async () => {
    const t = await setup({ read: [reply({ count: 1, handoff: "h" })] });
    dispose = t.dispose;
    await t.start(reader({ produces: undefined }), run).done;
    const prompt = String(t.spawned[0]!.prompt);
    expect(prompt).toContain("<inputs>");
    expect(prompt).toContain("Task number 17 of the plan");
    expect(prompt).not.toContain("<step-packet>");
    expect(t.writes).toHaveLength(0);
  });

  it("a required artifact that did not arrive under its name stops the step before a helper is started", async () => {
    const t = await setup({ read: [reply({ count: 1, handoff: "h" })] });
    dispose = t.dispose;
    const summary = await t.start(reader({ consumes: [{ kind: "plan", version: 1, from: "$inputs", as: "plan" }] }), run).done;
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("consumes_missing");
    expect(t.spawned).toHaveLength(0);
  });

  it("the next step's packet carries the previous step's handoff by reference when it is long, and inline when it is short", async () => {
    const long = `Wrote the plan to .agents/plan.md. ${"Details of the work. ".repeat(60)}Unique tail marker 4711.`;
    const chained = chain({
      nodes: [
        { id: "first", type: "agent", role: "analyst", prompt: "First.", output: [{ name: "n", type: "number" }], produces: [{ kind: "report", version: 1 }] },
        { id: "second", type: "agent", role: "analyst", prompt: "Second.", output: [{ name: "n", type: "number" }], produces: [{ kind: "report", version: 1 }], consumes: [{ kind: "report", version: 1, from: "first" }], session: "new" },
        { id: "done", type: "action", action: "emit", map: { n: "second.n" } },
      ],
      inputs: [], outputs: [{ name: "n", type: "number", required: false }],
      edges: [{ from: "start", to: "first" }, { from: "first", to: "second", pass: "read-prior-session" }, { from: "second", to: "done" }],
    });
    const t = await setup({ first: [reply({ n: 1, handoff: long })], second: [reply({ n: 2, handoff: "ok" })] });
    dispose = t.dispose;
    const summary = await t.start(chained).done;
    expect(summary.status).toBe("succeeded");
    const packet = packetOf(String(t.spawned[1]!.prompt));
    expect(packet).toMatch(/- previous_handoff — by reference, [\d.]+ KB: Wrote the plan to \.agents\/plan\.md\./);
    expect(String(t.spawned[1]!.prompt)).not.toContain("Unique tail marker 4711");
    expect(t.writes.some((write) => write.content.includes("Unique tail marker 4711"))).toBe(true);
  });
});

describe("a phase stage's helper is told the folders it writes", () => {
  it("replaces «write nothing» with the folders of the author's own: the planner the phase folder and the plans folder, the analyst the phase folder", async () => {
    const { phaseWriteNote } = await import("../../src/rooms/workflow/server/workflow-agent");
    const { READ_ONLY_LINE } = await import("@lane-pilot/workflow-engine");
    const told = phaseWriteNote(`brief\n${READ_ONLY_LINE}\ncontract`, "ph_abc123", "planner");
    expect(told).not.toContain(READ_ONLY_LINE);
    expect(told).toContain(".agents/phases/ph_abc123/ and .agents/plans/");
    expect(phaseWriteNote("no line here", "ph_abc123", "analyst")).toContain(".agents/phases/ph_abc123/");
    expect(phaseWriteNote("no line here", "ph_abc123", "analyst")).not.toContain(".agents/plans/");
  });
});


describe("a node that runs as an agent the owner created", () => {
  const node = (role: string) => chain({
    nodes: [{ id: "write", type: "agent", role, prompt: "Write the post.", output: [{ name: "text", type: "string" }] }, { id: "done", type: "action", action: "emit", map: { text: "write.text" } }],
    outputs: [{ name: "text", type: "string", required: false }],
    edges: [{ from: "start", to: "write" }, { from: "write", to: "done" }],
  });
  const mine = { prompt: "You write posts for the owner's blog.", description: "Blog writer", meta: { displayName: "Blog writer", createdAt: 1, updatedAt: 1 } };

  it("runs the agent's own profile: its stored selection leads the first message, and the thread is marked as that specialist", async () => {
    const t = await setup({ write: [reply({ text: "A post.", handoff: "done" })] });
    dispose = t.dispose;
    const { compileMainAgentProfile } = await import("../../src/rooms/native-agent/agent-profile");
    await t.rt.ctx.saveOwnedAgents({ "blog-writer": { ...mine, compiled: compileMainAgentProfile("blog-writer", { prompt: mine.prompt, description: mine.description, skills: ["ru-text"] }) } } as never);
    const summary = await t.start(node("specialist:blog-writer")).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { text: "A post." } });
    const started = t.spawned[0]!;
    expect(started.pluginMetadata).toMatchObject({ role: "specialist", specialist: "blog-writer" });
    expect(String(started.prompt)).toMatch(/Native Lane profile blog-writer \(session-override\)\.\n\n/);
    expect(String(started.prompt)).toContain("Write the post.");
    const marker = /([0-9a-f]{8}-[0-9a-f-]{27})/u.exec(String(started.prompt))?.[1] ?? "";
    expect(await t.bb.storage.kv.get(`native-selection:${marker}`)).toMatchObject({ agentId: "blog-writer", projectId: PROJECT });
  });

  const named = chain({
    inputs: [{ name: "who", type: "string", required: false, default: "blog-writer" }],
    nodes: [{ id: "write", type: "agent", role: "specialist:{{$inputs.who}}", prompt: "Write the post.", output: [{ name: "text", type: "string" }] }, { id: "done", type: "action", action: "emit", map: { text: "write.text" } }],
    outputs: [{ name: "text", type: "string", required: false }],
    edges: [{ from: "start", to: "write" }, { from: "write", to: "done" }],
  });

  it("takes the agent from an input when the role is a template, and refuses an id that is no specialist instead of running it as an analyst", async () => {
    const t = await setup({ write: [reply({ text: "A post.", handoff: "done" })] });
    dispose = t.dispose;
    const { compileMainAgentProfile } = await import("../../src/rooms/native-agent/agent-profile");
    await t.rt.ctx.saveOwnedAgents({ "blog-writer": { ...mine, compiled: compileMainAgentProfile("blog-writer", { prompt: mine.prompt, description: mine.description }) } } as never);
    expect(await t.start(named).done).toMatchObject({ status: "succeeded", output: { text: "A post." } });
    expect(t.spawned[0]!.pluginMetadata).toMatchObject({ role: "specialist", specialist: "blog-writer" });
    const bundled = await t.start(named, { who: "seo-specialist" }).done;
    expect(bundled.status).toBe("succeeded");
    expect(t.spawned[1]!.pluginMetadata).toMatchObject({ specialist: "seo-specialist" });
    const reserved = await t.start(named, { who: "dev-orchestrator" }).done;
    expect(reserved.status).not.toBe("succeeded");
    expect(reserved.error).toContain('"dev-orchestrator" is neither a bundled specialist nor an agent you created');
    expect(t.spawned).toHaveLength(2);
  });

  it("stops the step with unknown_specialist when the agent does not exist (any more), and starts no thread", async () => {
    const t = await setup({ write: [reply({ text: "x", handoff: "x" })] });
    dispose = t.dispose;
    const summary = await t.start(node("specialist:ghost-writer")).done;
    expect(summary.status).not.toBe("succeeded");
    expect(JSON.stringify(summary)).toContain("unknown_specialist");
    expect(t.spawned).toHaveLength(0);
  });
});

describe("a run in a project that has no PM chat", () => {
  const agent = chain({
    nodes: [{ id: "look", type: "agent", role: "analyst", prompt: "Look.", output: [{ name: "n", type: "number" }] }, { id: "done", type: "action", action: "emit", map: { n: "look.n" } }],
    outputs: [{ name: "n", type: "number", required: false }],
    edges: [{ from: "start", to: "look" }, { from: "look", to: "done" }],
  });

  it("starts its helper as a hidden thread of the project with no parent, in the project's own folder, and no Lane Pilot run behind it", async () => {
    const t = await setup({ look: [reply({ n: 3, handoff: "looked" })] }, { noPm: true });
    dispose = t.dispose;
    const summary = await t.start(agent).done;
    expect(summary).toMatchObject({ status: "succeeded", output: { n: 3 } });
    const started = t.spawned[0]!;
    expect(started).toMatchObject({ visibility: "hidden", projectId: PROJECT, environment: { type: "host", hostId: "local", workspace: { type: "unmanaged", path: t.checkout } } });
    expect(started.parentThreadId).toBeUndefined();
    expect(started.pluginMetadata).not.toHaveProperty("lanePilotRunId");
    expect(started.pluginMetadata).not.toHaveProperty("parentPmThreadId");
    expect(t.db.prepare("SELECT link_run_id FROM lane_pilot_wf_run").all()).toEqual([{ link_run_id: null }]);
  });

  it("is rebuilt without a chat after a reload, and a step that builds code says it needs Lane Pilot", async () => {
    const t = await setup({}, { noPm: true });
    dispose = t.dispose;
    const row = { id: "wfrun_x", workflow_id: "chain-under-test", idem_key: null, project_id: PROJECT, link_run_id: null } as never;
    expect(chainRuntimeFor(t.rt.ctx, t.services)(row)).toMatchObject({ pmThreadId: null, runId: null, projectId: PROJECT });
    const code = chain({
      outputs: [{ name: "state", type: "string", required: false }],
      nodes: [{ id: "build", type: "lp-task", contract: { id: "t1", objective: "x" }, quality_mode: "quick", output: [{ name: "state", type: "string" }] }, { id: "done", type: "action", action: "emit", map: { state: "build.state" } }],
      edges: [{ from: "start", to: "build" }, { from: "build", to: "done" }],
    });
    const summary = await t.start(code).done;
    expect(summary.status).not.toBe("succeeded");
    expect(JSON.stringify(summary)).toContain("needs_lane_pilot");
  });

  const ask = chain({
    nodes: [
      { id: "ask", type: "human", role: "owner", question: "Ship it?", output: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["go", "fix", "timeout"] }], timeoutSec: 600 },
      { id: "done", type: "action", action: "emit", map: { kind: "ask.answer_kind" } },
    ],
    outputs: [{ name: "kind", type: "string", required: false }],
    edges: [{ from: "start", to: "ask" }, { from: "ask", to: "done" }],
  });
  const waitFor = async (read: () => unknown) => { for (let tries = 0; tries < 200 && !read(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

  it("puts the owner's question on his list with a push instead of a form, and his answer settles the step and closes the line", async () => {
    const t = await setup({}, { noPm: true });
    dispose = t.dispose;
    const started = t.start(ask);
    const items = () => t.db.prepare("SELECT key, source, kind, project_id, what, why, wake, state, actions_json FROM lane_pilot_owner_item").all() as Array<Record<string, any>>;
    await waitFor(() => items().length);
    expect(t.harness.pendingInteractions).toEqual([]);
    const [item] = items();
    expect(item).toMatchObject({ source: "workflow", kind: "workflow_question", project_id: PROJECT, wake: 1, state: "open", what: expect.stringContaining("Ship it?") });
    expect(item!.why).toContain("bb lane-pilot workflow-answer");
    const actions = JSON.parse(item!.actions_json) as Array<{ id: string; rpc: { method: string; input: Record<string, unknown> } }>;
    expect(actions.map((action) => action.id)).toEqual(["go", "fix"]);
    expect(actions[0]!.rpc).toMatchObject({ method: "workflow_answer", input: { runId: started.runId, choice: "go" } });

    expect(await answerWorkflowQuestion(t.rt.ctx, { workflowEngine: t.engine } as never, { runId: started.runId, choice: "maybe later" })).toMatchObject({ ok: false, reason: "answer_decides_nothing", options: ["go", "fix"] });
    expect(await answerWorkflowQuestion(t.rt.ctx, { workflowEngine: t.engine } as never, { runId: started.runId, stepKey: String(actions[0]!.rpc.input.stepKey), choice: "go" })).toMatchObject({ ok: true });
    expect(await started.done).toMatchObject({ status: "succeeded", output: { kind: "go" } });
    expect(items()[0]).toMatchObject({ state: "closed" });
    expect(await answerWorkflowQuestion(t.rt.ctx, { workflowEngine: t.engine } as never, { runId: started.runId, choice: "go" })).toMatchObject({ ok: false, reason: "not_waiting" });
  });

  it("tells the owner how it ended on his list, with a push when it went wrong", async () => {
    const t = await setup({ look: ["no json at all", "still none"] }, { noPm: true });
    dispose = t.dispose;
    const summary = await t.start(agent).done;
    expect(summary.status).not.toBe("succeeded");
    const run = t.db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(summary.runId) as never;
    expect(reportEndToOwner(t.db, run, false)).toBe(true);
    expect(t.db.prepare("SELECT source, kind, wake, project_id FROM lane_pilot_owner_item WHERE key LIKE 'workflow-end:%'").all()).toEqual([{ source: "workflow", kind: `workflow_${(run as { status: string }).status}`, wake: 1, project_id: PROJECT }]);
    expect(reportEndToOwner(t.db, run, false)).toBe(false);
  });
});
