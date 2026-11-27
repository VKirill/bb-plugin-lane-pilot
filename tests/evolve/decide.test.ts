import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import {
  createDraftStore,
  definitionSha256,
  globalWorkflowDir,
  parseWorkflow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import {
  addCase,
  caseCounts,
  decideHypothesis,
  evolveOwnerItemKey,
  getHypothesis,
  getTrial,
  listNegatives,
  onCanaryRun,
  onPostPromotionVerdict,
  openTrialFor,
  proposeHypotheses,
  queueHypothesis,
  setHypothesisState,
  splitForRunId,
} from "../../src/rooms/evolve/server";
import { collectOwnerWaiting, listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import type { Services } from "../../src/rooms/services";
import { createStatusResolver } from "../../src/rooms/storage";
import { registerCli } from "../../src/rooms/tools/server";
import {
  builtinWorkflow,
  publishEvolutionWorkflowDraft,
  recordOwnerRunVerdict,
  rollbackEvolutionWorkflowDraft,
  setRunVerdict,
} from "../../src/rooms/workflow/server";
import type { ServerCore } from "../../src/rooms/contracts/server";

const tempDirs: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

let disposePlugin: (() => Promise<void> | void) | null = null;

afterEach(async () => {
  await disposePlugin?.();
  disposePlugin = null;
  vi.unstubAllEnvs();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeRunIds(prefix: string, heldOutNeed: number, workingNeed: number): { heldOut: string[]; working: string[] } {
  const heldOut: string[] = [];
  const working: string[] = [];
  for (let i = 0; heldOut.length < heldOutNeed || working.length < workingNeed; i += 1) {
    const id = `${prefix}-${i}`;
    const split = splitForRunId(id);
    if (split === "held_out" && heldOut.length < heldOutNeed) heldOut.push(id);
    if (split === "working" && working.length < workingNeed) working.push(id);
  }
  return { heldOut, working };
}

function seedCases(db: ReturnType<typeof openDatabase>, workflowId: string, heldOutNeed: number, workingNeed: number, prefix = "case") {
  const { heldOut, working } = makeRunIds(prefix, heldOutNeed, workingNeed);
  let idx = 0;
  for (const runId of [...heldOut, ...working]) {
    addCase(db, { workflowId, runId, verdict: "accept", graphVersion: 1, now: 1_000 + idx++ });
  }
  const counts = caseCounts(db, workflowId);
  expect(counts.heldOut).toBeGreaterThanOrEqual(heldOutNeed);
  expect(counts.working).toBeGreaterThanOrEqual(workingNeed);
}

function makeTestWorkflow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "invoice-send",
    version: 1,
    status: "published",
    name: { en: "Invoice Send", ru: "Отправка счёта" },
    description: { en: "Make and send an invoice in Elba", ru: "Счёт в Эльбе" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      {
        id: "create",
        type: "agent",
        role: "errand",
        effect: "L",
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        verify: "create.out != ''",
        prompt: "Make invoice {{input.query}}",
        out: [{ name: "out", type: "string" }],
      },
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { result: "create.out" },
      },
    ],
    edges: [
      { from: "start", to: "create" },
      { from: "create", to: "done" },
    ],
    test: {
      id: "inv-smoke",
      sim: {
        input: { query: "acme" },
        stubs: { create: { out: "ok" } },
        expect_path: ["create", "done"],
        expect_output: { result: "ok" },
      },
    },
    ...extra,
  };
}

function makePatchedDraft(
  db: ReturnType<typeof openDatabase>,
  workflowDef: Record<string, unknown>,
  nodeId: string,
  variant: Record<string, unknown>,
  hypothesisId: string,
) {
  const drafts = createDraftStore(db);
  const wf = parseWorkflow(workflowDef);
  const draft = drafts.create({
    projectId: "__global__",
    threadId: null,
    scope: "global",
    name: wf.name,
    description: wf.description,
    workflowId: wf.id,
    definition: workflowDef,
    metadata: { source: "evolve", hypothesisId },
  });
  const patched = drafts.patch(draft.id, [{ op: "update_node", id: nodeId, set: variant }], { evolutionGate: true, source: "evolve" });
  expect(patched.ok).toBe(true);
  if (!patched.ok) throw new Error("patch failed");
  return patched.draft;
}

function makeScorecard(hypId: string, workflowId: string, nodeId: string, armKind: "model" | "form" | "check") {
  return {
    hypothesisId: hypId,
    workflowId,
    nodeId,
    armKind,
    cases: 10,
    k: 3,
    comparison: {
      armA: "baseline",
      armB: "candidate",
      pairedTasks: 10,
      onlyA: [],
      onlyB: [],
      passed: { a: 9, b: 9 },
      stages: { a: 20, b: 20 },
      cost: { a: 1.0, b: 0.4, pairedTasks: 10, notMeasured: [] },
      seconds: { a: 12, b: 10 },
      flips: [],
      tolerance: { cost: 0.1, time: 0.1, stages: 0, calibratedOn: null },
      checks: [],
      verdict: "pass",
      improvements: [],
      passCi: {
        level: 0.95,
        a: { rate: 0.9, low: 0.6, high: 0.98 },
        b: { rate: 0.9, low: 0.6, high: 0.98 },
        diff: { low: -0.05, high: 0.05 },
      },
      nonInferior: true,
      noRegressionByClass: true,
      gain: "cost",
      passK: { a: 0.85, b: 0.85 },
    },
    passK: { a: 0.85, b: 0.85 },
    judgeOutcomes: [],
    judgeTrusted: true,
    verifierScore: null,
    costs: {
      baselineUsd: 1.0,
      candidateUsd: 0.4,
      baselinePerAcceptedUsd: 0.1,
      candidatePerAcceptedUsd: 0.04,
    },
  };
}

function insertTrialRun(
  db: ReturnType<typeof openDatabase>,
  opts: {
    id: string;
    workflowId: string;
    version?: number;
    trialId: string | null;
    arm: "old" | "new" | null;
    status?: string;
    costMicroUsd?: number;
    createdAt: number;
    updatedAt?: number;
    output?: Record<string, unknown>;
    definition?: Record<string, unknown>;
    stepState?: "succeeded" | "failed";
    stepVerdict?: "pass" | "fail";
  },
) {
  const def = opts.definition ?? makeTestWorkflow();
  const updatedAt = opts.updatedAt ?? opts.createdAt + 5_000;
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, cost_micro_usd, created_at, updated_at, arm, trial_id)
     VALUES (?, ?, ?, 'sha', ?, 'proj-1', ?, '{}', ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.workflowId,
    opts.version ?? 1,
    JSON.stringify(def),
    opts.status ?? "succeeded",
    JSON.stringify(opts.output ?? { result: "ok" }),
    opts.costMicroUsd ?? 0,
    opts.createdAt,
    updatedAt,
    opts.arm,
    opts.trialId,
  );
  if (opts.stepState || opts.stepVerdict || opts.costMicroUsd !== undefined) {
    db.prepare(
      `INSERT INTO lane_pilot_wf_step
        (run_id, step_key, origin, node_id, visit, state, verdict, cost_micro_usd, cost_state, duration_ms, started_at, updated_at)
       VALUES (?, 'create#1', 'origin:create#1', 'create', 1, ?, ?, ?, 'measured', ?, ?, ?)`,
    ).run(
      opts.id,
      opts.stepState ?? "succeeded",
      opts.stepVerdict ?? "pass",
      opts.costMicroUsd ?? 500,
      updatedAt - opts.createdAt,
      opts.createdAt,
      updatedAt,
    );
  }
}

function makeFakeCore(db: ReturnType<typeof openDatabase>, logs: string[]): ServerCore {
  return {
    bb: {
      log: {
        debug: (m: string) => logs.push(`DEBUG ${m}`),
        info: (m: string) => logs.push(`INFO ${m}`),
        warn: (m: string) => logs.push(`WARN ${m}`),
        error: (m: string) => logs.push(`ERROR ${m}`),
      },
      sdk: {
        projects: { get: async () => ({ id: "__global__", name: "Global" }) },
        threads: { get: async () => null },
        environments: { get: async () => null },
      },
    },
    db,
    log: (m: string) => logs.push(m),
    realtime: { notify: () => undefined },
    knownCustomAgentIds: () => null,
    ownedAgents: async () => ({}),
    effectiveProjectSettings: async () => ({ values: {} }),
    secrets: { list: async () => [] },
    host: { call: async () => ({}) },
  } as unknown as ServerCore;
}

describe("Task 33: evolve decide, canary monitor, rollback, demotion, and CLI", () => {
  it("keeps 10/5 cases in report_only with a single owner item per graph even for two hypotheses", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      seedCases(db, "invoice-send", 10, 5, "rep10");
      const wfDef = makeTestWorkflow();
      const logs: string[] = [];

      const q1 = queueHypothesis(db, {
        id: "evh_rep_1",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: 1,
        source: "census",
      });
      const q2 = queueHypothesis(db, {
        id: "evh_rep_2",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "form",
        variant: { form: "plan", fallback: "agent" },
        graphVersion: 1,
        source: "census",
      });
      expect(q1.ok && q2.ok).toBe(true);

      const d1 = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_rep_1");
      const d2 = makePatchedDraft(db, wfDef, "create", { form: "plan", fallback: "agent" }, "evh_rep_2");
      setHypothesisState(db, { id: "evh_rep_1", state: "replaying", draftId: d1.id, scorecard: makeScorecard("evh_rep_1", "invoice-send", "create", "model") });
      setHypothesisState(db, { id: "evh_rep_2", state: "replaying", draftId: d2.id, scorecard: makeScorecard("evh_rep_2", "invoice-send", "create", "form") });

      const r1 = await decideHypothesis({ db, log: (m) => logs.push(m) }, { now: () => 50_000 }, { hypothesisId: "evh_rep_1" });
      const r2 = await decideHypothesis({ db, log: (m) => logs.push(m) }, { now: () => 51_000 }, { hypothesisId: "evh_rep_2" });
      expect(r1).toEqual({ ok: true, mode: "report_only", counts: { heldOut: 10, working: 5 } });
      expect(r2).toEqual({ ok: true, mode: "report_only", counts: { heldOut: 10, working: 5 } });

      expect(getHypothesis(db, "evh_rep_1")?.state).toBe("report_only");
      expect(getHypothesis(db, "evh_rep_2")?.state).toBe("report_only");
      expect(openTrialFor(db, "invoice-send")).toBeNull();

      const items = listOpenOwnerItems(db, { key: evolveOwnerItemKey("invoice-send") });
      expect(items).toHaveLength(1);
      expect(items[0]!.what).toContain("create");
      expect(items[0]!.what).toContain("10/5");
      expect(items[0]!.why).toContain("95% CI");
      expect(items[0]!.why).toContain("cost/accepted");

      const waiting = collectOwnerWaiting(db, 52_000, [], { decisionCap: 0 });
      const item = waiting.items.find((i) => i.key === "evolve:invoice-send");
      expect(item).toBeDefined();
      expect(item!.wake).toBe(false);
      expect(item!.desk).toBe(true);
      expect(item!.actions.map((a) => a.cli)).toEqual([
        "bb lane-pilot evolve approve evh_rep_1",
        "bb lane-pilot evolve reject evh_rep_1",
        "bb lane-pilot evolve approve evh_rep_2",
        "bb lane-pilot evolve reject evh_rep_2",
      ]);
      expect(logs).toContain("INFO evolve decide hyp=evh_rep_1 mode=report_only counts=10/5");
      expect(logs).toContain("INFO evolve decide hyp=evh_rep_2 mode=report_only counts=10/5");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("opens a canary trial with 0.2 share at 22/12 cases", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      seedCases(db, "invoice-send", 22, 12, "can22");
      const wfDef = makeTestWorkflow();
      const logs: string[] = [];

      queueHypothesis(db, {
        id: "evh_can_1",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: 1,
        source: "census",
      });
      const draft = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_can_1");
      setHypothesisState(db, { id: "evh_can_1", state: "replaying", draftId: draft.id, scorecard: makeScorecard("evh_can_1", "invoice-send", "create", "model") });

      const res = await decideHypothesis({ db, log: (m) => logs.push(m) }, { now: () => 80_000 }, { hypothesisId: "evh_can_1" });
      expect(res).toMatchObject({ ok: true, mode: "canary", counts: { heldOut: 22, working: 12 } });
      expect(getHypothesis(db, "evh_can_1")?.state).toBe("canary");

      const trial = openTrialFor(db, "invoice-send");
      expect(trial).toMatchObject({
        hypothesisId: "evh_can_1",
        workflowId: "invoice-send",
        candidateDraftId: draft.id,
        share: EVOLVE_THRESHOLDS.canaryShare,
        state: "open",
      });
      expect(logs).toContain("INFO evolve decide hyp=evh_can_1 mode=canary counts=22/12");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rolls back canary immediately on a reject or red hard check on a new-arm run within the same event", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      seedCases(db, "invoice-send", 22, 12, "rb");
      const wfDef = makeTestWorkflow();
      const logs: string[] = [];

      queueHypothesis(db, {
        id: "evh_rb_1",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: 1,
        source: "census",
      });
      const draft = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_rb_1");
      setHypothesisState(db, { id: "evh_rb_1", state: "replaying", draftId: draft.id });
      const decided = await decideHypothesis({ db, log: (m) => logs.push(m) }, { now: () => 90_000 }, { hypothesisId: "evh_rb_1" });
      if (!decided.ok || decided.mode !== "canary") throw new Error("expected canary");

      // Old arm failure does not trigger immediate rollback.
      insertTrialRun(db, { id: "run_old_1", workflowId: "invoice-send", trialId: decided.trialId, arm: "old", status: "failed", stepState: "failed", stepVerdict: "fail", createdAt: 91_000 });
      const oldRes = await onCanaryRun(
        { db, log: (m) => logs.push(m) },
        { now: () => 92_000 },
        { id: "run_old_1", trial_id: decided.trialId },
      );
      expect(oldRes).toMatchObject({ handled: true, action: "continue" });
      expect(openTrialFor(db, "invoice-send")?.trialId).toBe(decided.trialId);

      // New arm run with a reject verdict rolls back within the same event.
      insertTrialRun(db, { id: "run_new_1", workflowId: "invoice-send", trialId: decided.trialId, arm: "new", status: "succeeded", createdAt: 93_000 });
      setRunVerdict(db, {
        runId: "run_new_1",
        workflowId: "invoice-send",
        graphVersion: 1,
        verdict: "reject",
        source: "owner",
        reason: "wrong_result",
        decidedAt: 94_000,
      });

      const rbRes = await onCanaryRun(
        { db, log: (m) => logs.push(m) },
        {
          now: () => 94_500,
          getRunVerdict: (id) => {
            const row = db.prepare("SELECT verdict, source, reason, decided_at FROM lane_pilot_wf_run_verdict WHERE run_id = ?").get(id) as
              | { verdict: "accept" | "reject"; source: string; reason: string | null; decided_at: number }
              | undefined;
            return row ? { verdict: row.verdict, source: row.source, reason: row.reason, decidedAt: row.decided_at } : null;
          },
        },
        { id: "run_new_1", trial_id: decided.trialId },
      );
      expect(rbRes).toMatchObject({ handled: true, action: "rollback", trialId: decided.trialId });
      expect(openTrialFor(db, "invoice-send")).toBeNull();
      expect(getTrial(db, decided.trialId)?.state).toBe("rolled_back");
      expect(getHypothesis(db, "evh_rb_1")?.state).toBe("retired");
      expect(listNegatives(db, "invoice-send")).toMatchObject([{ nodeId: "create", reason: "canary_reject" }]);
      expect(logs).toContain("WARN evolve rollback wf=invoice-send reason=canary_reject");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("promotes through the publish gate and rolls back on post-promotion owner reject within 14 days", async () => {
    const globalDir = makeTempDir("lp-evolve-pub-");
    vi.stubEnv("HOME", makeTempDir("lp-home-"));
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      seedCases(db, "invoice-send", 22, 12, "prom");
      const wfDef = JSON.parse(JSON.stringify(builtinWorkflow("invoice-send")!)) as Record<string, unknown>;
      const logs: string[] = [];
      const core = makeFakeCore(db, logs);

      queueHypothesis(db, {
        id: "evh_prom_1",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: 1,
        source: "census",
      });
      const draft = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_prom_1");
      setHypothesisState(db, { id: "evh_prom_1", state: "replaying", draftId: draft.id });

      const decided = await decideHypothesis({ db, log: (m) => logs.push(m) }, { now: () => 100_000 }, { hypothesisId: "evh_prom_1" });
      if (!decided.ok || decided.mode !== "canary") throw new Error("expected canary");

      const publishDraft = (input: { draftId: string; ownerGrant?: boolean }) =>
        publishEvolutionWorkflowDraft(
          core,
          { globalDir: () => globalDir },
          { ...input, ensureTests: true },
        );
      const rollbackDraft = (input: { draftId: string }) =>
        rollbackEvolutionWorkflowDraft(core, { globalDir: () => globalDir }, input);

      // Generate non-inferior paired runs (new arm passes cleanly at lower cost) until canary promotes.
      let promRes: Awaited<ReturnType<typeof onCanaryRun>> | null = null;
      for (let i = 0; i < 30; i += 1) {
        const oldOk = i % 2 !== 0;
        const newOk = true;
        insertTrialRun(db, {
          id: `prom_old_${i}`,
          workflowId: "invoice-send",
          trialId: decided.trialId,
          arm: "old",
          status: "succeeded",
          output: { status: oldOk ? "sent" : "send_failed" },
          costMicroUsd: 2_000,
          createdAt: 110_000 + i * 20,
        });
        insertTrialRun(db, {
          id: `prom_new_${i}`,
          workflowId: "invoice-send",
          trialId: decided.trialId,
          arm: "new",
          status: "succeeded",
          output: { status: newOk ? "sent" : "send_failed" },
          costMicroUsd: 500,
          createdAt: 110_000 + i * 20 + 10,
        });
        promRes = await onCanaryRun(
          { db, log: (m) => logs.push(m) },
          { publishDraft, now: () => 200_000 },
          { id: `prom_new_${i}`, trial_id: decided.trialId },
        );
        if (promRes.handled && promRes.action !== "continue") break;
      }
      expect(promRes).toMatchObject({ handled: true, action: "promote", trialId: decided.trialId, version: 2 });
      expect(getTrial(db, decided.trialId)?.state).toBe("promoted");
      expect(getHypothesis(db, "evh_prom_1")).toMatchObject({ state: "promoted", decidedAt: 200_000 });

      const overlayPath = join(globalDir, "invoice-send.json");
      expect(existsSync(overlayPath)).toBe(true);
      const publishedJson = JSON.parse(readFileSync(overlayPath, "utf8")) as Workflow;
      expect(publishedJson.version).toBe(2);
      const createNode = publishedJson.nodes.find((n) => n.id === "create");
      expect(createNode && createNode.type === "agent" ? createNode.model : null).toBe("claude-haiku-5-5");
      expect(createStatusResolver(db).receipt("invoice-send", definitionSha256(publishedJson))?.green).toBe(1);

      // Outside 14 days -> ignored.
      const tooLate = await onPostPromotionVerdict(
        { db, log: (m) => logs.push(m) },
        { rollbackDraft },
        {
          runId: "late_run",
          workflowId: "invoice-send",
          graphVersion: 2,
          verdict: "reject",
          source: "owner",
          decidedAt: 200_000 + 15 * 86_400_000,
        },
      );
      expect(tooLate).toEqual({ rolledBack: false, reason: "outside_window_or_version_mismatch" });
      expect(getHypothesis(db, "evh_prom_1")?.state).toBe("promoted");

      // First owner reject within 14 days on promoted version -> rolls back!
      const rb = await onPostPromotionVerdict(
        { db, log: (m) => logs.push(m) },
        { rollbackDraft },
        {
          runId: "post_prom_bad",
          workflowId: "invoice-send",
          graphVersion: 2,
          verdict: "reject",
          source: "owner",
          decidedAt: 200_000 + 2 * 86_400_000,
        },
      );
      expect(rb).toEqual({ rolledBack: true, hypothesisId: "evh_prom_1" });
      expect(getHypothesis(db, "evh_prom_1")?.state).toBe("retired");
      expect(listNegatives(db, "invoice-send")).toMatchObject([{ nodeId: "create", reason: "post_promotion_reject" }]);
      expect(logs).toContain("WARN evolve rollback wf=invoice-send reason=post_promotion_reject");

      // Overlay reverted back to baseline (or removed when matching factory builtin).
      if (existsSync(overlayPath)) {
        const revertedJson = JSON.parse(readFileSync(overlayPath, "utf8")) as Workflow;
        const revertedCreate = revertedJson.nodes.find((n) => n.id === "create");
        expect(revertedCreate && revertedCreate.type === "agent" ? revertedCreate.model : undefined).toBeUndefined();
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps hypothesis in canary and closes trial retired when publish fails", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      seedCases(db, "invoice-send", 22, 12, "pfail");
      const wfDef = makeTestWorkflow();
      const logs: string[] = [];

      queueHypothesis(db, {
        id: "evh_pfail_1",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: 1,
        source: "census",
      });
      const draft = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_pfail_1");
      setHypothesisState(db, { id: "evh_pfail_1", state: "replaying", draftId: draft.id });

      const decided = await decideHypothesis({ db, log: (m) => logs.push(m) }, { now: () => 300_000 }, { hypothesisId: "evh_pfail_1" });
      if (!decided.ok || decided.mode !== "canary") throw new Error("expected canary");

      let res: Awaited<ReturnType<typeof onCanaryRun>> | null = null;
      for (let i = 0; i < 30; i += 1) {
        const oldOk = i % 2 !== 0;
        const newOk = true;
        insertTrialRun(db, {
          id: `pf_old_${i}`,
          workflowId: "invoice-send",
          trialId: decided.trialId,
          arm: "old",
          output: { status: oldOk ? "sent" : "send_failed" },
          costMicroUsd: 2000,
          createdAt: 310_000 + i * 20,
        });
        insertTrialRun(db, {
          id: `pf_new_${i}`,
          workflowId: "invoice-send",
          trialId: decided.trialId,
          arm: "new",
          output: { status: newOk ? "sent" : "send_failed" },
          costMicroUsd: 500,
          createdAt: 310_000 + i * 20 + 10,
        });
        res = await onCanaryRun(
          { db, log: (m) => logs.push(m) },
          { publishDraft: async () => ({ ok: false, message: "disk write failed" }), now: () => 350_000 },
          { id: `pf_new_${i}`, trial_id: decided.trialId },
        );
        if (res.handled && res.action !== "continue") break;
      }
      expect(res).toMatchObject({ handled: true, action: "promote_failed", error: "disk write failed" });
      expect(getHypothesis(db, "evh_pfail_1")?.state).toBe("canary");
      expect(getTrial(db, decided.trialId)?.state).toBe("retired");
      expect(logs).toContain("ERROR evolve publish failed hyp=evh_pfail_1: disk write failed");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("applies demotion without case thresholds, archives script negative, and posts non-waking desk notice", async () => {
    const globalDir = makeTempDir("lp-evolve-demote-");
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      expect(caseCounts(db, "invoice-send")).toEqual({ heldOut: 0, working: 0 });
      const logs: string[] = [];
      const core = makeFakeCore(db, logs);

      const scriptedDef = makeTestWorkflow({
        nodes: [
          {
            id: "create",
            type: "agent",
            role: "errand",
            effect: "R",
            form: "script",
            fallback: "plan",
            script: { command: "echo ok", fingerprint: "fp-v1" },
            plan: { steps: ["step 1"] },
            verify: "create.out != ''",
            prompt: "Make invoice {{input.query}}",
            out: [{ name: "out", type: "string" }],
          },
          {
            id: "done",
            type: "action",
            action: "emit",
            map: { result: "create.out" },
          },
        ],
      });

      // Seed 10 script runs where 4 took fallback (> 20%) so proposeHypotheses emits a fallback demotion.
      for (let i = 0; i < 10; i += 1) {
        db.prepare(
          `INSERT INTO lane_pilot_wf_run
            (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, created_at, updated_at)
           VALUES (?, 'invoice-send', 1, 'sha', ?, 'proj-1', 'succeeded', '{}', ?, ?)`,
        ).run(`dem_run_${i}`, JSON.stringify(scriptedDef), 400_000 + i, 400_100 + i);
        db.prepare(
          `INSERT INTO lane_pilot_wf_step
            (run_id, step_key, origin, node_id, visit, state, verdict, form_used, fallback_taken, graph_version, cost_micro_usd, cost_state, duration_ms, started_at, updated_at)
           VALUES (?, 'create#1', 'origin:create#1', 'create', 1, 'succeeded', 'pass', ?, ?, 1, 100, 'measured', 100, ?, ?)`,
        ).run(`dem_run_${i}`, i < 4 ? "plan" : "script", i < 4 ? "script->plan" : null, 400_010 + i, 400_090 + i);
      }

      const queued = await proposeHypotheses(
        { db, workflow: parseWorkflow(scriptedDef), log: (m) => logs.push(m) },
        { workflowId: "invoice-send", now: 410_000 },
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]!.source).toBe("fallback");

      const demRes = await decideHypothesis(
        { db, log: (m) => logs.push(m) },
        {
          workflow: scriptedDef,
          publishDraft: (input) => publishEvolutionWorkflowDraft(core, { globalDir: () => globalDir }, { ...input, ensureTests: true }),
          now: () => 420_000,
        },
        { hypothesisId: queued[0]!.id },
      );
      expect(demRes).toMatchObject({ ok: true, mode: "demoted", version: 2 });
      expect(getHypothesis(db, queued[0]!.id)?.state).toBe("promoted");

      const published = JSON.parse(readFileSync(join(globalDir, "invoice-send.json"), "utf8")) as Workflow;
      const createNode = published.nodes.find((n) => n.id === "create");
      expect(createNode && createNode.type === "agent" ? createNode.form : null).toBe("plan");

      const negatives = listNegatives(db, "invoice-send");
      expect(negatives.some((n) => n.reason === "fallback_over_20pct")).toBe(true);

      const deskItems = listOpenOwnerItems(db, { source: "evolve" });
      expect(deskItems).toHaveLength(1);
      expect(deskItems[0]!.kind).toBe("evolve_demotion");
      const waiting = collectOwnerWaiting(db, 421_000);
      expect(waiting.items.find((i) => i.key === deskItems[0]!.key)?.wake).toBe(false);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("handles owner approve and reject via bb lane-pilot evolve CLI and closes the owner item", async () => {
    const globalDir = makeTempDir("lp-evolve-cli-");
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const logs: string[] = [];
      const core = createCore(bb, db);
      const fakeCore = makeFakeCore(db, logs);
      const services = {
        evolvePublishDraft: (input: { draftId: string; ownerGrant?: boolean }) =>
          publishEvolutionWorkflowDraft(fakeCore, { globalDir: () => globalDir }, { ...input, ensureTests: true }),
      } as Services;
      registerCli(core, services, migrations);

      seedCases(db, "invoice-send", 10, 5, "cli");
      const wfDef = JSON.parse(JSON.stringify(builtinWorkflow("invoice-send")!)) as Record<string, unknown>;

      queueHypothesis(db, {
        id: "evh_cli_rej",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: 1,
        source: "census",
      });
      queueHypothesis(db, {
        id: "evh_cli_app",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-sonnet-5-5" },
        graphVersion: 1,
        source: "census",
      });
      const d1 = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_cli_rej");
      const d2 = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-sonnet-5-5" }, "evh_cli_app");
      setHypothesisState(db, { id: "evh_cli_rej", state: "replaying", draftId: d1.id });
      setHypothesisState(db, { id: "evh_cli_app", state: "replaying", draftId: d2.id });

      await decideHypothesis({ db }, { now: () => 500_000 }, { hypothesisId: "evh_cli_rej" });
      await decideHypothesis({ db }, { now: () => 501_000 }, { hypothesisId: "evh_cli_app" });
      expect(listOpenOwnerItems(db, { key: "evolve:invoice-send" })).toHaveLength(1);

      const rejOut = await harness.behavior.runCli(["evolve", "reject", "evh_cli_rej"]);
      expect(rejOut.exitCode).toBe(0);
      expect(getHypothesis(db, "evh_cli_rej")?.state).toBe("rejected");
      expect(listNegatives(db, "invoice-send")).toMatchObject([{ reason: "owner_reject" }]);
      // Still one report_only hypothesis left -> owner item stays open.
      expect(listOpenOwnerItems(db, { key: "evolve:invoice-send" })).toHaveLength(1);

      // Approve below threshold -> promotes directly with owner's grant and closes owner item.
      const appOut = await harness.behavior.runCli(["evolve", "approve", "evh_cli_app", "--json"]);
      expect(appOut.exitCode, appOut.stderr).toBe(0);
      expect(JSON.parse(appOut.stdout ?? "{}")).toMatchObject({ hypothesisId: "evh_cli_app", ok: true, mode: "promoted", version: 2 });
      expect(getHypothesis(db, "evh_cli_app")?.state).toBe("promoted");
      expect(listOpenOwnerItems(db, { key: "evolve:invoice-send" })).toHaveLength(0);
      expect(existsSync(join(globalDir, "invoice-send.json"))).toBe(true);

      // Approve above threshold -> opens canary trial.
      seedCases(db, "invoice-send", 10, 5, "cli-more");
      expect(caseCounts(db, "invoice-send").heldOut).toBeGreaterThanOrEqual(EVOLVE_THRESHOLDS.heldOutMin);
      const baseVerify =
        ((wfDef.nodes as Array<{ id: string; verify?: { expr?: string[] } }>).find((n) => n.id === "create")?.verify?.expr) ?? [];
      const addCheckVariant = { verify: { expr: [...baseVerify, "create.status != 'done' || create.invoice_amount > 0"] } };
      queueHypothesis(db, {
        id: "evh_cli_can",
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "check",
        variant: addCheckVariant,
        graphVersion: 1,
        source: "owner",
      });
      const d3 = makePatchedDraft(db, wfDef, "create", addCheckVariant, "evh_cli_can");
      setHypothesisState(db, { id: "evh_cli_can", state: "report_only", draftId: d3.id });

      const canOut = await harness.behavior.runCli(["evolve", "approve", "evh_cli_can"]);
      expect(canOut.exitCode).toBe(0);
      expect(canOut.stdout).toContain("mode=canary");
      expect(getHypothesis(db, "evh_cli_can")?.state).toBe("canary");
      expect(openTrialFor(db, "invoice-send")?.hypothesisId).toBe("evh_cli_can");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("wires post-promotion rollback through plugin(bb) recordOwnerRunVerdict", async () => {
    const homeDir = makeTempDir("lp-plugin-home-");
    vi.stubEnv("HOME", homeDir);
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    disposePlugin = () => harness.lifecycle.dispose();

    const db = openDatabase(bb);
    const wfDef = JSON.parse(JSON.stringify(builtinWorkflow("invoice-send")!)) as Record<string, unknown>;
    queueHypothesis(db, {
      id: "evh_plug_1",
      workflowId: "invoice-send",
      nodeId: "create",
      armKind: "model",
      variant: { provider: "claude-code", model: "claude-haiku-5-5" },
      graphVersion: 1,
      source: "census",
    });
    const draft = makePatchedDraft(db, wfDef, "create", { provider: "claude-code", model: "claude-haiku-5-5" }, "evh_plug_1");
    setHypothesisState(db, { id: "evh_plug_1", state: "report_only", draftId: draft.id });

    // Approve via real plugin CLI (publishes overlay v2 into HOME/.lane-pilot/workflows).
    const appRes = await harness.behavior.runCli(["evolve", "approve", "evh_plug_1"]);
    expect(appRes.exitCode, appRes.stderr).toBe(0);
    expect(getHypothesis(db, "evh_plug_1")?.state).toBe("promoted");
    const overlayFile = join(globalWorkflowDir(), "invoice-send.json");
    expect(existsSync(overlayFile)).toBe(true);

    // Insert a finished run at v2 and record owner reject via recordOwnerRunVerdict -> triggers post-promotion rollback.
    insertTrialRun(db, {
      id: "wfrun_plug_bad",
      workflowId: "invoice-send",
      version: 2,
      trialId: null,
      arm: null,
      status: "succeeded",
      createdAt: Date.now(),
    });
    const rec = recordOwnerRunVerdict(db, {
      runId: "wfrun_plug_bad",
      verdict: "reject",
      reason: "wrong_result",
      now: Date.now(),
    });
    expect(rec.ok).toBe(true);

    await vi.waitFor(() => {
      expect(getHypothesis(db, "evh_plug_1")?.state).toBe("retired");
    });
    expect(listNegatives(db, "invoice-send")).toMatchObject([{ reason: "post_promotion_reject" }]);
  });
});
