import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  ARM_KINDS,
  CASE_SPLITS,
  EVOLVE_THRESHOLDS,
  HYPOTHESIS_SOURCES,
  HYPOTHESIS_STATES,
} from "@lane-pilot/contracts";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import {
  addCase,
  caseCounts,
  heldOutCaseIds,
  rotateHeldOut,
  workingCases,
} from "../../src/rooms/evolve/server";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import type { Services } from "../../src/rooms/services";
import { registerCli } from "../../src/rooms/tools/server";

describe("evolve contracts and case sets", () => {
  it("exports the evolve contracts and thresholds", () => {
    expect(CASE_SPLITS).toEqual(["working", "held_out"]);
    expect(ARM_KINDS).toEqual(["model", "form", "check"]);
    expect(HYPOTHESIS_SOURCES).toEqual(["census", "fallback", "catalog_change", "lead_road", "owner"]);
    expect(HYPOTHESIS_STATES).toEqual(["queued", "replaying", "report_only", "canary", "promoted", "retired", "rejected"]);
    expect(EVOLVE_THRESHOLDS).toEqual({
      heldOutMin: 20,
      workingMin: 10,
      heldOutShare: 0.3,
      nonInferiority: -0.10,
      repeats: 3,
      fallbackDemote: 0.2,
      checkerCatch: 0.9,
      judgeAgreementLow: 0.7,
      activeCap: 3,
      canaryShare: 0.2,
    });
  });

  it("splits 100 synthetic run ids into 25-35% held-out deterministically and counts verdicts", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const logs: string[] = [];
      const sink = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };

      for (let i = 0; i < 100; i += 1) {
        const res = addCase(
          db,
          {
            workflowId: "invoice-send",
            runId: `synth-${i}`,
            verdict: i % 4 === 0 ? "reject" : "accept",
            taskClass: i % 2 === 0 ? "standard" : "rush",
            graphVersion: 1,
            now: 1700000000000 + i,
          },
          sink,
        );
        expect(res.added).toBe(true);
      }

      const counts = caseCounts(db, "invoice-send");
      expect(counts.heldOut + counts.working).toBe(100);
      expect(counts.heldOut).toBeGreaterThanOrEqual(25);
      expect(counts.heldOut).toBeLessThanOrEqual(35);
      expect(workingCases(db, "invoice-send")).toHaveLength(counts.working);
      expect(heldOutCaseIds(db, "invoice-send")).toHaveLength(counts.heldOut);
      expect(logs).toHaveLength(100);
      expect(logs[0]).toMatch(/^evolve case added wf=invoice-send run=synth-0 split=(working|held_out)$/);

      // Re-inserting the same runId is idempotent.
      const dup = addCase(db, {
        workflowId: "invoice-send",
        runId: "synth-0",
        verdict: "accept",
        graphVersion: 1,
      });
      expect(dup).toEqual({ added: false, reason: "duplicate" });
      expect(caseCounts(db, "invoice-send")).toEqual(counts);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not add a run without a valid verdict", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      expect(addCase(db, { workflowId: "invoice-send", runId: "r-null", verdict: null, graphVersion: 1 })).toEqual({
        added: false,
        reason: "no_verdict",
      });
      expect(addCase(db, { workflowId: "invoice-send", runId: "r-undef", verdict: undefined, graphVersion: 1 })).toEqual({
        added: false,
        reason: "no_verdict",
      });
      expect(addCase(db, { workflowId: "invoice-send", runId: "r-bad", verdict: "maybe", graphVersion: 1 })).toEqual({
        added: false,
        reason: "no_verdict",
      });
      expect(caseCounts(db, "invoice-send")).toEqual({ heldOut: 0, working: 0 });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("freezes held-out cases against UPDATE/DELETE and allows owner rotation", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const logs: string[] = [];
      const sink = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };

      for (let i = 0; i < 30; i += 1) {
        addCase(db, {
          workflowId: "invoice-send",
          runId: `run-freeze-${i}`,
          verdict: "accept",
          graphVersion: 1,
          now: 1700000000000 + i,
        });
      }

      const heldIds = heldOutCaseIds(db, "invoice-send");
      expect(heldIds.length).toBeGreaterThanOrEqual(2);
      const targetId = heldIds[0]!;
      const keepId = heldIds[1]!;

      expect(() =>
        db.prepare(`UPDATE lane_pilot_evolve_case SET split = 'working' WHERE case_id = ?`).run(targetId),
      ).toThrow(/held_out case is frozen/);

      expect(() =>
        db.prepare(`DELETE FROM lane_pilot_evolve_case WHERE case_id = ?`).run(targetId),
      ).toThrow(/held_out case is frozen/);

      const refused = rotateHeldOut(db, { workflowId: "invoice-send", caseIds: [targetId], by: "agent" }, sink);
      expect(refused).toEqual({ ok: false, rotated: 0, reason: "owner_only" });
      expect(logs.some((line) => line.startsWith("evolve rotate refused wf=invoice-send:"))).toBe(true);

      const rotated = rotateHeldOut(
        db,
        { workflowId: "invoice-send", caseIds: [targetId], by: "owner", now: 1700000099999 },
        sink,
      );
      expect(rotated).toEqual({ ok: true, rotated: 1 });

      const afterHeld = heldOutCaseIds(db, "invoice-send");
      expect(afterHeld).not.toContain(targetId);
      expect(afterHeld).toContain(keepId);

      const rotatedRow = workingCases(db, "invoice-send").find((row) => row.caseId === targetId);
      expect(rotatedRow?.split).toBe("working");
      expect(rotatedRow?.rotatedAt).toBe(1700000099999);

      // Flag must be reset after rotation so remaining held-out rows stay frozen.
      expect(() =>
        db.prepare(`UPDATE lane_pilot_evolve_case SET verdict = 'reject' WHERE case_id = ?`).run(keepId),
      ).toThrow(/held_out case is frozen/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("supports bb lane-pilot evolve cases and rotate CLI verbs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      registerCli(createCore(bb, db), {} as Services, migrations);
      for (let i = 0; i < 20; i += 1) {
        addCase(db, {
          workflowId: "invoice-send",
          runId: `run-cli-${i}`,
          verdict: "accept",
          graphVersion: 1,
        });
      }

      const beforeCounts = caseCounts(db, "invoice-send");
      const casesRes = await harness.behavior.runCli(["evolve", "cases", "invoice-send", "--json"]);
      expect(casesRes.exitCode).toBe(0);
      expect(JSON.parse(casesRes.stdout ?? "{}")).toEqual({
        workflowId: "invoice-send",
        heldOut: beforeCounts.heldOut,
        working: beforeCounts.working,
      });

      const heldIds = heldOutCaseIds(db, "invoice-send");
      expect(heldIds.length).toBeGreaterThan(0);
      const rotateRes = await harness.behavior.runCli(["evolve", "rotate", "invoice-send", heldIds[0]!]);
      expect(rotateRes.exitCode).toBe(0);
      expect(caseCounts(db, "invoice-send")).toEqual({
        heldOut: beforeCounts.heldOut - 1,
        working: beforeCounts.working + 1,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("never exposes heldOut in the hypothesis generator module", () => {
    const hypothesesPath = join(process.cwd(), "src/rooms/evolve/server/services/hypotheses.ts");
    if (!existsSync(hypothesesPath)) return;
    const text = readFileSync(hypothesesPath, "utf8");
    expect(text).not.toMatch(/heldOut/);
  });
});
