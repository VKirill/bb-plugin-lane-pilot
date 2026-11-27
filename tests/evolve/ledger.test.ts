import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  ARM_KINDS,
  EVOLVE_THRESHOLDS,
  EVOLVE_TRIAL_STATES,
  HYPOTHESIS_SOURCES,
  HYPOTHESIS_STATES,
} from "@lane-pilot/contracts";
import { describe, expect, it } from "vitest";
import { evolveMigrations } from "../../src/rooms/evolve/migrations";
import {
  activeCount,
  addNegative,
  closeTrial,
  getHypothesis,
  listHypotheses,
  listNegatives,
  markIngested,
  openTrial,
  openTrialFor,
  queueHypothesis,
  setHypothesisState,
  variantSignature,
} from "../../src/rooms/evolve/server";
import { openDatabase } from "../../src/rooms/plugin-db";

describe("evolve ledger DDL and contracts", () => {
  it("matches SQL CHECK constraints to contracts vocabularies", () => {
    const hypDdl = evolveMigrations.find((sql) => sql.includes("CREATE TABLE lane_pilot_evolve_hypothesis")) ?? "";
    const armCheck = /arm_kind TEXT NOT NULL CHECK\(arm_kind IN \(([^)]+)\)\)/.exec(hypDdl)?.[1];
    const sourceCheck = /source TEXT NOT NULL CHECK\(source IN \(([^)]+)\)\)/.exec(hypDdl)?.[1];
    const stateCheck = /state TEXT NOT NULL CHECK\(state IN \(([^)]+)\)\)/.exec(hypDdl)?.[1];

    const parseList = (raw: string | undefined) =>
      (raw ?? "").split(",").map((item) => item.trim().replace(/^'|'$/g, ""));

    expect(parseList(armCheck)).toEqual([...ARM_KINDS]);
    expect(parseList(sourceCheck)).toEqual([...HYPOTHESIS_SOURCES]);
    expect(parseList(stateCheck)).toEqual([...HYPOTHESIS_STATES]);

    const trialDdl = evolveMigrations.find((sql) => sql.includes("CREATE TABLE lane_pilot_evolve_trial")) ?? "";
    const trialStateCheck = /state TEXT NOT NULL CHECK\(state IN \(([^)]+)\)\)/.exec(trialDdl)?.[1];
    expect(parseList(trialStateCheck)).toEqual([...EVOLVE_TRIAL_STATES]);
  });
});

describe("evolve ledger repository", () => {
  it("marks runs ingested once and returns false on double ingest", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const debugLogs: string[] = [];
      const sink = { debug: (m: string) => debugLogs.push(m) };

      expect(markIngested(db, "run-1", "invoice-send", 1700000000001, sink)).toBe(true);
      expect(markIngested(db, "run-1", "invoice-send", 1700000000002, sink)).toBe(false);
      expect(markIngested(db, "run-2", "invoice-send", { now: 1700000000003, log: sink })).toBe(true);

      expect(debugLogs).toEqual([
        "evolve ingest run=run-1 new=true",
        "evolve ingest run=run-1 new=false",
        "evolve ingest run=run-2 new=true",
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("computes order-independent SHA-256 variant signatures", () => {
    const sigA = variantSignature("draft", "model", {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      nested: { b: 2, a: 1 },
    });
    const sigB = variantSignature("draft", "model", {
      nested: { a: 1, b: 2 },
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
    const sigOtherNode = variantSignature("review", "model", {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      nested: { a: 1, b: 2 },
    });
    expect(sigA).toMatch(/^[a-f0-9]{64}$/);
    expect(sigA).toBe(sigB);
    expect(sigA).not.toBe(sigOtherNode);
  });

  it("enforces the per-workflow active hypothesis cap (4th refused until one settles)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const infoLogs: string[] = [];
      const warnLogs: string[] = [];
      const sink = {
        info: (m: string) => infoLogs.push(m),
        warn: (m: string) => warnLogs.push(m),
      };

      const ids: string[] = [];
      for (let i = 0; i < EVOLVE_THRESHOLDS.activeCap; i += 1) {
        const res = queueHypothesis(
          db,
          {
            workflowId: "invoice-send",
            nodeId: `node-${i}`,
            armKind: "model",
            variant: { model: `m-${i}` },
            graphVersion: 1,
            source: "census",
            now: 1000 + i,
          },
          sink,
        );
        expect(res.ok).toBe(true);
        if (res.ok) ids.push(res.hypothesis.id);
      }

      expect(activeCount(db, "invoice-send")).toBe(3);

      // 4th active hypothesis is refused with cap
      const fourth = queueHypothesis(
        db,
        {
          workflowId: "invoice-send",
          nodeId: "node-3",
          armKind: "form",
          variant: { form: "plan" },
          graphVersion: 1,
          source: "fallback",
        },
        sink,
      );
      expect(fourth).toEqual({ ok: false, reason: "cap" });
      expect(warnLogs).toContain("evolve hypothesis refused wf=invoice-send: cap");

      // Another workflow keeps its own independent cap
      const otherWf = queueHypothesis(db, {
        workflowId: "telegram-send",
        nodeId: "node-0",
        armKind: "check",
        variant: { verify: "non_empty != ''" },
        graphVersion: 1,
        source: "owner",
      });
      expect(otherWf.ok).toBe(true);

      // Forbidden variant keys (e.g. prompt prose) are refused
      const forbidden = queueHypothesis(db, {
        workflowId: "telegram-send",
        nodeId: "node-0",
        armKind: "model",
        variant: { prompt: "be concise" },
        graphVersion: 1,
        source: "census",
      });
      expect(forbidden).toEqual({ ok: false, reason: "variant_key_forbidden" });

      // Transition one to active state `replaying` — still counts toward cap
      const replaying = setHypothesisState(db, { id: ids[0]!, state: "replaying", draftId: "draft-1" }, sink);
      expect(replaying?.decidedAt).toBeNull();
      expect(activeCount(db, "invoice-send")).toBe(3);

      // Transition one to terminal `rejected` — frees a slot
      const rejected = setHypothesisState(
        db,
        { id: ids[0]!, state: "rejected", scorecard: { passed: false }, reason: "regression", now: 5000 },
        sink,
      );
      expect(rejected?.state).toBe("rejected");
      expect(rejected?.decidedAt).toBe(5000);
      expect(rejected?.scorecardJson).toBe('{"passed":false}');
      expect(activeCount(db, "invoice-send")).toBe(2);

      const fifth = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "node-3",
        armKind: "form",
        variant: { form: "plan" },
        graphVersion: 1,
        source: "lead_road",
      });
      expect(fifth.ok).toBe(true);
      expect(listHypotheses(db, { workflowId: "invoice-send" })).toHaveLength(4);
      expect(infoLogs.some((l) => l === "evolve hypothesis wf=invoice-send node=node-0 arm=model state=queued")).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("refuses negative variants for the same graph_version, allows them on a new version, and forbids updates", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const warnLogs: string[] = [];
      const sink = { warn: (m: string) => warnLogs.push(m) };
      const variant = { provider: "openai", model: "gpt-4o-mini" };

      const neg = addNegative(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant,
        graphVersion: 1,
        reason: "failed non-inferiority",
        now: 2000,
      });
      expect(neg.added).toBe(true);

      // Duplicate insert is ignored cleanly
      expect(
        addNegative(db, {
          workflowId: "invoice-send",
          nodeId: "draft",
          variantSignature: neg.variantSignature,
          graphVersion: 1,
          reason: "duplicate",
          now: 2001,
        }).added,
      ).toBe(false);

      // Append-only trigger blocks UPDATE on lane_pilot_evolve_negative
      expect(() =>
        db.prepare(`UPDATE lane_pilot_evolve_negative SET reason = 'rewritten' WHERE workflow_id = 'invoice-send'`).run(),
      ).toThrow(/append-only/);

      // Same variant on same graph_version is refused (even with reordered keys)
      const refused = queueHypothesis(
        db,
        {
          workflowId: "invoice-send",
          nodeId: "draft",
          armKind: "model",
          variant: { model: "gpt-4o-mini", provider: "openai" },
          graphVersion: 1,
          source: "catalog_change",
        },
        sink,
      );
      expect(refused).toEqual({ ok: false, reason: "negative" });
      expect(warnLogs).toContain("evolve hypothesis refused wf=invoice-send: negative");

      // Same variant on a newer graph_version is allowed
      const allowedNewVersion = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { model: "gpt-4o-mini", provider: "openai" },
        graphVersion: 2,
        source: "catalog_change",
      });
      expect(allowedNewVersion.ok).toBe(true);
      expect(listNegatives(db, "invoice-send")).toHaveLength(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("opens, queries, and closes live canary trials", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      expect(openTrialFor(db, "invoice-send")).toBeNull();

      const opened = openTrial(db, {
        hypothesisId: "evh_1",
        workflowId: "invoice-send",
        baselineVersion: 3,
        candidateDraftId: "draft_abc",
        now: 10000,
      });
      expect(opened.state).toBe("open");
      expect(opened.share).toBe(EVOLVE_THRESHOLDS.canaryShare);
      expect(openTrialFor(db, "invoice-send")).toEqual(opened);

      const closed = closeTrial(db, {
        trialId: opened.trialId,
        state: "promoted",
        reason: "passed sequential test",
        now: 20000,
      });
      expect(closed?.state).toBe("promoted");
      expect(closed?.closedAt).toBe(20000);
      expect(closed?.reason).toBe("passed sequential test");
      expect(openTrialFor(db, "invoice-send")).toBeNull();
      expect(getHypothesis(db, "nonexistent")).toBeNull();
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
