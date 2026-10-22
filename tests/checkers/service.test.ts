import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckers, runCheckersCli } from "../../src/rooms/checkers/api";
import type { CommandRun, ModelPort, Subject, VerificationSession } from "../../src/rooms/checkers/checkers";
import { buildFixture, type Fixture } from "../../src/rooms/checkers/fixture";
import { runScore } from "../../src/rooms/checkers/service";
import { openDatabase } from "../../src/rooms/storage/database";

/** A stand-in for the clone: a check fails when the written files hold what a planted defect leaves behind. */
const fakeSession = (): VerificationSession => ({
  async run(subject: Subject): Promise<CommandRun[]> {
    const text = subject.changes.map((change) => change.after ?? "").join("\n");
    const broken = text.includes("-planted") || text.includes("index > size") || text.includes("<= width");
    return subject.contract.verification.map((check) => ({ command: check.command, exitCode: broken && !check.command.endsWith("|| true") ? 1 : 0, stdout: "", stderr: broken ? "boom" : "" }));
  },
  async close() { /* nothing to remove */ },
});

const CRITIC_PASS = JSON.stringify({ status: "pass", summary: "fine", findings: [], evidence: "read the files" });
const criticRework = (file: string) => JSON.stringify({
  status: "rework", summary: "a defect", evidence: "read the files",
  findings: [{ file, line: 3, severity: "high", evidence: "console.warn(new Error(...)) where a throw was", finding: "the error is swallowed", criterion: "errors must surface" }],
});

describe("scoring planted defects", () => {
  let root = "", fixture: Fixture;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "lp-checkers-svc-")); fixture = await buildFixture(root); }, 30_000);
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  const calls: Array<{ kind: string; prompt: string }> = [];
  /** Says «rework» about a file only when the candidate holds a swallowed error; anything else passes. */
  const model = (cost = 100): ModelPort => ({
    async ask(prompt, kind) {
      calls.push({ kind, prompt });
      const swallowed = prompt.includes("console.warn(new Error");
      return { text: swallowed ? criticRework("src/clamp.mjs") : CRITIC_PASS, tokens: cost, costUsd: null };
    },
  });

  it("asks the code critic only about what the code checkers let through (and about the clean candidates), the plan critic about the masked check", async () => {
    calls.length = 0;
    const report = await runScore({ openVerification: async () => fakeSession(), model: model() }, { source: "t", candidates: fixture.candidates });
    const codeCalls = calls.filter((call) => call.kind === "code_critic"), planCalls = calls.filter((call) => call.kind === "plan_critic");
    // 2 clean candidates + the escaped ones: deleted assertion x2, swallowed x1; the hardcoded value is not caught by the fake clone.
    const escaped = report.rows.filter((row) => row.checker === "code_critic" && row.defectClass !== "control").map((row) => row.defectClass).sort();
    expect(escaped).toEqual(["hardcoded_value", "hardcoded_value", "swallowed_error", "test_assertion_deleted", "test_assertion_deleted"]);
    expect(codeCalls.length).toBe(2 + escaped.length);
    expect(planCalls.length).toBe(2 + 2);
    const swallowed = report.rows.find((row) => row.checker === "code_critic" && row.defectClass === "swallowed_error")!;
    expect(swallowed.outcome).toBe("hit");
    expect(report.rows.find((row) => row.checker === "code_critic" && row.defectClass === "test_assertion_deleted")!.outcome).toBe("miss");
    expect(report.scorecard.checkers.code_critic.falseAlarms).toBe(0);
    expect(report.scorecard.escapes.byClass.swallowed_error).toBe(1);
    expect(report.scorecard.critic.escapesJudged).toBe(5);
    expect(report.scorecard.critic.escapesCaught).toBe(1);
    expect(report.scorecard.critic.recommendation).toBe("inconclusive");
    expect(report.spentTokens).toBeGreaterThan(0);
  }, 30_000);

  it("asks about every planted defect when told to", async () => {
    calls.length = 0;
    const report = await runScore({ openVerification: async () => fakeSession(), model: model() }, { source: "t", candidates: [fixture.candidates[0]!], criticOn: "all", checkers: ["verification", "code_critic"] });
    const asked = report.rows.filter((row) => row.checker === "code_critic" && row.defectClass !== "control");
    expect(asked.map((row) => row.defectClass).sort()).toEqual(["broken_import", "hardcoded_value", "off_by_one", "outside_owns", "acceptance_missing", "swallowed_error", "test_assertion_deleted"].sort());
  }, 30_000);

  it("stops asking when the cap is spent and says so", async () => {
    calls.length = 0;
    const report = await runScore({ openVerification: async () => fakeSession(), model: model(500) }, { source: "t", candidates: fixture.candidates, budgetTokens: 1000 });
    expect(report.state).toBe("stopped_budget");
    expect(calls.length).toBe(2);
    expect(report.rows.some((row) => row.outcome === "skipped_budget")).toBe(true);
    expect(report.spentTokens).toBe(1000);
  }, 30_000);

  it("runs the code checkers alone when no model is given, and counts the critic cells as not run", async () => {
    const report = await runScore({ openVerification: async () => fakeSession() }, { source: "t", candidates: fixture.candidates });
    expect(report.rows.every((row) => row.checker !== "code_critic" || row.outcome === "n/a")).toBe(true);
    expect(report.scorecard.regressions).toEqual([]);
  }, 30_000);

  it("does not credit a critic with a catch on a file it flags on the clean candidate too", async () => {
    const always: ModelPort = { async ask() { return { text: criticRework("src/clamp.mjs"), tokens: 10, costUsd: null }; } };
    const report = await runScore({ openVerification: async () => fakeSession(), model: always }, { source: "t", candidates: [fixture.candidates[0]!], checkers: ["code_critic"], classes: ["swallowed_error"] });
    const planted = report.rows.find((row) => row.checker === "code_critic" && row.defectClass === "swallowed_error")!;
    expect(planted.outcome).toBe("off_target");
    expect(report.scorecard.checkers.code_critic.falseAlarms).toBe(1);
    expect(report.scorecard.checkers.code_critic.hit).toBe(0);
  }, 30_000);

  it("counts a critic that cannot be read as an error, not a miss", async () => {
    const broken: ModelPort = { async ask() { return { text: "no json here", tokens: 10, costUsd: null }; } };
    const report = await runScore({ openVerification: async () => fakeSession(), model: broken }, { source: "t", candidates: [fixture.candidates[0]!], checkers: ["code_critic"] });
    const rows = report.rows.filter((row) => row.checker === "code_critic");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.outcome === "error")).toBe(true);
  }, 30_000);

  it("stores the rows and gives the scorecard back from the database", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const api = createCheckers({
      db: db as never, log: () => undefined, model: () => model(),
      load: async () => fixture.candidates.map((input) => ({ input, open: async () => fakeSession() })),
    });
    const report = await api.score({ limit: 2, critic: { providerId: "x", model: "y" } });
    expect(report.runId).toMatch(/^chk_/);
    const stored = api.scorecard(report.runId!)!;
    expect(stored.card.planted).toEqual(report.scorecard.planted);
    expect(stored.card.critic.escapesJudged).toBe(report.scorecard.critic.escapesJudged);
    expect(api.runs()).toHaveLength(1);
    const cli = await runCheckersCli(api, ["scorecard"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("designed catcher");
    expect(cli.stdout).toContain("code critic for risk >= medium");
  }, 30_000);

  it("refuses a flag it does not know and a class it does not know", async () => {
    const api = createCheckers({ db: {} as never, log: () => undefined, model: () => null, load: async () => [] });
    expect((await runCheckersCli(api, ["score", "--bogus"])).stderr).toContain("unknown flag --bogus");
    expect((await runCheckersCli(api, ["score", "--classes", "nope"])).stderr).toContain("unknown defect class nope");
    expect((await runCheckersCli(api, ["score", "--critic", "codex"])).stderr).toContain("provider/model");
    expect((await runCheckersCli(api, ["defects"])).stdout).toContain("test_assertion_deleted");
  });
});
