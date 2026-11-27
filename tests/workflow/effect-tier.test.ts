import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { replayPolicy, tierAllows, TIER_RANK, TOOL_TIERS } from "@lane-pilot/contracts";
import {
  applyDraftOps,
  computeEnvironmentFingerprint,
  loadWorkflow,
  lowerWorkflow,
  normalizeWorkflow,
  parseWorkflow,
  parseWorkflowObject,
  REPLAY_CASE_REASONS,
  runDraftTest,
  testCasesOf,
  WORKFLOW_REFERENCE,
} from "@lane-pilot/workflow-engine";
import { migrations } from "../../src/rooms/migrations";
import { classifyToolTier } from "../../src/rooms/specialist";
import { codes, workflow } from "./fixtures";

describe("effect-tier vocabulary in @lane-pilot/contracts", () => {
  it("defines TOOL_TIERS and TIER_RANK ordered R < D < L < S", () => {
    expect(TOOL_TIERS).toEqual(["R", "D", "L", "S"]);
    expect(TIER_RANK.R).toBeLessThan(TIER_RANK.D);
    expect(TIER_RANK.D).toBeLessThan(TIER_RANK.L);
    expect(TIER_RANK.L).toBeLessThan(TIER_RANK.S);
  });

  it("maps each ToolTier to its replayPolicy", () => {
    expect(replayPolicy("R")).toBe("live");
    expect(replayPolicy("D")).toBe("stubbed");
    expect(replayPolicy("L")).toBe("forbidden");
    expect(replayPolicy("S")).toBe("forbidden");
    expect(replayPolicy(undefined)).toBeNull();
  });

  it("checks whether a step tier allows a tool tier via tierAllows", () => {
    expect(tierAllows("D", "R")).toBe(true);
    expect(tierAllows("D", "D")).toBe(true);
    expect(tierAllows("R", "L")).toBe(false);
    expect(tierAllows("L", "S")).toBe(false);
  });

  it("keeps classifyToolTier returning L for an unknown tool under the shipped policy", () => {
    expect(classifyToolTier("unknown-mcp-server", "unknown_tool")).toBe("L");
    expect(classifyToolTier(undefined, undefined)).toBe("L");
  });
});

describe("node effect field, rail rule, and draft gate (Task 4)", () => {
  it("preserves effect on action nodes through normalizeNode and on parallel children through lowerWorkflow (not join/fan)", () => {
    const raw = workflow({
      outputs: [],
      nodes: [
        { id: "act", type: "action", action: "telegram.send_rich", effect: "L", text: "hi" },
        {
          id: "fan",
          type: "parallel",
          effect: "D",
          for_each: ["a", "b"],
          child: { type: "action", action: "fs.write", effect: "D", path: "x" },
          join: { policy: "all", out: [] },
        },
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [
        { from: "start", to: "act" },
        { from: "act", to: "fan" },
        { from: "fan", to: "done" },
      ],
    });

    const normalized = normalizeWorkflow(raw) as { nodes: Array<Record<string, unknown>> };
    const actNode = normalized.nodes.find((n) => n.id === "act");
    expect(actNode?.effect).toBe("L");
    expect((actNode?.params as Record<string, unknown>)?.effect).toBeUndefined();

    const parsed = parseWorkflowObject(normalized);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected workflow to parse");

    const lowered = lowerWorkflow(parsed.data);
    const fanNode = lowered.nodes.find((n) => n.id === "fan:fan") as Record<string, unknown> | undefined;
    const childNode = lowered.nodes.find((n) => n.id === "fan:child") as Record<string, unknown> | undefined;
    const joinNode = lowered.nodes.find((n) => n.id === "fan") as Record<string, unknown> | undefined;
    expect(childNode?.effect).toBe("D");
    expect(fanNode?.effect).toBeUndefined();
    expect(joinNode?.effect).toBeUndefined();
  });

  it("warns effect_irreversible_ungated when effect S script/plan has an ungated path from start", () => {
    const scriptNode = {
      id: "send",
      type: "agent",
      role: "errand",
      effect: "S",
      form: "script",
      script: { cmd: "echo", args: ["ok"], fingerprint: "fp-1" },
      verify: "send.ok == true",
      prompt: "Send",
      out: [{ name: "ok", type: "boolean" }],
    };

    const ungated = loadWorkflow(workflow({
      outputs: [],
      nodes: [scriptNode, { id: "done", type: "action", action: "emit", map: {} }],
      edges: [{ from: "start", to: "send" }, { from: "send", to: "done" }],
    }));
    expect(ungated.ok).toBe(true);
    if (ungated.ok) {
      expect(codes(ungated.warnings, "warning")).toContain("effect_irreversible_ungated");
      expect(ungated.warnings.find((w) => w.code === "effect_irreversible_ungated")).toMatchObject({
        node: "send",
        message: "irreversible step runs without an owner gate on some path",
      });
    }

    const humanGated = loadWorkflow(workflow({
      outputs: [],
      nodes: [
        {
          id: "approve",
          type: "human",
          question: "Approve?",
          options: ["yes", "no"],
          timeoutSec: 60,
          out: [{ name: "answer_kind", type: "enum", values: ["yes", "no", "timeout"] }],
        },
        scriptNode,
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [
        { from: "start", to: "approve" },
        { from: "approve", to: "send" },
        { from: "send", to: "done" },
      ],
    }));
    expect(humanGated.ok).toBe(true);
    if (humanGated.ok) {
      expect(codes(humanGated.warnings, "warning")).not.toContain("effect_irreversible_ungated");
    }

    const authGated = loadWorkflow(workflow({
      outputs: [],
      nodes: [
        { id: "auth", type: "agent", role: "errand", authorized: true, prompt: "Authorize", out: [{ name: "ok", type: "boolean" }] },
        scriptNode,
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [
        { from: "start", to: "auth" },
        { from: "auth", to: "send" },
        { from: "send", to: "done" },
      ],
    }));
    expect(authGated.ok).toBe(true);
    if (authGated.ok) {
      expect(codes(authGated.warnings, "warning")).not.toContain("effect_irreversible_ungated");
    }

    const partialGate = loadWorkflow(workflow({
      outputs: [],
      nodes: [
        { id: "prep", type: "agent", role: "analyst", prompt: "Prep", out: [{ name: "skip", type: "boolean" }] },
        {
          id: "approve",
          type: "human",
          question: "Approve?",
          options: ["yes", "no"],
          timeoutSec: 60,
          out: [{ name: "answer_kind", type: "enum", values: ["yes", "no", "timeout"] }],
        },
        scriptNode,
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [
        { from: "start", to: "prep" },
        { from: "prep", to: "send", when: "prep.skip == true" },
        { from: "prep", to: "approve" },
        { from: "approve", to: "send" },
        { from: "send", to: "done" },
      ],
    }));
    expect(partialGate.ok).toBe(true);
    if (partialGate.ok) {
      expect(codes(partialGate.warnings, "warning")).toContain("effect_irreversible_ungated");
    }

    const planUngated = loadWorkflow(workflow({
      outputs: [],
      nodes: [
        { id: "send", type: "agent", role: "errand", effect: "S", form: "plan", plan: { steps: ["Run"] }, prompt: "Send", out: [{ name: "ok", type: "boolean" }] },
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [{ from: "start", to: "send" }, { from: "send", to: "done" }],
    }));
    expect(planUngated.ok).toBe(true);
    if (planUngated.ok) {
      expect(codes(planUngated.warnings, "warning")).toContain("effect_irreversible_ungated");
    }
  });

  it("refuses lowering or removing effect in applyDraftOps without evolutionGate, allows raising or gated edits", () => {
    const def = workflow({
      nodes: [
        { id: "send", type: "agent", role: "errand", effect: "S", prompt: "Send", out: [{ name: "ok", type: "boolean" }] },
        { id: "read", type: "agent", role: "analyst", effect: "R", prompt: "Read", out: [{ name: "ok", type: "boolean" }] },
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [{ from: "start", to: "send" }, { from: "send", to: "read" }, { from: "read", to: "done" }],
    });

    const loweredRefused = applyDraftOps(def, [{ op: "update_node", id: "send", set: { effect: "R" } }]);
    expect(loweredRefused).toEqual({
      ok: false,
      refused: [{ index: 0, op: "update_node", reason: "effect_lowered", node: "send" }],
    });

    const unsetRefused = applyDraftOps(def, [{ op: "update_node", id: "send", unset: ["effect"] }]);
    expect(unsetRefused).toEqual({
      ok: false,
      refused: [{ index: 0, op: "update_node", reason: "effect_lowered", node: "send" }],
    });

    const gatedLower = applyDraftOps(def, [{ op: "update_node", id: "send", set: { effect: "R" } }], { evolutionGate: true });
    expect(gatedLower.ok).toBe(true);

    const gatedUnset = applyDraftOps(def, [{ op: "update_node", id: "send", unset: ["effect"] }], { evolutionGate: true });
    expect(gatedUnset.ok).toBe(true);

    const raised = applyDraftOps(def, [{ op: "update_node", id: "read", set: { effect: "L" } }]);
    expect(raised.ok).toBe(true);
  });

  it("documents effect and node-level model precedence in WORKFLOW_REFERENCE", () => {
    expect(WORKFLOW_REFERENCE.effect).toContain("R read, D draft, L live change, S irreversible/account-level; replay follows it; never lower it");
    expect(WORKFLOW_REFERENCE.models.advice).toContain("a node's own `provider`/`model` wins over the role row");
  });
});

describe("replay policy in draft tests (Task 7)", () => {
  function testDb() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations);
    return db;
  }

  const wfWithNode = (node: Record<string, unknown>, test?: Record<string, unknown>) =>
    parseWorkflow(
      workflow({
        outputs: [{ name: "result", type: "string", required: false }],
        nodes: [
          node,
          { id: "done", type: "action", action: "emit", map: { result: "step.out" } },
        ],
        edges: [
          { from: "start", to: "step" },
          { from: "step", to: "done" },
        ],
        ...(test ? { test } : {}),
      }),
    );

  it("exposes the replay case reasons", () => {
    expect(REPLAY_CASE_REASONS).toEqual(["replay_forbidden", "replay_needs_stub"]);
  });

  it("fails an L node without sim as replay_forbidden and passes when a sim stub is present", async () => {
    const db = testDb();
    const wfNoSim = wfWithNode({
      id: "step",
      type: "action",
      action: "telegram.send_rich",
      effect: "L",
      out: [{ name: "out", type: "string" }],
    });
    const logs: string[] = [];
    const noSim = await runDraftTest(
      { db, harnessVersion: "t", log: (m) => logs.push(m) },
      wfNoSim,
      testCasesOf(wfNoSim)[0]!,
    );
    expect(noSim).toMatchObject({
      green: false,
      status: "failed",
      reason: "replay_forbidden",
      failedNode: "step",
      nodeId: "step",
    });
    expect(logs).toContain("DEBUG draft test replay node=step policy=forbidden action=refuse");

    const wfWithSim = wfWithNode(
      {
        id: "step",
        type: "action",
        action: "telegram.send_rich",
        effect: "L",
        out: [{ name: "out", type: "string" }],
      },
      { id: "main", sim: { stubs: { step: { out: "sent-ok" } }, expect_output: { result: "sent-ok" } } },
    );
    const simLogs: string[] = [];
    const withSim = await runDraftTest(
      { db, harnessVersion: "t", log: (m) => simLogs.push(m) },
      wfWithSim,
      testCasesOf(wfWithSim)[0]!,
    );
    expect(withSim).toMatchObject({
      green: true,
      status: "succeeded",
      reason: null,
      output: { result: "sent-ok" },
    });
    expect(simLogs).toContain("DEBUG draft test replay node=step policy=forbidden action=stub");
  });

  it("never executes an S script-form node during draft tests", async () => {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), "lp-replay-s-"));
    const fingerprint = computeEnvironmentFingerprint();
    try {
      const marker = join(dir, "ran.txt");
      const wfScript = wfWithNode({
        id: "step",
        type: "agent",
        role: "errand",
        effect: "S",
        form: "script",
        script: { cmd: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], fingerprint },
        verify: "step.ok == true",
        prompt: "Irreversible step",
        out: [{ name: "ok", type: "boolean" }, { name: "out", type: "string" }],
      });
      const res = await runDraftTest({ db, harnessVersion: "t" }, wfScript, testCasesOf(wfScript)[0]!);
      expect(res).toMatchObject({
        green: false,
        status: "failed",
        reason: "replay_forbidden",
        failedNode: "step",
        nodeId: "step",
      });
      expect(existsSync(marker)).toBe(false);

      const wfScriptStubbed = wfWithNode(
        {
          id: "step",
          type: "agent",
          role: "errand",
          effect: "S",
          form: "script",
          script: { cmd: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], fingerprint },
          verify: "step.ok == true",
          prompt: "Irreversible step",
          out: [{ name: "ok", type: "boolean" }, { name: "out", type: "string" }],
        },
        { id: "main", sim: { stubs: { step: { ok: true, out: "recorded" } }, expect_output: { result: "recorded" } } },
      );
      const stubbedRes = await runDraftTest({ db, harnessVersion: "t" }, wfScriptStubbed, testCasesOf(wfScriptStubbed)[0]!);
      expect(stubbedRes).toMatchObject({ green: true, status: "succeeded", output: { result: "recorded" } });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a D node without sim as replay_needs_stub and passes when stubbed", async () => {
    const db = testDb();
    const wfNoSim = wfWithNode({
      id: "step",
      type: "agent",
      role: "writer",
      effect: "D",
      prompt: "Create draft",
      out: [{ name: "out", type: "string" }],
    });
    const logs: string[] = [];
    const noSim = await runDraftTest(
      { db, harnessVersion: "t", log: (m) => logs.push(m) },
      wfNoSim,
      testCasesOf(wfNoSim)[0]!,
    );
    expect(noSim).toMatchObject({
      green: false,
      status: "skipped",
      reason: "replay_needs_stub",
      failedNode: "step",
      nodeId: "step",
    });
    expect(logs).toContain("DEBUG draft test replay node=step policy=stubbed action=refuse");

    const wfWithSim = wfWithNode(
      {
        id: "step",
        type: "agent",
        role: "writer",
        effect: "D",
        prompt: "Create draft",
        out: [{ name: "out", type: "string" }],
      },
      { id: "main", sim: { stubs: { step: { out: "draft-1" } }, expect_output: { result: "draft-1" } } },
    );
    const withSim = await runDraftTest({ db, harnessVersion: "t" }, wfWithSim, testCasesOf(wfWithSim)[0]!);
    expect(withSim).toMatchObject({ green: true, status: "succeeded", output: { result: "draft-1" } });
  });

  it("runs R nodes and nodes without effect as today", async () => {
    const db = testDb();
    const logs: string[] = [];
    const wfRead = wfWithNode({
      id: "step",
      type: "agent",
      role: "analyst",
      effect: "R",
      prompt: "Read",
      out: [{ name: "out", type: "string" }],
    });
    const resRead = await runDraftTest(
      { db, harnessVersion: "t", log: (m) => logs.push(m) },
      wfRead,
      testCasesOf(wfRead)[0]!,
    );
    expect(resRead).toMatchObject({ green: true, status: "succeeded" });
    expect(logs).toContain("DEBUG draft test replay node=step policy=live action=run");

    const wfPlain = wfWithNode({
      id: "step",
      type: "action",
      action: "search",
      out: [{ name: "out", type: "string" }],
    });
    const resPlain = await runDraftTest({ db, harnessVersion: "t" }, wfPlain, testCasesOf(wfPlain)[0]!);
    expect(resPlain).toMatchObject({ green: true, status: "succeeded" });
  });
});
