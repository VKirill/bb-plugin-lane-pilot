import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import type { TaskV2 } from "../../src/rooms/contracts";
import type { Subject } from "../../src/rooms/checkers/checkers";
import {
  auditCandidateDiffHidden,
  buildDiffHiddenSubject,
  diffHiddenMorningLine,
  getDiffHiddenSummary,
  runDiffHiddenAudit,
  saveDiffHiddenRows,
  type DiffHiddenRow,
} from "../../src/rooms/checkers/diff-hidden";
import { createCheckers, runCheckersCli } from "../../src/rooms/checkers/api";

const SAMPLE_TASK: TaskV2 = {
  schema_version: 2,
  id: "task-sample",
  title: "Add clamp logic",
  objective: "add clamp logic",
  project_cwd: "/repo",
  risk: "low",
  lane: "backend",
  read_first: ["README.md"],
  owns_paths: ["src/clamp.mjs"],
  never_touch: [],
  expected_outputs: ["src/clamp.mjs"],
  interfaces: [],
  invariants: [],
  out_of_scope: [],
  depends_on: [],
  acceptance: ["export function clampIndex exists in src/clamp.mjs"],
  verify: "tests",
  verification: [{ command: "node --test", cwd: "." }],
};

function createSampleSubject(): Subject {
  return {
    contract: SAMPLE_TASK,
    changes: [
      {
        path: "src/clamp.mjs",
        before: "// empty\n",
        after: "export function clampIndex(i, s) { return Math.max(0, Math.min(s - 1, i)); }\n",
      },
    ],
    claim: {
      rows: [
        { item: 1, evidence: ["src/clamp.mjs:1"] },
      ],
    },
  };
}

describe("diff-hidden audit", () => {
  it("buildDiffHiddenSubject hides diff changes (sets after to before)", () => {
    const subject = createSampleSubject();
    const hidden = buildDiffHiddenSubject(subject);
    expect(hidden.changes.length).toBe(1);
    expect(hidden.changes[0]!.after).toBe(hidden.changes[0]!.before);
  });

  it("auditCandidateDiffHidden correctly identifies diff sensitivity and catches blind passes", async () => {
    const subject = createSampleSubject();
    const audit = await auditCandidateDiffHidden(subject, {
      checkers: ["plan_fact", "ownership", "contract_lint"],
    });

    expect(audit.taskId).toBe("task-sample");
    expect(audit.checks.length).toBe(3);

    const planFact = audit.checks.find((c) => c.checker === "plan_fact")!;
    expect(planFact).toBeDefined();
    // With diff, planFact passes (0 blocking items). With diff hidden, planFact flags item:1 as missing!
    expect(planFact.withDiffFindings.length).toBe(0);
    expect(planFact.diffHiddenFindings.length).toBeGreaterThan(0);
    expect(planFact.diffSensitive).toBe(true);
    expect(planFact.blindPass).toBe(false);
    expect(planFact.phantom).toBe(false);

    const ownership = audit.checks.find((c) => c.checker === "ownership")!;
    expect(ownership).toBeDefined();
    expect(ownership.phantom).toBe(false);

    const lint = audit.checks.find((c) => c.checker === "contract_lint")!;
    expect(lint).toBeDefined();
    expect(lint.diffSensitive).toBe(true);
  });

  it("auditCandidateDiffHidden detects phantom findings when mock model repeats findings without diff", async () => {
    const subject = createSampleSubject();
    const mockModel = {
      ask: async () => ({
        text: JSON.stringify({
          status: "rework",
          summary: "test summary for critique",
          evidence: "reviewed code lines in file",
          findings: [
            { file: "src/clamp.mjs", line: 1, severity: "high", finding: "unhandled edge case", evidence: "return Math.max(0, Math.min(s - 1, i));" },
          ],
        }),
        tokens: 100,
        costUsd: 0.001,
      }),
    };

    const audit = await auditCandidateDiffHidden(subject, {
      checkers: ["code_critic"],
      model: mockModel,
    });

    const criticCheck = audit.checks.find((c) => c.checker === "code_critic")!;
    expect(criticCheck).toBeDefined();
    // Same findings with and without diff -> phantom hallucination!
    expect(criticCheck.phantom).toBe(true);
  });

  it("runDiffHiddenAudit aggregates multiple candidates and writes rows to DB", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);

    const sub1 = createSampleSubject();
    const sub2 = {
      ...createSampleSubject(),
      contract: { ...SAMPLE_TASK, id: "task-2", acceptance: ["export function padLeft exists"] },
    };

    const report = await runDiffHiddenAudit([sub1, sub2], {
      checkers: ["plan_fact", "ownership"],
      db,
    });

    expect(report.candidatesCount).toBe(2);
    expect(report.totalChecks).toBe(4);
    expect(report.blindPassCount).toBe(0);
    expect(report.diffSensitiveCount).toBeGreaterThanOrEqual(2);
    expect(report.sensitivityRate).toBeGreaterThan(0);

    // Verify DB persistence
    const saved = db.prepare("SELECT COUNT(*) as n FROM lane_pilot_diff_hidden_audit WHERE run_id = ?").get(report.runId) as { n: number };
    expect(saved.n).toBe(4);

    const summary = getDiffHiddenSummary(db, report.recordedAt - 1000, report.recordedAt + 1000);
    expect(summary).not.toBeNull();
    expect(summary!.totalCandidates).toBe(2);
    expect(summary!.totalChecks).toBe(4);

    const morningLine = diffHiddenMorningLine(db, report.recordedAt);
    expect(morningLine).toContain("Аудит проверок (скрытый дифф): проверено 4 проверок на 2 задачах");
    expect(morningLine).toContain("слепых пропусков 0");
  });

  it("diffHiddenMorningLine returns null when no audit has run in the window", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(diffHiddenMorningLine(db)).toBeNull();
  });

  it("runCheckersCli supports diff-hidden command", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const sub = createSampleSubject();
    const api = createCheckers({
      db,
      load: async () => [{
        input: { taskId: sub.contract.id, contract: sub.contract, changes: sub.changes, source: "fixture" },
        open: async () => ({ run: async () => [], close: async () => {} }),
      }],
      model: () => null,
      log: () => {},
    });

    const res = await runCheckersCli(api, ["diff-hidden", "--json"]);
    expect(res.exitCode).toBe(0);
    const json = JSON.parse(res.stdout!);
    expect(json.candidatesCount).toBe(1);
    expect(json.totalChecks).toBeGreaterThan(0);

    const textRes = await runCheckersCli(api, ["diff-hidden"]);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.stdout).toContain("DIFF-HIDDEN AUDIT");
  });

  it("night loop connects diffHiddenAudit with default limit 3 or configured setting", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const { createWall } = await import("../../src/rooms/wall/service");

    const auditCalls: number[] = [];
    const ports = {
      now: () => Date.now(),
      version: "0.1.392",
      loadScope: async () => ({ isReal: () => true, scopeOf: () => ({ isReal: () => true }) }),
      logLines: () => [],
      codeFiles: async () => [],
      tellPm: async () => true,
      repair: {
        view: async () => null,
        report: async () => "",
        tokens: async () => null,
        busy: async () => false,
        changedFiles: async () => null,
        revert: async () => ({ ok: true, detail: "" }),
      },
      release: {
        drill: async () => null,
        canary: async () => null,
      },
      bench: {
        available: async () => false,
        armSet: async () => null,
        ensureArm: async () => "ready",
        compare: async () => ({ delta: 0, pValue: 1 }),
        score: async () => null,
      },
    };

    const wall = createWall({
      db: db as never,
      kv: { get: async () => null, set: async () => {} } as never,
      ports: ports as never,
      log: () => {},
      diffHiddenAudit: async (limit: number) => {
        auditCalls.push(limit);
        return null;
      },
    });

    // 1. By default, with no setting, diffHiddenAudit is called with 3
    await wall.runNight();
    expect(auditCalls).toEqual([3]);

    // 2. When configured to 5, called with 5
    auditCalls.length = 0;
    db.prepare("INSERT OR REPLACE INTO lane_pilot_project_settings (project_id, key, value, updated_at) VALUES ('*', 'checkers.diff_hidden_limit', '5', ?)").run(Date.now());
    await wall.runNight();
    expect(auditCalls).toEqual([5]);

    // 3. When configured to 0, audit is turned off (not called)
    auditCalls.length = 0;
    db.prepare("INSERT OR REPLACE INTO lane_pilot_project_settings (project_id, key, value, updated_at) VALUES ('*', 'checkers.diff_hidden_limit', '0', ?)").run(Date.now());
    await wall.runNight();
    expect(auditCalls).toEqual([]);
  });
});
