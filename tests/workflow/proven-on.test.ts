import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { definitionSha256, parseWorkflow, provenOn } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../src/rooms/services";
import { createWorkflowLibrary } from "../../src/rooms/workflow/server/services/workflow-library";
import { journalDb, trust } from "./engine-helpers";
import { workflow } from "./fixtures";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const agentWorkflow = (extra: Record<string, unknown> = {}) => workflow({
  id: "agent-flow",
  name: "Agent flow",
  status: "published",
  live_success: { output: "status", in: ["sent"] },
  nodes: [
    { id: "fetch", type: "action", action: "fetch", output: [{ name: "raw", type: "string" }] },
    { id: "draft", type: "agent", role: "worker", prompt: "Draft", output: [{ name: "text", type: "string" }] },
    { id: "review", type: "agent", role: "critic", prompt: "Review", output: [{ name: "status", type: "string" }] },
  ],
  edges: [
    { from: "start", to: "fetch" },
    { from: "fetch", to: "draft" },
    { from: "draft", to: "review" },
    { from: "review", to: "end", with: { result: "review.status" } },
  ],
  ...extra,
});

function insertRun(
  db: ReturnType<typeof journalDb>,
  opts: { id: string; workflowId: string; sha256: string; defJson: string; status: string; output: unknown; at: number },
) {
  db.prepare(
    "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(opts.id, opts.workflowId, 1, opts.sha256, opts.defJson, opts.status, JSON.stringify(opts.output), opts.at, opts.at);
}

function insertStep(
  db: ReturnType<typeof journalDb>,
  opts: { runId: string; nodeId: string; provider: string | null; model: string | null; at: number; state?: string },
) {
  db.prepare(
    "INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,answered_provider,answered_model,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, `${opts.nodeId}#1`, `${opts.nodeId}#1`, opts.nodeId, 1, opts.state ?? "succeeded", opts.provider, opts.model, opts.at, opts.at);
}

describe("provenOn", () => {
  it("returns empty list when tables do not exist", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const emptyDb = bb.storage.database();
    expect(provenOn(emptyDb, "agent-flow", "sha_missing")).toEqual([]);
  });

  it("counts models from live-success runs and ignores failed runs, non-proving outputs, and other shas", () => {
    const db = journalDb();
    const raw = agentWorkflow();
    const parsed = parseWorkflow(raw);
    const sha = definitionSha256(parsed);
    const defJson = JSON.stringify(parsed);

    // Two succeeded runs satisfying live_success
    insertRun(db, { id: "r1", workflowId: parsed.id, sha256: sha, defJson, status: "succeeded", output: { status: "sent" }, at: 100 });
    insertStep(db, { runId: "r1", nodeId: "draft", provider: "anthropic", model: "claude-sonnet-x", at: 100 });
    insertStep(db, { runId: "r1", nodeId: "review", provider: "openai", model: "gpt-x", at: 101 });

    insertRun(db, { id: "r2", workflowId: parsed.id, sha256: sha, defJson, status: "succeeded", output: { status: "sent" }, at: 200 });
    insertStep(db, { runId: "r2", nodeId: "draft", provider: "anthropic", model: "claude-sonnet-x", at: 200 });
    insertStep(db, { runId: "r2", nodeId: "review", provider: "anthropic", model: "claude-sonnet-x", at: 201 });

    // Ignored: failed run
    insertRun(db, { id: "r3", workflowId: parsed.id, sha256: sha, defJson, status: "failed", output: { status: "sent" }, at: 300 });
    insertStep(db, { runId: "r3", nodeId: "draft", provider: "openai", model: "gpt-failed", at: 300, state: "failed" });

    // Ignored: succeeded run whose output does not satisfy live_success
    insertRun(db, { id: "r4", workflowId: parsed.id, sha256: sha, defJson, status: "succeeded", output: { status: "aborted" }, at: 400 });
    insertStep(db, { runId: "r4", nodeId: "draft", provider: "openai", model: "gpt-aborted", at: 400 });

    // Ignored: different sha
    insertRun(db, { id: "r5", workflowId: parsed.id, sha256: "other_sha", defJson, status: "succeeded", output: { status: "sent" }, at: 500 });
    insertStep(db, { runId: "r5", nodeId: "draft", provider: "openai", model: "gpt-other-sha", at: 500 });

    const rows = provenOn(db, parsed.id, sha);
    expect(rows).toEqual([
      { nodeId: "review", provider: "anthropic", model: "claude-sonnet-x", runs: 1, lastAt: 201, source: "live" },
      { nodeId: "draft", provider: "anthropic", model: "claude-sonnet-x", runs: 2, lastAt: 200, source: "live" },
      { nodeId: "review", provider: "openai", model: "gpt-x", runs: 1, lastAt: 101, source: "live" },
    ]);
  });

  it("includes lane_pilot_wf_proof rows when that table exists", () => {
    const db = journalDb();
    db.exec(`CREATE TABLE lane_pilot_wf_proof (
      workflow_id TEXT NOT NULL,
      definition_sha256 TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cases_n INTEGER NOT NULL,
      passed_n INTEGER NOT NULL,
      cost_micro_usd INTEGER,
      at INTEGER NOT NULL,
      PRIMARY KEY (workflow_id, definition_sha256, provider, model)
    )`);
    db.prepare("INSERT INTO lane_pilot_wf_proof(workflow_id,definition_sha256,provider,model,cases_n,passed_n,at) VALUES (?,?,?,?,?,?,?)")
      .run("agent-flow", "sha1", "openai", "gpt-proof", 2, 2, 500);
    // Partial pass (passed_n < cases_n) and other sha are ignored.
    db.prepare("INSERT INTO lane_pilot_wf_proof(workflow_id,definition_sha256,provider,model,cases_n,passed_n,at) VALUES (?,?,?,?,?,?,?)")
      .run("agent-flow", "sha1", "anthropic", "claude-partial", 2, 1, 600);
    db.prepare("INSERT INTO lane_pilot_wf_proof(workflow_id,definition_sha256,provider,model,cases_n,passed_n,at) VALUES (?,?,?,?,?,?,?)")
      .run("agent-flow", "sha2", "anthropic", "claude-other", 2, 2, 700);

    expect(provenOn(db, "agent-flow", "sha1")).toEqual([
      { nodeId: "*", provider: "openai", model: "gpt-proof", runs: 2, lastAt: 500, source: "proof" },
    ]);
  });

  it("surfaces deduplicated proven_on over agent nodes only in the library RPC row", async () => {
    const db = journalDb();
    const globalDir = await mkdtemp(join(tmpdir(), "lp-proven-on-"));
    dirs.push(globalDir);

    const raw = agentWorkflow();
    await writeFile(join(globalDir, "agent-flow.json"), JSON.stringify(raw));
    trust(db, raw);

    const parsed = parseWorkflow(raw);
    const sha = definitionSha256(parsed);
    const defJson = JSON.stringify(parsed);

    insertRun(db, { id: "r1", workflowId: parsed.id, sha256: sha, defJson, status: "succeeded", output: { status: "sent" }, at: 100 });
    insertStep(db, { runId: "r1", nodeId: "fetch", provider: "ignored", model: "non-agent-model", at: 99 });
    insertStep(db, { runId: "r1", nodeId: "draft", provider: "anthropic", model: "claude-sonnet-x", at: 100 });
    insertStep(db, { runId: "r1", nodeId: "review", provider: "openai", model: "gpt-x", at: 101 });

    insertRun(db, { id: "r2", workflowId: parsed.id, sha256: sha, defJson, status: "succeeded", output: { status: "sent" }, at: 200 });
    insertStep(db, { runId: "r2", nodeId: "draft", provider: "anthropic", model: "claude-sonnet-x", at: 200 });
    insertStep(db, { runId: "r2", nodeId: "review", provider: "anthropic", model: "claude-sonnet-x", at: 201 });

    const ctx = { db, log: () => undefined, host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
    const services = { workflowEngine: { resolveWorkflow: () => null }, docsPlaces: async () => [] } as unknown as Services;
    const library = createWorkflowLibrary(ctx, services, { globalDir });

    const detail = (await library.get({ id: parsed.id })).workflow!;
    expect(detail.proven).toEqual({ runId: "r2", at: 200 });
    expect(detail.proven_on).toEqual([
      { provider: "anthropic", model: "claude-sonnet-x", runs: 2 },
      { provider: "openai", model: "gpt-x", runs: 1 },
    ]);
  });
});
