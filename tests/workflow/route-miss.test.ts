import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  GOAL_REQUEST_MAX,
  MIN_CONFIDENCE,
  WorkflowEngine,
  classifyRouteMiss,
  loadWorkflowStore,
  type RouteDecision,
} from "@lane-pilot/workflow-engine";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { createErrandCore } from "../../src/rooms/errands/server/services/errand-core";
import { createErrandGraphService } from "../../src/rooms/errands/server/services/errand-graph";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { routeTool, type WorkflowToolDeps } from "../../src/rooms/workflow/server/handlers/workflow-tools";
import { listRouteMisses, recordRouteMiss } from "../../src/rooms/workflow/server";

const PROJECT = "proj-miss";
const PM = "pm-miss";
const RUN = "lprun-miss";
const DAY_MS = 86_400_000;

function baseDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    decision: "clarify",
    workflowId: null,
    suggested: null,
    confidence: 0,
    evidence: { pattern: "test", rejected: [], rules: [], model: "deterministic" },
    candidates: [],
    liveTrial: false,
    questions: [],
    boundary_contract: null,
    goals: [],
    inputs: {},
    missingInputs: [],
    guessedInputs: [],
    warnings: [],
    stateContinue: false,
    ...overrides,
  };
}

function candidate(id: string, score: number, extra: Partial<RouteDecision["candidates"][number]> = {}): RouteDecision["candidates"][number] {
  return {
    id,
    name: id,
    purpose: `purpose of ${id}`,
    needs: [],
    score,
    base: score,
    boost: 0,
    penalty: 0,
    rules: [],
    ...extra,
  };
}

function setupDb() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "cli");
  setRunThread(db, RUN, PM);
  return { bb, harness, db };
}

describe("classifyRouteMiss", () => {
  it("classifies each miss kind from a crafted decision", () => {
    const intent = "Migrate billing webhooks from Stripe to CloudPayments";

    expect(classifyRouteMiss(baseDecision({ candidates: [] }), { intent })).toBe("no_candidate");

    expect(classifyRouteMiss(
      baseDecision({
        candidates: [candidate("deploy", 0.5)],
        warnings: ["the closest match deploy is not available: secret DEPLOY_KEY is not set"],
      }),
      { intent },
    )).toBe("blocked");

    expect(classifyRouteMiss(
      baseDecision({ candidates: [candidate("deploy", 0.5)] }),
      { intent, policyForbidden: true },
    )).toBe("blocked");

    expect(classifyRouteMiss(
      baseDecision({ candidates: [candidate("debug", 0.08)], suggested: "debug", confidence: 20 }),
      { intent },
    )).toBe("weak_match");

    const longBrief = Array.from({ length: 85 }, (_, i) => `word${i}`).join(" ");
    expect(classifyRouteMiss(
      baseDecision({
        candidates: [candidate("debug", 0.4, { base: 0.05, rules: [] })],
        suggested: "debug",
        confidence: 45,
      }),
      { intent: longBrief },
    )).toBe("weak_match");

    expect(classifyRouteMiss(
      baseDecision({
        candidates: [candidate("seo-page", 0.35, { base: 0.35 })],
        suggested: "seo-page",
        confidence: MIN_CONFIDENCE - 10,
      }),
      { intent },
    )).toBe("near_miss");
  });

  it("returns null for non-misses: route, stateContinue, empty/overlong, broad one-stem prompt, read/write conflict", () => {
    expect(classifyRouteMiss(baseDecision({ decision: "route", workflowId: "debug", confidence: 90 }), { intent: "Why does export crash?" })).toBeNull();
    expect(classifyRouteMiss(baseDecision({ stateContinue: true }), { intent: "давай продолжим" })).toBeNull();
    expect(classifyRouteMiss(baseDecision(), { intent: "   " })).toBeNull();
    expect(classifyRouteMiss(baseDecision(), { intent: "Add feature", request: "   " })).toBeNull();
    expect(classifyRouteMiss(baseDecision(), { intent: "x".repeat(GOAL_REQUEST_MAX + 1) })).toBeNull();
    expect(classifyRouteMiss(baseDecision({ candidates: [] }), { intent: "помоги с задачей" })).toBeNull();
    expect(classifyRouteMiss(baseDecision({ candidates: [] }), { intent: "please help" })).toBeNull();
    expect(classifyRouteMiss(
      baseDecision({
        candidates: [candidate("deploy", 0.6)],
        evidence: { pattern: "the routing intent conflicts with the full read-only request", rejected: [], rules: [], model: "deterministic" },
      }),
      { intent: "Deploy to production", request: "Check deploy config; do not change anything" },
    )).toBeNull();
  });
});

describe("route-miss repository", () => {
  it("deduplicates the same brief in the same UTC day and separates days/sources", () => {
    const { db } = setupDb();
    const day1 = Date.UTC(2026, 10, 26, 10, 0, 0);
    const day1Later = Date.UTC(2026, 10, 26, 22, 0, 0);
    const day2 = day1 + DAY_MS;

    const first = recordRouteMiss(db, {
      projectId: PROJECT,
      source: "pm_route",
      kind: "no_candidate",
      brief: "Sync inventory with warehouse ERP",
      topWorkflowId: null,
      confidence: 0,
      category: "business",
      now: day1,
    });
    const dup = recordRouteMiss(db, {
      projectId: PROJECT,
      source: "pm_route",
      kind: "no_candidate",
      brief: "sync inventory with warehouse erp!",
      topWorkflowId: null,
      confidence: 0,
      category: "business",
      now: day1Later,
    });
    const nextDay = recordRouteMiss(db, {
      projectId: PROJECT,
      source: "pm_route",
      kind: "no_candidate",
      brief: "Sync inventory with warehouse ERP",
      now: day2,
    });
    const otherSource = recordRouteMiss(db, {
      projectId: PROJECT,
      source: "errand_route",
      kind: "no_candidate",
      brief: "Sync inventory with warehouse ERP",
      now: day1,
    });

    expect(first?.recorded).toBe(true);
    expect(dup?.recorded).toBe(false);
    expect(nextDay?.recorded).toBe(true);
    expect(otherSource?.recorded).toBe(true);
    expect(listRouteMisses(db, { since: 0, projectId: PROJECT })).toHaveLength(3);
  });

  it("redacts fake token strings and clips excerpt to 200 chars, logs debug and warn", () => {
    const { db } = setupDb();
    const debugs: string[] = [];
    const warns: string[] = [];
    const customToken = "tok_custom_secret_987654321";
    registerSecrets([customToken]);
    try {
      const longTail = "detail ".repeat(40);
      const brief = `Connect service with sk-test1234567890abcdef123456 and ${customToken} and ${longTail}`;
      const res = recordRouteMiss(
        db,
        {
          projectId: PROJECT,
          source: "pm_route",
          kind: "near_miss",
          brief,
          topWorkflowId: "api-recon",
          confidence: 45,
          category: "unknown-cat",
          secrets: ["explicit-secret-value"],
          now: 1_700_000_000_000,
        },
        { debug: (m) => debugs.push(m), warn: (m) => warns.push(m) },
      );

      expect(res?.recorded).toBe(true);
      const rows = listRouteMisses(db, { since: 0 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.briefExcerpt.length).toBeLessThanOrEqual(200);
      expect(rows[0]!.briefExcerpt).not.toContain("sk-test1234567890abcdef123456");
      expect(rows[0]!.briefExcerpt).not.toContain(customToken);
      expect(rows[0]!.briefExcerpt).toContain("***");
      expect(rows[0]!.category).toBeNull();
      expect(debugs).toEqual(["route miss kind=near_miss source=pm_route top=api-recon conf=45"]);
      expect(warns).toEqual([]);
    } finally {
      forgetSecrets();
    }

    const brokenDb = {
      prepare: () => { throw new Error("disk full"); },
    };
    const failed = recordRouteMiss(
      brokenDb,
      { source: "pm_route", kind: "no_candidate", brief: "Something failed" },
      { warn: (m) => warns.push(m) },
    );
    expect(failed).toBeNull();
    expect(warns).toEqual(["route miss write failed: disk full"]);
  });
});

describe("routeTool and errand-graph miss recording", () => {
  it("routeTool records real misses without changing routing output, and skips stateContinue and broad prompts", async () => {
    const { bb, db } = setupDb();
    const published = BUILTIN_SOURCES.map((source) => ({ name: source.name, value: { ...(source.value as object), status: "published" } }));
    const store = await loadWorkflowStore({ builtin: published });
    const depsWithMiss: WorkflowToolDeps = {
      db,
      store: async () => store,
      engine: () => ({}) as never,
      runtime: (input) => ({ ctx: {} as never, services: {} as never, ...input }),
      routePolicy: async () => ({ maxRisk: "low" }),
      recordRouteMiss: (input) => recordRouteMiss(db, input, bb.log),
      warn: (m) => bb.log.warn(m),
    };
    const depsWithoutMiss: WorkflowToolDeps = { ...depsWithMiss, recordRouteMiss: undefined };

    const ctx = { threadId: PM, projectId: PROJECT };
    const outContinue = await routeTool(depsWithMiss, { intent: "continue" }, ctx);
    expect(outContinue).toBe(await routeTool(depsWithoutMiss, { intent: "continue" }, ctx));

    const outBroad = await routeTool(depsWithMiss, { intent: "помоги с задачей" }, ctx);
    expect(outBroad).toBe(await routeTool(depsWithoutMiss, { intent: "помоги с задачей" }, ctx));
    expect(listRouteMisses(db, { since: 0 })).toEqual([]);

    const unmatchedBrief = "Quantum entanglement photon polarization calibration";
    const outMiss = await routeTool(depsWithMiss, { intent: unmatchedBrief }, ctx);
    expect(outMiss).toBe(await routeTool(depsWithoutMiss, { intent: unmatchedBrief }, ctx));
    const missesAfterUnmatched = listRouteMisses(db, { since: 0 });
    expect(missesAfterUnmatched).toHaveLength(1);
    expect(missesAfterUnmatched[0]!.source).toBe("pm_route");
    expect(missesAfterUnmatched[0]!.kind).toBe("weak_match");

    const outPolicyBlocked = await routeTool(depsWithMiss, { intent: "Deploy the service to production" }, ctx);
    expect(outPolicyBlocked).toBe(await routeTool(depsWithoutMiss, { intent: "Deploy the service to production" }, ctx));
    const allMisses = listRouteMisses(db, { since: 0 });
    expect(allMisses.some((m) => m.kind === "blocked" && m.topWorkflowId === "deploy")).toBe(true);
  });

  it("errand-graph records no_candidate for routeWhy=none and near_miss for routeWhy=below_confidence", async () => {
    const { bb, db } = setupDb();
    const published = BUILTIN_SOURCES.map((source) => ({ name: source.name, value: { ...(source.value as object), status: "published" } }));
    const store = await loadWorkflowStore({ builtin: published });
    const engine = new WorkflowEngine({ db, harnessVersion: "test" });
    const ctx = { bb, db, isDisposed: () => false, log: () => undefined } as never;
    const services = { workflowEngine: engine, workflowCatalog: { store: async () => store } } as never;
    const core = createErrandCore(ctx);
    const graph = createErrandGraphService(ctx, services, core);

    const noneRes = await graph.routedGraph({
      task: "Quantum entanglement photon polarization calibration",
      authorized: false,
      accounts: [],
      projectId: PROJECT,
    });
    expect(noneRes).toEqual({ top: "", why: "none" });

    const nearRes = await graph.routedGraph({
      task: "Do https://tasks.example.com/tasks/ab12cd34 and ship it",
      authorized: false,
      accounts: [],
      projectId: PROJECT,
    });
    expect("why" in nearRes && nearRes.why === "below_confidence").toBe(true);

    const rows = listRouteMisses(db, { since: 0, projectId: PROJECT });
    expect(rows.some((row) => row.source === "errand_route" && row.kind === "no_candidate")).toBe(true);
    expect(rows.some((row) => row.source === "errand_route" && row.kind === "near_miss")).toBe(true);
  });
});
