import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runDraftTest, testCasesOf } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { migrations } from "../../src/rooms/plugin-db";
import { workflowCategory } from "../../src/rooms/workflow/categories";
import { chainStore, runSim } from "./chain-harness";
import { out, pathOf } from "./chain-helpers";

/**
 * Specialist OS workflow chain simulations (`runSim` for the 11 new built-in graphs + `runDraftTest` across all 16 new/upgraded graphs
 * and all `variant_*` cases). Literal `runSim("<id>", ...)` calls satisfy `tests/workflow/chains-status.test.ts`.
 */
const NEW_GRAPH_IDS = [
  "sp-specialist-tick",
  "mkt-project-intake",
  "mkt-tracking-setup",
  "mkt-experiment-cycle",
  "mkt-tg-ads-campaign",
  "mkt-direct-search-campaign",
  "mkt-landing-cro-audit",
  "mkt-pulse-monitor",
  "seo-ai-visibility",
  "lp.specialist-eval",
  "lp.curriculum-ingest",
] as const;

const UPGRADED_SEO_IDS = [
  "seo-monitor",
  "seo-tech-audit",
  "seo-template-scale",
  "seo-release",
  "seo-drop-diagnosis",
] as const;

async function mainSimConfigOf(id: string) {
  const store = await chainStore();
  const wf = store.get(id)!.workflow;
  const raw = (wf.test as { sim?: Record<string, unknown> } | undefined)?.sim ?? {};
  const input = (raw.input ?? {}) as Record<string, unknown>;
  const stubs = (raw.stubs ?? {}) as Record<string, Record<string, unknown>>;
  const humanRaw = (raw.human_answers ?? {}) as Record<string, unknown>;
  const humans: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, ans] of Object.entries(humanRaw)) {
    humans[nodeId] = typeof ans === "string" ? { answer_kind: ans, answer: ans } : (ans as Record<string, unknown>);
  }
  const expectPath = ((raw.expect_path ?? []) as string[]).join(" ");
  const expectOutput = (raw.expect_output ?? {}) as Record<string, unknown>;
  return { input, stubs, humans, expectPath, expectOutput };
}

describe("Specialist OS built-in chains (runSim)", () => {
  it("runs all 11 new Specialist OS chains on their primary paths and verifies outputs", async () => {
    const cTick = await mainSimConfigOf("sp-specialist-tick");
    const rTick = await runSim("sp-specialist-tick", cTick);
    expect(pathOf(rTick)).toBe(cTick.expectPath);
    expect(out(rTick)).toMatchObject(cTick.expectOutput);

    const cIntake = await mainSimConfigOf("mkt-project-intake");
    const rIntake = await runSim("mkt-project-intake", cIntake);
    expect(pathOf(rIntake)).toBe(cIntake.expectPath);
    expect(out(rIntake)).toMatchObject(cIntake.expectOutput);

    const cTrack = await mainSimConfigOf("mkt-tracking-setup");
    const rTrack = await runSim("mkt-tracking-setup", cTrack);
    expect(pathOf(rTrack)).toBe(cTrack.expectPath);
    expect(out(rTrack)).toMatchObject(cTrack.expectOutput);

    const cExp = await mainSimConfigOf("mkt-experiment-cycle");
    const rExp = await runSim("mkt-experiment-cycle", cExp);
    expect(pathOf(rExp)).toBe(cExp.expectPath);
    expect(out(rExp)).toMatchObject(cExp.expectOutput);

    const cTg = await mainSimConfigOf("mkt-tg-ads-campaign");
    const rTg = await runSim("mkt-tg-ads-campaign", cTg);
    expect(pathOf(rTg)).toBe(cTg.expectPath);
    expect(out(rTg)).toMatchObject(cTg.expectOutput);

    const cDir = await mainSimConfigOf("mkt-direct-search-campaign");
    const rDir = await runSim("mkt-direct-search-campaign", cDir);
    expect(pathOf(rDir)).toBe(cDir.expectPath);
    expect(out(rDir)).toMatchObject(cDir.expectOutput);

    const cCro = await mainSimConfigOf("mkt-landing-cro-audit");
    const rCro = await runSim("mkt-landing-cro-audit", cCro);
    expect(pathOf(rCro)).toBe(cCro.expectPath);
    expect(out(rCro)).toMatchObject(cCro.expectOutput);

    const cPulse = await mainSimConfigOf("mkt-pulse-monitor");
    const rPulse = await runSim("mkt-pulse-monitor", cPulse);
    expect(pathOf(rPulse)).toBe(cPulse.expectPath);
    expect(out(rPulse)).toMatchObject(cPulse.expectOutput);

    const cAiVis = await mainSimConfigOf("seo-ai-visibility");
    const rAiVis = await runSim("seo-ai-visibility", cAiVis);
    expect(pathOf(rAiVis)).toBe(cAiVis.expectPath);
    expect(out(rAiVis)).toMatchObject(cAiVis.expectOutput);

    const cEval = await mainSimConfigOf("lp.specialist-eval");
    const rEval = await runSim("lp.specialist-eval", cEval);
    expect(pathOf(rEval)).toBe(cEval.expectPath);
    expect(out(rEval)).toMatchObject(cEval.expectOutput);

    const cIngest = await mainSimConfigOf("lp.curriculum-ingest");
    const rIngest = await runSim("lp.curriculum-ingest", cIngest);
    expect(pathOf(rIngest)).toBe(cIngest.expectPath);
    expect(out(rIngest)).toMatchObject(cIngest.expectOutput);
  }, 30_000);

  it("places every Specialist OS workflow on its exact category shelf (marketing, seo, service)", async () => {
    const store = await chainStore();
    for (const id of [
      "mkt-project-intake",
      "mkt-tracking-setup",
      "mkt-experiment-cycle",
      "mkt-tg-ads-campaign",
      "mkt-direct-search-campaign",
      "mkt-landing-cro-audit",
      "mkt-pulse-monitor",
    ]) {
      expect(workflowCategory(store.get(id)!.workflow), id).toBe("marketing");
    }
    for (const id of ["seo-ai-visibility", ...UPGRADED_SEO_IDS]) {
      expect(workflowCategory(store.get(id)!.workflow), id).toBe("seo");
    }
    for (const id of ["sp-specialist-tick", "lp.specialist-eval", "lp.curriculum-ingest"]) {
      expect(workflowCategory(store.get(id)!.workflow), id).toBe("service");
    }
  });

  it("passes every main case and variant_* across all 16 Specialist OS graphs through runDraftTest", async () => {
    const store = await chainStore();
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations);

    const failures: string[] = [];
    let caseCount = 0;
    for (const id of [...NEW_GRAPH_IDS, ...UPGRADED_SEO_IDS]) {
      const wf = store.get(id)!.workflow;
      const cases = testCasesOf(wf);
      expect(cases.length, `${id} should have >= 1 test case`).toBeGreaterThanOrEqual(1);
      for (const tc of cases) {
        caseCount += 1;
        const res = await runDraftTest({ db, harnessVersion: "test", resolveWorkflow: store.resolve, timeoutMs: 8000 }, wf, tc);
        if (!res.green) {
          failures.push(`${id}/${res.caseId}: ${res.failures.join(" | ")}`);
        }
      }
    }
    expect(caseCount).toBeGreaterThanOrEqual(45);
    expect(failures).toEqual([]);
  }, 45_000);
});
