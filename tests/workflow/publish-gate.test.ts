import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { globalWorkflowDir, parseWorkflow } from "@lane-pilot/workflow-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { issueEvolutionReceipt } from "../../src/rooms/evolve/server";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  builtinWorkflow,
  consumeAuthority,
  createWorkflowArchitect,
  draftSha256,
  grantOwner,
  publishEvolutionWorkflowDraft,
  type ArchitectDeps,
} from "../../src/rooms/workflow/server";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function tempDir(prefix = "lp-pub-gate-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv("HOME", tempDir("lp-pub-home-"));
});

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleWorkflow(id = "gate-sample"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name: { en: `Workflow ${id}`, ru: `Граф ${id}` },
    description: { en: "Sample workflow for publish gate verification", ru: "Тестовый граф" },
    kind: "routine",
    inputs: [],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      { id: "work", type: "agent", effect: "R", prompt: "Do work", out: [{ name: "result", type: "string" }] },
      { id: "done", type: "action", action: "emit", map: { result: "work.result" } },
    ],
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "done" },
    ],
    test: {
      id: "smoke",
      sim: {
        input: {},
        stubs: { work: { result: "ok" } },
        expect_path: ["work", "done"],
        expect_output: { result: "ok" },
      },
    },
  };
}

function makeArchitectHarness(logs: { info: string[]; warn: string[] }) {
  const globalDir = tempDir("lp-pub-global-");
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const infoOrig = bb.log.info.bind(bb.log);
  const warnOrig = bb.log.warn.bind(bb.log);
  bb.log.info = (m: string) => {
    logs.info.push(m);
    infoOrig(m);
  };
  bb.log.warn = (m: string) => {
    logs.warn.push(m);
    warnOrig(m);
  };
  const db = openDatabase(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const ctx = createCore(bb, db);
  const deps: ArchitectDeps = {
    globalDir: () => globalDir,
    projectPlace: async () => null,
    writeProjectFile: async () => ({ status: "applied", path: "", afterSha256: null, reason: null }),
    capabilityPorts: () => ({}),
    hasExecutor: () => true,
  };
  const architect = createWorkflowArchitect(ctx, { workflowEngine: { hasExecutor: () => true } as never }, deps);
  return { bb, db, ctx, architect, globalDir };
}

describe("Task 51: workflow publish authority gate", () => {
  it("refuses architect.publish and publishEvolutionWorkflowDraft without authority", async () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    const { db, ctx, architect, globalDir } = makeArchitectHarness(logs);

    const created = architect.create({
      projectId: "proj_gate",
      threadId: "thr_gate",
      scope: "global",
      workflowId: "gate-no-auth",
      name: { en: "No auth", ru: "Без прав" },
      description: { en: "Must refuse", ru: "Отказ" },
      definition: sampleWorkflow("gate-no-auth"),
    });
    expect((await architect.test({ projectId: "proj_gate", draftId: created.draftId })).green).toBe(true);

    const refused = await architect.publish({ projectId: "proj_gate", draftId: created.draftId });
    expect(refused).toMatchObject({ ok: false, published: false, reason: "no_publish_authority" });
    expect(existsSync(join(globalDir, "gate-no-auth.json"))).toBe(false);
    expect(logs.warn.some((m) => m.includes(`publish refused draft=${created.draftId} reason=no_publish_authority`))).toBe(true);

    const evoRefused = await publishEvolutionWorkflowDraft(
      ctx,
      { globalDir: () => globalDir },
      { draftId: created.draftId, ensureTests: true },
    );
    expect(evoRefused).toMatchObject({ ok: false, reason: "no_publish_authority" });

    // Built-ins shipped in workflows/ remain unaffected.
    expect(builtinWorkflow("invoice-send")).toMatchObject({ id: "invoice-send", status: "tested" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_publish_authority WHERE draft_id=?").get(created.draftId)).toEqual({ n: 0 });
  });

  it("publishes once with an owner grant and refuses reuse of the consumed grant", async () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    const { db, architect, globalDir } = makeArchitectHarness(logs);

    const created = architect.create({
      projectId: "proj_gate",
      threadId: "thr_gate",
      scope: "global",
      workflowId: "gate-once",
      name: { en: "Grant once", ru: "Один раз" },
      description: { en: "Single use grant", ru: "Одноразовый грант" },
      definition: sampleWorkflow("gate-once"),
    });
    expect((await architect.test({ projectId: "proj_gate", draftId: created.draftId })).green).toBe(true);

    const grant = grantOwner(db, created.draftId, "cli", { log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) } });
    expect(grant).toMatchObject({ kind: "owner", draftId: created.draftId, via: "cli" });
    expect(logs.info.some((m) => m.includes(`publish authority kind=owner draft=${created.draftId} sha=${grant!.draftSha256.slice(0, 8)}`))).toBe(true);

    const first = await architect.publish({ projectId: "proj_gate", draftId: created.draftId });
    expect(first).toMatchObject({ published: true, workflowId: "gate-once", workflowVersion: 1 });
    expect(existsSync(join(globalDir, "gate-once.json"))).toBe(true);

    const row = db.prepare("SELECT used_at FROM lane_pilot_wf_publish_authority WHERE draft_id=? AND draft_sha256=?").get(created.draftId, grant!.draftSha256) as { used_at: number | null };
    expect(row.used_at).toEqual(expect.any(Number));

    // Reusing the same consumed grant is refused.
    const second = await architect.publish({ projectId: "proj_gate", draftId: created.draftId });
    expect(second).toMatchObject({ ok: false, published: false, reason: "no_publish_authority" });
    expect(consumeAuthority(db, created.draftId, grant!.draftSha256)).toEqual({ ok: false, reason: "no_publish_authority" });
  });

  it("refuses publish with draft_changed_after_grant when the draft is edited after the grant", async () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    const { db, architect, globalDir } = makeArchitectHarness(logs);

    const created = architect.create({
      projectId: "proj_gate",
      threadId: "thr_gate",
      scope: "global",
      workflowId: "gate-edited",
      name: { en: "Edited after grant", ru: "Изменён после гранта" },
      description: { en: "Must refuse stale grant", ru: "Отказ при правке" },
      definition: sampleWorkflow("gate-edited"),
    });
    expect((await architect.test({ projectId: "proj_gate", draftId: created.draftId })).green).toBe(true);
    const grant = grantOwner(db, created.draftId, "desk");
    expect(grant).not.toBeNull();

    const patched = architect.patch({
      projectId: "proj_gate",
      draftId: created.draftId,
      ops: [{ op: "update_node", id: "work", set: { prompt: "Do different work" } }],
    });
    expect(patched.ok).toBe(true);
    expect((await architect.test({ projectId: "proj_gate", draftId: created.draftId })).green).toBe(true);

    const refused = await architect.publish({ projectId: "proj_gate", draftId: created.draftId });
    expect(refused).toMatchObject({ ok: false, published: false, reason: "draft_changed_after_grant" });
    expect(existsSync(join(globalDir, "gate-edited.json"))).toBe(false);
    expect(logs.warn.some((m) => m.includes(`publish refused draft=${created.draftId} reason=draft_changed_after_grant`))).toBe(true);

    // Re-granting for the new sha succeeds.
    const freshGrant = grantOwner(db, created.draftId, "desk");
    expect(freshGrant!.draftSha256).not.toBe(grant!.draftSha256);
    const published = await architect.publish({ projectId: "proj_gate", draftId: created.draftId });
    expect(published).toMatchObject({ published: true, workflowId: "gate-edited" });
  });

  it("publishes with an evolution gate receipt and refuses reuse", async () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    const { db, ctx, architect, globalDir } = makeArchitectHarness(logs);

    const created = architect.create({
      projectId: "proj_gate",
      threadId: null as never,
      scope: "global",
      workflowId: "gate-evo",
      name: { en: "Evo gate", ru: "Эволюция" },
      description: { en: "Published by evolution receipt", ru: "Чек эволюции" },
      definition: sampleWorkflow("gate-evo"),
    });
    const draft = architect.drafts.get(created.draftId)!;
    const expectedSha = draftSha256(draft.definition);
    const receipt = issueEvolutionReceipt(db, {
      draftId: draft.id,
      trialId: "trial_42",
      decision: "promote",
      log: (m) => logs.info.push(m),
    });
    expect(receipt).toEqual({
      kind: "evolution",
      draftId: draft.id,
      draftSha256: expectedSha,
      trialId: "trial_42",
      decision: "promote",
      issuedAt: expect.any(Number),
    });
    expect(logs.info.some((m) => m.includes(`publish authority kind=evolution draft=${draft.id} sha=${expectedSha.slice(0, 8)}`))).toBe(true);

    const pub = await publishEvolutionWorkflowDraft(
      ctx,
      { globalDir: () => globalDir },
      { draftId: draft.id, ensureTests: true },
    );
    expect(pub).toMatchObject({ ok: true, version: 1 });
    expect(existsSync(join(globalDir, "gate-evo.json"))).toBe(true);
    expect(parseWorkflow(JSON.parse(readFileSync(join(globalDir, "gate-evo.json"), "utf8"))).status).toBe("published");

    // Second call without a new receipt is refused.
    const again = await publishEvolutionWorkflowDraft(
      ctx,
      { globalDir: () => globalDir },
      { draftId: draft.id, ensureTests: true },
    );
    expect(again).toMatchObject({ ok: false, reason: "no_publish_authority" });
  });

  it("enforces owner confirmation in PM tool (chat) and --owner in CLI (terminal only)", async () => {
    let lastTurnInputText = "Create a workflow for digests";
    let lastTurnInitiator = "user";
    let seq = 1;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: "proj_chat", environmentId: "env_chat" }),
          getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run-chat" }),
          events: {
            list: async () => [{
              seq,
              type: "client/turn/requested",
              createdAt: Date.now(),
              data: { initiator: lastTurnInitiator, input: [{ type: "text", text: lastTurnInputText }] },
            }],
          },
        },
        environments: { get: async () => ({ id: "env_chat", hostId: "h1", path: tempDir("lp-ws-"), status: "ready" }) },
      } as never,
    });
    await plugin(bb);
    cleanups.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);
    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: "thr_chat", projectId: "proj_chat" }))) as Record<string, any>;

    const created = await call("lane_pilot_workflow_draft_create", {
      name: "Chat gate",
      description: "Requires owner confirmation in chat",
      scope: "global",
      workflowId: "chat-gate",
    });
    const draftId = created.draftId as string;
    const def = sampleWorkflow("chat-gate");
    await call("lane_pilot_workflow_draft_patch", {
      draftId,
      ops: [
        { op: "add_node", node: (def.nodes as unknown[])[0] },
        { op: "add_node", node: (def.nodes as unknown[])[1] },
        { op: "add_edge", edge: (def.edges as unknown[])[0] },
        { op: "add_edge", edge: (def.edges as unknown[])[1] },
        { op: "set_meta", set: { test: def.test } },
      ],
    });
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);

    // 1. PM tool called without owner confirmation -> refused.
    const unconfirmed = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(unconfirmed).toMatchObject({ published: false, reason: "no_publish_authority" });

    // 2. Unrelated lane_pilot_ask_owner answer -> still refused.
    const askOther = harness.behavior.callAgentTool(
      "lane_pilot_ask_owner",
      { question: "Which channel?", options: ["Telegram", "Email"] },
      { threadId: "thr_chat", projectId: "proj_chat" },
    );
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { choice: "1" });
    await askOther;
    expect(await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true })).toMatchObject({ published: false, reason: "no_publish_authority" });

    // 3. Explicit lane_pilot_ask_owner confirmation -> grants via chat and publishes once.
    const askPublish = harness.behavior.callAgentTool(
      "lane_pilot_ask_owner",
      { question: "Publish workflow chat-gate?", options: ["Publish", "Cancel"] },
      { threadId: "thr_chat", projectId: "proj_chat" },
    );
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { choice: "1" });
    await askPublish;
    const pubViaForm = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(pubViaForm).toMatchObject({ published: true, workflowId: "chat-gate" });
    expect(existsSync(join(globalWorkflowDir(), "chat-gate.json"))).toBe(true);

    const authRow = db.prepare("SELECT kind, ref, used_at FROM lane_pilot_wf_publish_authority WHERE draft_id=?").get(draftId) as { kind: string; ref: string; used_at: number };
    expect(authRow).toMatchObject({ kind: "owner", ref: "chat" });
    expect(authRow.used_at).toEqual(expect.any(Number));

    // 4. Patch to v2, then owner confirms in direct chat message -> publishes via chat.
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "update_node", id: "work", set: { prompt: "Do v2 work" } }] });
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
    seq = 2;
    lastTurnInputText = "Да, опубликуй новую версию";
    const pubViaMsg = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(pubViaMsg).toMatchObject({ published: true, workflowVersion: 2 });

    // Same chat message cannot authorize another edit without a fresh confirmation.
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "update_node", id: "work", set: { prompt: "Do v3 work" } }] });
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
    expect(await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true })).toMatchObject({ published: false, reason: "no_publish_authority" });

    // 5. CLI `workflow publish <draftId>` without --owner fails, from thread fails, with --owner from terminal succeeds.
    const noFlag = await harness.behavior.runCli(["workflow", "publish", draftId]);
    expect(noFlag.exitCode).toBe(1);
    expect(noFlag.stderr).toContain("--owner");

    const fromThread = await harness.behavior.runCli(["workflow", "publish", draftId, "--owner"], { threadId: "thr_chat" } as never);
    expect(fromThread.exitCode).toBe(1);
    expect(fromThread.stderr).toContain("terminal");

    const cliOk = await harness.behavior.runCli(["workflow", "publish", draftId, "--owner", "--json"]);
    expect(cliOk.exitCode, cliOk.stderr ?? "").toBe(0);
    expect(JSON.parse(cliOk.stdout ?? "{}")).toMatchObject({ published: true, workflowVersion: 3 });
  });
});
