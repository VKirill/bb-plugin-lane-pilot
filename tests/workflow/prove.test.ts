import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ModelCatalog } from "@lane-pilot/models";
import {
  computeEnvironmentFingerprint,
  definitionSha256,
  loadWorkflowStore,
  parseWorkflow,
  provenOn,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { Services } from "../../src/rooms/services";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import { registerCli } from "../../src/rooms/tools/server";
import { proveWorkflow } from "../../src/rooms/workflow/server";
import { workflow } from "./fixtures";

const tempDirs: string[] = [];
let dispose: (() => Promise<void> | void) | null = null;

afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const testCatalog = (runHostId: string | null = "mac"): ModelCatalog => ({
  runHostId,
  hosts: [
    { id: "mac", name: "Mac mini", connected: true },
    { id: "ovh", name: "OVH", connected: true },
  ],
  providers: [
    {
      id: "codex",
      displayName: "Codex",
      logoUrl: null,
      family: "gpt",
      supportsServiceTier: false,
      serviceTiers: [],
      hostIds: ["mac", "ovh"],
      models: [
        {
          id: "gpt-6.1-terra",
          model: "gpt-6.1-terra",
          displayName: "GPT-6.1 Terra",
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          isDefault: true,
          hostIds: ["mac", "ovh"],
        },
        {
          id: "gpt-6.1-sol",
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          efforts: ["high"],
          defaultEffort: "high",
          isDefault: false,
          hostIds: ["ovh"],
        },
      ],
    },
    {
      id: "opencode2",
      displayName: "OpenCode",
      logoUrl: null,
      family: "google",
      supportsServiceTier: false,
      serviceTiers: [],
      hostIds: ["mac"],
      models: [
        {
          id: "router9/ag/gemini-3.8-flash-high",
          model: "router9/ag/gemini-3.8-flash-high",
          displayName: "Gemini 3.8 Flash",
          efforts: ["medium", "high"],
          defaultEffort: "medium",
          isDefault: true,
          hostIds: ["mac"],
        },
      ],
    },
  ],
});

function makeStore(rawWorkflows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), "lp-wf-prove-"));
  tempDirs.push(dir);
  for (const wf of rawWorkflows) {
    writeFileSync(join(dir, `${String(wf.id)}.json`), JSON.stringify(wf), "utf8");
  }
  return () => loadWorkflowStore({ builtin: [], globalDir: dir });
}

function twoCaseAgentWorkflow() {
  return workflow({
    id: "draft-and-judge",
    name: { en: "Draft and Judge", ru: "Черновик и судья" },
    description: { en: "Draft then judge", ru: "Черновик и судья" },
    inputs: [{ name: "topic", type: "string", required: true }],
    outputs: [
      { name: "status", type: "string" },
      { name: "text", type: "string" },
    ],
    live_success: { output: "status", in: ["approved"] },
    nodes: [
      {
        id: "draft",
        type: "agent",
        role: "analyst",
        effect: "D",
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        prompt: "Draft {{input.topic}}",
        out: [{ name: "text", type: "string" }],
      },
      {
        id: "judge",
        type: "agent",
        role: "code-critic",
        effect: "R",
        provider: "opencode2",
        model: "router9/ag/gemini-3.8-flash-high",
        prompt: "Judge {{draft.text}}",
        out: [{ name: "verdict", type: "enum", values: ["approved", "rejected"] }],
      },
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { status: "judge.verdict", text: "draft.text" },
      },
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "judge" },
      { from: "judge", to: "done" },
    ],
    test: {
      id: "two-cases",
      sim: {
        input: { topic: "alpha" },
        stubs: {
          draft: { text: "alpha draft" },
          judge: { verdict: "approved" },
        },
        expect_status: "succeeded",
        expect_output: { status: "approved", text: "alpha draft" },
        variant_second: {
          input: { topic: "beta" },
          stubs: {
            draft: { text: "beta draft" },
            judge: { verdict: "approved" },
          },
          expect_output: { status: "approved", text: "beta draft" },
        },
      },
    },
  });
}

describe("Task 23: proveWorkflow and workflow prove CLI", () => {
  it("runs two stubbed cases, keeps judge node model frozen, upserts proof row, and exposes it in provenOn", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    const raw = twoCaseAgentWorkflow();
    const parsed = parseWorkflow(raw);
    const sha = definitionSha256(parsed);
    const loadStore = makeStore([raw]);

    const res = await proveWorkflow(
      ctx,
      { catalog: testCatalog("mac"), loadStore, now: () => 123_456 },
      { workflowId: "draft-and-judge", provider: "codex", model: "gpt-6.1-terra" },
    );

    expect(res).toEqual({
      ok: true,
      casesN: 2,
      passedN: 2,
      failures: [],
    });

    const proofRows = db
      .prepare("SELECT * FROM lane_pilot_wf_proof WHERE workflow_id = ?")
      .all("draft-and-judge") as Array<Record<string, unknown>>;
    expect(proofRows).toEqual([
      {
        workflow_id: "draft-and-judge",
        definition_sha256: sha,
        provider: "codex",
        model: "gpt-6.1-terra",
        cases_n: 2,
        passed_n: 2,
        cost_micro_usd: null,
        at: 123_456,
      },
    ]);

    // Inspect executed definitions from journal runs: worker got target model, judge kept original model.
    const runs = db
      .prepare("SELECT definition_json FROM lane_pilot_wf_run WHERE workflow_id LIKE 'draft-test.%'")
      .all() as Array<{ definition_json: string }>;
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const def = JSON.parse(run.definition_json) as Workflow;
      const draftNode = def.nodes.find((n) => n.id === "draft") as Extract<Workflow["nodes"][number], { type: "agent" }>;
      const judgeNode = def.nodes.find((n) => n.id === "judge") as Extract<Workflow["nodes"][number], { type: "agent" }>;
      expect(draftNode.provider).toBe("codex");
      expect(draftNode.model).toBe("gpt-6.1-terra");
      expect(judgeNode.provider).toBe("opencode2");
      expect(judgeNode.model).toBe("router9/ag/gemini-3.8-flash-high");
    }

    expect(provenOn(db, "draft-and-judge", sha)).toEqual([
      {
        nodeId: "*",
        provider: "codex",
        model: "gpt-6.1-terra",
        runs: 2,
        lastAt: 123_456,
        source: "proof",
      },
    ]);

    expect(
      harness.logEntries.some(
        (e) => e.level === "info" && e.message.includes("workflow prove wf=draft-and-judge model=codex/gpt-6.1-terra passed=2/2"),
      ),
    ).toBe(true);
  });

  it("refuses unknown or host-unavailable models and graphs with no cases", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    const noCasesWf = workflow({
      id: "no-cases-wf",
      nodes: [
        { id: "work", type: "agent", role: "analyst", prompt: "Work", out: [{ name: "out", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.out" } },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "done" },
      ],
    });
    const loadStore = makeStore([twoCaseAgentWorkflow(), noCasesWf]);

    const unknownRes = await proveWorkflow(
      ctx,
      { catalog: testCatalog("mac"), loadStore },
      { workflowId: "draft-and-judge", provider: "codex", model: "nonexistent-model" },
    );
    expect(unknownRes).toMatchObject({ ok: false, casesN: 0, passedN: 0, reason: "unknown_model" });

    // Model exists on ovh, but not offered on mac.
    const wrongHostRes = await proveWorkflow(
      ctx,
      { catalog: testCatalog("mac"), loadStore },
      { workflowId: "draft-and-judge", provider: "codex", model: "gpt-6.1-sol" },
    );
    expect(wrongHostRes).toMatchObject({ ok: false, casesN: 0, passedN: 0, reason: "unknown_model" });

    const noCasesRes = await proveWorkflow(
      ctx,
      { catalog: testCatalog("mac"), loadStore },
      { workflowId: "no-cases-wf", provider: "codex", model: "gpt-6.1-terra" },
    );
    expect(noCasesRes).toMatchObject({ ok: false, casesN: 0, passedN: 0, reason: "no_cases" });

    const count = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_proof").get() as { n: number }).n;
    expect(count).toBe(0);

    const warns = harness.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
    expect(warns.some((m) => m.includes("workflow prove refused wf=draft-and-judge: unknown_model"))).toBe(true);
    expect(warns.some((m) => m.includes("workflow prove refused wf=no-cases-wf: no_cases"))).toBe(true);
  });

  it("includes replay cases from past runs under replay policy and records partial pass without marking proven", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    const marker = join(tmpdir(), `lp-prove-replay-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const fingerprint = computeEnvironmentFingerprint();
    const replayWf = workflow({
      id: "replay-prove",
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        { id: "draft", type: "agent", role: "analyst", effect: "D", prompt: "Draft {{input.query}}", out: [{ name: "text", type: "string" }] },
        {
          id: "deliver_live",
          type: "agent",
          role: "errand",
          effect: "S",
          form: "script",
          script: { cmd: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], fingerprint },
          verify: "deliver_live.sent != ''",
          prompt: "Send {{draft.text}}",
          out: [{ name: "sent", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "deliver_live.sent" } },
      ],
      edges: [
        { from: "start", to: "draft" },
        { from: "draft", to: "deliver_live" },
        { from: "deliver_live", to: "done" },
      ],
    });
    const parsed = parseWorkflow(replayWf);
    const sha = definitionSha256(parsed);
    const defJson = JSON.stringify(parsed);

    // Run 1 has recorded outputs for both D and S nodes -> green replay.
    db.prepare(
      "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("r_ok", "replay-prove", 1, sha, defJson, "succeeded", JSON.stringify({ query: "q1" }), JSON.stringify({ result: "msg-1" }), 1000, 1000);
    db.prepare(
      "INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,output_json,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("r_ok", "draft#1", "draft#1", "draft", 1, "succeeded", JSON.stringify({ text: "hello" }), 1010, 1010);
    db.prepare(
      "INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,output_json,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("r_ok", "deliver_live#1", "deliver_live#1", "deliver_live", 1, "succeeded", JSON.stringify({ sent: "msg-1" }), 1020, 1020);

    // Run 2 is missing recorded output for S node -> replay_needs_stub without running script.
    db.prepare(
      "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("r_missing", "replay-prove", 1, sha, defJson, "failed", JSON.stringify({ query: "q2" }), null, 2000, 2000);
    db.prepare(
      "INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,output_json,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("r_missing", "draft#1", "draft#1", "draft", 1, "succeeded", JSON.stringify({ text: "world" }), 2010, 2010);

    const loadStore = makeStore([replayWf]);
    const res = await proveWorkflow(
      ctx,
      { catalog: testCatalog("mac"), loadStore, now: () => 5000 },
      { workflowId: "replay-prove", provider: "codex", model: "gpt-6.1-terra", cases: 10 },
    );

    expect(existsSync(marker)).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.casesN).toBe(2);
    expect(res.passedN).toBe(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.caseId).toBe("replay:r_missing");
    expect(res.failures[0]!.reason).toContain("replay_needs_stub");

    const row = db
      .prepare("SELECT cases_n, passed_n FROM lane_pilot_wf_proof WHERE workflow_id = ?")
      .get("replay-prove") as { cases_n: number; passed_n: number };
    expect(row).toEqual({ cases_n: 2, passed_n: 1 });
    expect(provenOn(db, "replay-prove", sha)).toEqual([]);
  });

  it("CLI `bb lane-pilot workflow prove invoice-send` writes a proof row without live side effects", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    harness.sdk.stub("hosts.list", async () => [{ id: "mac", name: "Mac mini", status: "connected" }]);
    harness.sdk.stub("providers.list", async () => [
      { id: "codex", displayName: "Codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] },
    ]);
    harness.sdk.stub("providers.models", async () => ({
      models: [
        {
          id: "gpt-6.1-terra",
          model: "gpt-6.1-terra",
          displayName: "GPT-6.1 Terra",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    }));

    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    registerCli(ctx, {} as Services, migrations);

    const cliOk = await harness.behavior.runCli([
      "workflow",
      "prove",
      "invoice-send",
      "--provider",
      "codex",
      "--model",
      "gpt-6.1-terra",
      "--cases",
      "5",
    ]);
    expect(cliOk.exitCode, cliOk.stderr ?? "").toBe(0);
    const body = JSON.parse(cliOk.stdout ?? "{}") as { ok: boolean; casesN: number; passedN: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.casesN).toBeGreaterThanOrEqual(5);
    expect(body.passedN).toBe(body.casesN);
    expect(body.failures).toEqual([]);

    const proofRow = db
      .prepare("SELECT workflow_id, definition_sha256, provider, model, cases_n, passed_n FROM lane_pilot_wf_proof WHERE workflow_id = 'invoice-send'")
      .get() as { workflow_id: string; definition_sha256: string; provider: string; model: string; cases_n: number; passed_n: number };
    expect(proofRow).toMatchObject({
      workflow_id: "invoice-send",
      provider: "codex",
      model: "gpt-6.1-terra",
      cases_n: body.casesN,
      passed_n: body.passedN,
    });
    expect(provenOn(db, "invoice-send", proofRow.definition_sha256)).toEqual([
      expect.objectContaining({
        nodeId: "*",
        provider: "codex",
        model: "gpt-6.1-terra",
        runs: body.passedN,
        source: "proof",
      }),
    ]);

    const cliBad = await harness.behavior.runCli([
      "workflow",
      "prove",
      "invoice-send",
      "--provider",
      "codex",
      "--model",
      "does-not-exist",
    ]);
    expect(cliBad.exitCode).toBe(1);
    expect(cliBad.stderr).toContain("unknown_model");
  });
});
