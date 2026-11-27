import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { OWNER_REFUSAL_REASONS, RUN_VERDICTS, RUN_VERDICT_SOURCES } from "@lane-pilot/contracts";
import { WorkflowEngine, parseWorkflow, registerPureActions, type RunRow } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { createRun, migrations, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { registerCli } from "../../src/rooms/tools/server";
import { workflowRoomMigrations } from "../../src/rooms/workflow/migrations";
import {
  createRunFinished,
  deriveRunVerdict,
  getRunVerdict,
  listRunVerdicts,
  recordOwnerRunVerdict,
  setRunVerdict,
} from "../../src/rooms/workflow/server";
import { maybeNotifyWorkflowRun, reportEndToOwner } from "../../src/rooms/workflow/server/services/pm-notice";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";
import { ok } from "./engine-helpers";

const PROJECT = "proj-verdict";
const PM = "pm-verdict";
const LP_RUN = "lprun-verdict";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function insertWfRun(
  db: ReturnType<typeof openDatabase>,
  patch: Partial<{
    id: string;
    workflow_id: string;
    workflow_version: number;
    project_id: string | null;
    status: string;
    definition_json: string;
    inputs_json: string;
    parent_run_id: string | null;
    created_at: number;
    updated_at: number;
  }> = {},
): string {
  const id = patch.id ?? `wfrun_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, parent_run_id, status, inputs_json, created_at, updated_at)
     VALUES (?, ?, ?, 'sha', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    patch.workflow_id ?? "demo-flow",
    patch.workflow_version ?? 1,
    patch.definition_json ?? "{}",
    patch.project_id === undefined ? PROJECT : patch.project_id,
    patch.parent_run_id ?? null,
    patch.status ?? "succeeded",
    patch.inputs_json ?? "{}",
    patch.created_at ?? 1000,
    patch.updated_at ?? 2000,
  );
  return id;
}

describe("run verdict contracts and DDL", () => {
  it("matches the SQL CHECK constraint list to OWNER_REFUSAL_REASONS and RUN_VERDICTS", () => {
    const ddl = workflowRoomMigrations.find((sql) => sql.includes("CREATE TABLE lane_pilot_wf_run_verdict")) ?? "";
    const reasonCheck = /reason TEXT CHECK\(reason IS NULL OR reason IN \(([^)]+)\)\)/.exec(ddl)?.[1];
    expect(reasonCheck).toBeDefined();
    const sqlReasons = reasonCheck!.split(",").map((part) => part.trim().replace(/^'|'$/g, ""));
    expect(sqlReasons).toEqual([...OWNER_REFUSAL_REASONS]);

    const verdictCheck = /verdict TEXT NOT NULL CHECK\(verdict IN \(([^)]+)\)\)/.exec(ddl)?.[1];
    expect(verdictCheck!.split(",").map((part) => part.trim().replace(/^'|'$/g, ""))).toEqual([...RUN_VERDICTS]);

    const sourceCheck = /source TEXT NOT NULL CHECK\(source IN \(([^)]+)\)\)/.exec(ddl)?.[1];
    expect(sourceCheck!.split(",").map((part) => part.trim().replace(/^'|'$/g, ""))).toEqual([...RUN_VERDICT_SOURCES]);
  });
});

describe("run verdict repository & precedence", () => {
  it("returns null for unreviewed runs, lets owner override human_node, and blocks human_node from overriding owner", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    expect(getRunVerdict(db, "missing-run")).toBeNull();

    setRunVerdict(db, {
      runId: "run_1",
      workflowId: "invoice-send",
      graphVersion: 2,
      verdict: "accept",
      source: "human_node",
      decidedAt: 100,
    });
    expect(getRunVerdict(db, "run_1")).toMatchObject({
      runId: "run_1",
      workflowId: "invoice-send",
      graphVersion: 2,
      verdict: "accept",
      source: "human_node",
      reason: null,
      note: null,
      decidedAt: 100,
    });

    // Owner reject overrides derived accept.
    const ownerWrite = setRunVerdict(db, {
      runId: "run_1",
      workflowId: "invoice-send",
      graphVersion: 2,
      verdict: "reject",
      source: "owner",
      reason: "wrong_result",
      note: "amount off",
      decidedAt: 200,
    });
    expect(ownerWrite.written).toBe(true);
    expect(getRunVerdict(db, "run_1")).toMatchObject({
      verdict: "reject",
      source: "owner",
      reason: "wrong_result",
      note: "amount off",
      decidedAt: 200,
    });

    // Derived human_node never overrides owner.
    const derivedOverwrite = setRunVerdict(db, {
      runId: "run_1",
      workflowId: "invoice-send",
      graphVersion: 2,
      verdict: "accept",
      source: "human_node",
      decidedAt: 300,
    });
    expect(derivedOverwrite.written).toBe(false);
    expect(getRunVerdict(db, "run_1")).toMatchObject({
      verdict: "reject",
      source: "owner",
      reason: "wrong_result",
      decidedAt: 200,
    });

    setRunVerdict(db, {
      runId: "run_2",
      workflowId: "deploy",
      graphVersion: 1,
      verdict: "accept",
      source: "owner",
      decidedAt: 250,
    });
    expect(listRunVerdicts(db, { workflowId: "invoice-send", since: 150 })).toHaveLength(1);
    expect(listRunVerdicts(db, { workflowId: "invoice-send", since: 250 })).toHaveLength(0);
    expect(listRunVerdicts(db, { since: 0 }).map((r) => r.runId)).toEqual(["run_2", "run_1"]);
  });
});

describe("run verdict CLI and PM tool", () => {
  it("CLI accept writes a row, rejects unknown reason/run/unfinished run, and never logs note text", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    registerCli(ctx, {} as Services, migrations);

    const finishedId = insertWfRun(db, { id: "wf_fin_1", workflow_id: "deploy", workflow_version: 3, status: "succeeded" });
    const runningId = insertWfRun(db, { id: "wf_run_1", workflow_id: "deploy", workflow_version: 3, status: "running" });

    const secretNote = "Private owner note NEVER_LOG_THIS_TOKEN";
    const okRes = await harness.behavior.runCli(["run-verdict", finishedId, "accept", "--note", secretNote]);
    expect(okRes.exitCode).toBe(0);
    expect(getRunVerdict(db, finishedId)).toMatchObject({
      runId: finishedId,
      workflowId: "deploy",
      graphVersion: 3,
      verdict: "accept",
      source: "owner",
      reason: null,
      note: secretNote,
    });

    // Unknown reason refused
    const badReason = await harness.behavior.runCli(["run-verdict", finishedId, "reject", "--reason", "not_a_reason"]);
    expect(badReason.exitCode).toBe(1);
    expect(badReason.stderr).toContain("unknown reason");
    expect(getRunVerdict(db, finishedId)!.verdict).toBe("accept");

    // Unknown run refused
    const missingRun = await harness.behavior.runCli(["run-verdict", "wf_missing", "accept"]);
    expect(missingRun.exitCode).toBe(1);
    expect(missingRun.stderr).toContain("unknown run");

    // Unfinished run refused
    const unfinished = await harness.behavior.runCli(["run-verdict", runningId, "reject", "--reason", "too_costly"]);
    expect(unfinished.exitCode).toBe(1);
    expect(unfinished.stderr).toContain("not finished");

    // Reject with valid reason updates
    const rejRes = await harness.behavior.runCli(["run-verdict", finishedId, "reject", "--reason", "too_costly", "--note", secretNote]);
    expect(rejRes.exitCode).toBe(0);
    expect(getRunVerdict(db, finishedId)).toMatchObject({
      verdict: "reject",
      source: "owner",
      reason: "too_costly",
      note: secretNote,
    });

    const infos = harness.logEntries.filter((e) => e.level === "info").map((e) => e.message);
    const warns = harness.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
    expect(infos.some((m) => m.includes(`run verdict run=${finishedId} verdict=accept source=owner reason=none`))).toBe(true);
    expect(infos.some((m) => m.includes(`run verdict run=${finishedId} verdict=reject source=owner reason=too_costly`))).toBe(true);
    expect(warns.some((m) => m.includes(`run verdict refused run=${finishedId}: unknown reason`))).toBe(true);
    expect(warns.some((m) => m.includes("run verdict refused run=wf_missing: unknown run"))).toBe(true);
    expect(warns.some((m) => m.includes(`run verdict refused run=${runningId}: run not finished`))).toBe(true);
    expect(harness.logEntries.some((e) => e.message.includes("NEVER_LOG_THIS_TOKEN"))).toBe(false);
  });

  it("registers lane_pilot_run_verdict in room workflow with the required description and records verdicts from a PM chat", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const tool = harness.registrations.agentTools.find((t) => t.name === "lane_pilot_run_verdict");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("only after the owner said it in this chat");

    const db = bb.storage.database();
    const sameProjRun = insertWfRun(db, { id: "wf_pm_1", workflow_id: "invoice-send", project_id: PROJECT, status: "succeeded" });
    const otherProjRun = insertWfRun(db, { id: "wf_pm_2", workflow_id: "invoice-send", project_id: "other-proj", status: "succeeded" });

    const recorded = JSON.parse(
      String(await harness.behavior.callAgentTool("lane_pilot_run_verdict", { runId: sameProjRun, verdict: "reject", reason: "off_brand", note: "too casual" }, { threadId: PM, projectId: PROJECT })),
    ) as { status: string; verdict: { verdict: string; reason: string; source: string } };
    expect(recorded.status).toBe("recorded");
    expect(recorded.verdict).toMatchObject({ verdict: "reject", reason: "off_brand", source: "owner" });

    const refused = JSON.parse(
      String(await harness.behavior.callAgentTool("lane_pilot_run_verdict", { runId: otherProjRun, verdict: "accept" }, { threadId: PM, projectId: PROJECT })),
    ) as { status: string; reason: string };
    expect(refused.status).toBe("refused");
    expect(getRunVerdict(db, otherProjRun)).toBeNull();
  });
});

describe("deriving verdicts from human steps", () => {
  it("derives accept from a human send answer on invoice-send, lets owner reject override, and ignores subsequent derivation", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, LP_RUN, PROJECT, "cli");
    setRunThread(db, LP_RUN, PM);

    const ctx = { bb, db, isDisposed: () => false, effectiveProjectSettings: async () => ({ values: {} }), log: () => undefined } as never;
    let onRunEvent!: (runId: string) => Promise<void>;
    const engine = new WorkflowEngine({
      db,
      harnessVersion: "1.0.0",
      resolveWorkflow: (id) => builtinWorkflow(id),
      onEvent: (runId) => { void onRunEvent(runId); },
    });
    registerPureActions(engine);
    engine.register("agent", {
      reentrant: true,
      run: async () => ({
        usage: { tokens: 0, costUsd: 0, costState: "measured" },
        output: {
          status: "done",
          reason: "",
          handoff: "created invoice 142",
          invoice_number: "142",
          invoice_date: "2026-11-26",
          invoice_url: "https://elba.example/142",
          pdf_path: "/tmp/inv.pdf",
          client_name: "Ромашка",
          client_inn: "7707083893",
          invoice_amount: 50000,
          invoice_service: "SEO",
          pay_bik: "044525225",
          pay_account: "40702810200000012345",
          pay_corr_account: "30101810400000000225",
          payee_inn: "500100732259",
        },
      }),
    });
    engine.register("invoice.check", ok(() => ({ verdict: "match", reasons: [], by: "rules" })));
    engine.register("schedule.create", ok(() => ({ status: "now", schedule_id: "", run_at: "", reason: "" })));
    engine.register("telegram.send_rich", ok(() => ({ message_id: "m1", status: "sent" })));
    engine.register("telegram.send_file", ok(() => ({ status: "sent", message_id: "m2", message_url: "https://t.me/c/1/2", reason: "" })));

    const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
      loadStore: async () => ({ store: { list: () => [], get: () => null, resolve: () => null, problems: [] }, project: "ok" }),
    });
    onRunEvent = createRunFinished(ctx, {
      triggers,
      subscribers: [(run) => { deriveRunVerdict(db, run, Date.now(), bb.log); }],
    });

    const invoiceWf = builtinWorkflow("invoice-send")!;
    const started = engine.start({
      workflow: invoiceWf,
      inputs: { company: "Ромашка", amount: 50000, service: "SEO", recipient: "@ivan" },
      link: { projectId: PROJECT, runId: LP_RUN },
    });

    // Wait until approve human step is waiting
    for (let i = 0; i < 100; i += 1) {
      const snap = engine.snapshot(started.runId);
      if (snap?.steps.some((s) => s.node_id === "approve" && s.state === "waiting")) break;
      if (snap && snap.run.status !== "running" && snap.run.status !== "waiting") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    const snap = engine.snapshot(started.runId)!;
    const approveStep = snap.steps.find((s) => s.node_id === "approve" && s.state === "waiting");
    expect(approveStep, `run=${snap.run.status} reason=${snap.run.reason} steps=${JSON.stringify(snap.steps.map((s) => [s.node_id, s.state, s.error]))}`).toBeDefined();
    expect(await engine.resolve(started.runId, approveStep!.step_key, { answer: "send", answer_kind: "send" })).toBe(true);

    for (let i = 0; i < 100; i += 1) {
      const cur = engine.get(started.runId);
      if (cur && cur.status !== "running" && cur.status !== "waiting") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    await engine.idle();
    await new Promise((r) => setTimeout(r, 25));

    const finalRun = engine.get(started.runId)!;
    expect(finalRun.status).toBe("succeeded");
    expect(getRunVerdict(db, started.runId)).toMatchObject({
      runId: started.runId,
      workflowId: "invoice-send",
      verdict: "accept",
      source: "human_node",
      reason: null,
    });

    // Owner reject overrides derived accept
    const override = recordOwnerRunVerdict(db, { runId: started.runId, verdict: "reject", reason: "wrong_result" }, bb.log);
    expect(override.ok).toBe(true);
    expect(getRunVerdict(db, started.runId)).toMatchObject({
      verdict: "reject",
      source: "owner",
      reason: "wrong_result",
    });

    // Re-running derivation never overrides the owner verdict
    const runRow = engine.journal.getRun(started.runId)!;
    deriveRunVerdict(db, runRow, Date.now() + 1000, bb.log);
    expect(getRunVerdict(db, started.runId)).toMatchObject({
      verdict: "reject",
      source: "owner",
      reason: "wrong_result",
    });
  });

  it("derives reject for abort/reject/rework, leaves unreviewed runs with no row, and supports deploy-style live_success options", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    const deployWf = builtinWorkflow("deploy")!;
    const wfJson = JSON.stringify(deployWf);

    // 1. No human step -> no verdict row
    const noHuman = parseWorkflow({
      id: "plain",
      name: { en: "Plain", ru: "Простой" },
      description: { en: "Plain", ru: "Простой" },
      inputs: [],
      outputs: [{ name: "status", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { status: "ok" } }],
      edges: [{ from: "start", to: "done" }],
    });
    const plainRun = insertWfRun(db, { id: "wf_plain", workflow_id: "plain", definition_json: JSON.stringify(noHuman) });
    deriveRunVerdict(db, db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(plainRun) as RunRow, 1000, bb.log);
    expect(getRunVerdict(db, plainRun)).toBeNull();

    // 2. Deploy human step with "deploy" -> accept
    const deployOkRun = insertWfRun(db, {
      id: "wf_deploy_ok",
      workflow_id: "deploy",
      definition_json: wfJson,
      inputs_json: JSON.stringify({ environment: "prod", target: "site" }),
    });
    db.prepare(
      `INSERT INTO lane_pilot_wf_step (run_id, step_key, origin, node_id, visit, state, output_json, updated_at)
       VALUES (?, 'approve#1', 'start', 'approve', 1, 'succeeded', ?, 1000)`,
    ).run(deployOkRun, JSON.stringify({ answer: "deploy", answer_kind: "deploy" }));
    deriveRunVerdict(db, db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(deployOkRun) as RunRow, 1000, bb.log);
    expect(getRunVerdict(db, deployOkRun)).toMatchObject({ verdict: "accept", source: "human_node" });

    // 3. Human step with rework / abort -> reject
    const reworkRun = insertWfRun(db, {
      id: "wf_rework",
      workflow_id: "deploy",
      definition_json: wfJson,
    });
    db.prepare(
      `INSERT INTO lane_pilot_wf_step (run_id, step_key, origin, node_id, visit, state, output_json, updated_at)
       VALUES (?, 'approve#1', 'start', 'approve', 1, 'succeeded', ?, 1000)`,
    ).run(reworkRun, JSON.stringify({ answer: "needs changes", answer_kind: "rework" }));
    deriveRunVerdict(db, db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(reworkRun) as RunRow, 1000, bb.log);
    expect(getRunVerdict(db, reworkRun)).toMatchObject({ verdict: "reject", source: "human_node" });

    // 4. Human step with timeout -> no row
    const timeoutRun = insertWfRun(db, {
      id: "wf_timeout",
      workflow_id: "deploy",
      definition_json: wfJson,
    });
    db.prepare(
      `INSERT INTO lane_pilot_wf_step (run_id, step_key, origin, node_id, visit, state, output_json, updated_at)
       VALUES (?, 'approve#1', 'start', 'approve', 1, 'succeeded', ?, 1000)`,
    ).run(timeoutRun, JSON.stringify({ answer: "", answer_kind: "timeout" }));
    deriveRunVerdict(db, db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(timeoutRun) as RunRow, 1000, bb.log);
    expect(getRunVerdict(db, timeoutRun)).toBeNull();
  });
});

describe("pm-notice completion verdict hint", () => {
  it("adds the run-verdict CLI line to top-level completion notices without creating any new owner item", async () => {
    const sends: string[] = [];
    const kv = new Map<string, unknown>();
    const bb = {
      sdk: {
        threads: {
          send: async (req: { input: Array<{ text: string }> }) => {
            sends.push(req.input[0]!.text);
          },
        },
      },
      storage: {
        kv: {
          get: async (k: string) => kv.get(k) ?? null,
          set: async (k: string, v: unknown) => { kv.set(k, v); },
        },
      },
    };

    await maybeNotifyWorkflowRun({
      bb,
      log: () => undefined,
      pmThreadId: PM,
      startedBySchedule: false,
      run: {
        id: "wfrun_notice_1",
        workflow_id: "demo",
        idem_key: "wf:r1:demo:1",
        parent_run_id: null,
        status: "succeeded",
        reason: null,
        link_run_id: LP_RUN,
        output_json: JSON.stringify({ report_md: "done" }),
      },
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Принять / вернуть: bb lane-pilot run-verdict wfrun_notice_1 accept|reject");

    // reportEndToOwner includes the same line inside its existing owner item and adds no extra item.
    const host = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => host.harness.lifecycle.dispose();
    const db = openDatabase(host.bb);
    const created = reportEndToOwner(
      db,
      {
        id: "wfrun_notice_2",
        idem_key: null,
        workflow_id: "demo",
        workflow_version: 1,
        workflow_sha256: "a",
        definition_json: "{}",
        project_id: PROJECT,
        link_run_id: null,
        link_task_id: null,
        link_attempt_id: null,
        parent_run_id: null,
        parent_step_key: null,
        depth: 0,
        status: "failed",
        reason: "boom",
        mode: null,
        inputs_json: "{}",
        output_json: null,
        harness_version: "test",
        steps_used: 1,
        tokens_used: 0,
        cost_micro_usd: 0,
        wait_ms: 0,
        owner_id: null,
        lease_until: 0,
        created_at: 1,
        updated_at: 2,
      },
      false,
    );
    expect(created).toBe(true);
    const items = db.prepare("SELECT key, why FROM lane_pilot_owner_item").all() as Array<{ key: string; why: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.why).toContain("Принять / вернуть: bb lane-pilot run-verdict wfrun_notice_2 accept|reject");
  });
});
