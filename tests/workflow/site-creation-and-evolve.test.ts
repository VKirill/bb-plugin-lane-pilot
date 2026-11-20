import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  executorKey,
  isOffered,
  loadWorkflow,
  lowerWorkflow,
  outputFields,
  parseWorkflow,
  registerReducers,
  runDraftTest,
  testCasesOf,
  WorkflowEngine,
} from "@lane-pilot/workflow-engine";
import type { Field, NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { checkDeprojectization } from "../../src/rooms/night-graphs";
import { PILOT_PROCESS_STATE_REL_PATH, readPilotProcessStateCas, setCachedProcessState } from "../../src/rooms/pilot-panel";
import { createProcessStateIo, registerPilotProcessStateAction } from "../../src/rooms/pilot-panel/server/workflow-drafts";
import { openDatabase } from "../../src/rooms/plugin-db";
import type { HollowFacts } from "../../src/rooms/sma-map/hollow-facts";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { chainStore, runSim } from "./chain-harness";
import { out, pathOf } from "./chain-helpers";
import { journalDb } from "./engine-helpers";

const WORKTREE_ROOT = join(__dirname, "../..");
const SHA256_A = "a".repeat(64);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    setCachedProcessState(dir, null);
    rmSync(dir, { recursive: true, force: true });
  }
});

const graphEvolveStubs = (overrides: Record<string, unknown> = {}) => ({
  digest: {
    status: "done",
    picked: 2,
    digested: 2,
    deltasRecorded: 1,
    skipped: 0,
    failed: 0,
  },
  collect: {
    status: "ready",
    clustersCount: 2,
    deltasCount: 3,
    payload_json: JSON.stringify({ status: "ready" }),
  },
  plan_blueprint: {
    decision: "suite_or_structural",
    graphsCount: 2,
    blueprint_json: JSON.stringify({ decision: "suite_or_structural" }),
  },
  critique_plan: {
    verdict: "pass",
    mustFixCount: 0,
    critique_json: JSON.stringify({ verdict: "pass", findings: [], mustFix: [] }),
  },
  synthesize: {
    candidatesCount: 2,
    candidates_json: JSON.stringify([{ workflowId: "universal-phase-1" }, { workflowId: "universal-orchestrator" }]),
  },
  audit_suite: {
    verdict: "pass",
    mustFixCount: 0,
    audit_json: JSON.stringify({ verdict: "pass", findings: [], mustFix: [] }),
  },
  apply: {
    status: "done",
    publishedCount: 2,
    proposedCount: 0,
    rejectedCount: 0,
    summary: "graph-evolve: 2 auto-published, 0 proposed, 0 rejected",
  },
  ...overrides,
});

function readRawWorkflow(fileName: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(WORKTREE_ROOT, "workflows", fileName), "utf8")) as Record<string, unknown>;
}

describe("lp.graph-evolve-nightly simulations", () => {
  it("happy: runs digest -> collect -> plan_blueprint -> critique_plan -> synthesize -> audit_suite -> apply -> done", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs(),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("digest collect plan_blueprint critique_plan synthesize audit_suite apply done");
    expect(out(r)).toMatchObject({
      status: "done",
      publishedCount: 2,
      proposedCount: 0,
      rejectedCount: 0,
    });
  });

  it("variant_empty: short-circuits digest -> collect -> empty_done when nothing to process", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs({
        collect: { status: "empty", clustersCount: 0, deltasCount: 0, payload_json: JSON.stringify({ status: "empty" }) },
      }),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("digest collect empty_done");
    expect(r.called("plan_blueprint")).toHaveLength(0);
    expect(r.called("synthesize")).toHaveLength(0);
    expect(r.called("apply")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "empty", publishedCount: 0, proposedCount: 0, rejectedCount: 0 });
  });

  it("variant_noop: short-circuits digest -> collect -> plan_blueprint -> noop_done when planner returns noop", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs({
        plan_blueprint: {
          decision: "noop",
          graphsCount: 0,
          blueprint_json: JSON.stringify({ decision: "noop", graphs: [] }),
        },
      }),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("digest collect plan_blueprint noop_done");
    expect(r.called("critique_plan")).toHaveLength(0);
    expect(r.called("synthesize")).toHaveLength(0);
    expect(r.called("apply")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "noop", publishedCount: 0, proposedCount: 0, rejectedCount: 0 });
  });

  it("variant_rework: loops back on critique_plan -> plan_blueprint and audit_suite -> synthesize before applying", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs({
        critique_plan: [
          { verdict: "rework", mustFixCount: 1, critique_json: JSON.stringify({ verdict: "rework", findings: ["missing gate"], mustFix: ["add gate"] }) },
          { verdict: "pass", mustFixCount: 0, critique_json: JSON.stringify({ verdict: "pass", findings: [], mustFix: [] }) },
        ],
        audit_suite: [
          { verdict: "rework", mustFixCount: 1, audit_json: JSON.stringify({ verdict: "rework", findings: ["missing mcp"], mustFix: ["add metamcp"] }) },
          { verdict: "pass", mustFixCount: 0, audit_json: JSON.stringify({ verdict: "pass", findings: [], mustFix: [] }) },
        ],
      }),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe(
      "digest collect plan_blueprint critique_plan plan_blueprint critique_plan synthesize audit_suite synthesize audit_suite apply done",
    );
    expect(r.called("plan_blueprint")).toHaveLength(2);
    expect(r.called("critique_plan")).toHaveLength(2);
    expect(r.called("synthesize")).toHaveLength(2);
    expect(r.called("audit_suite")).toHaveLength(2);
    expect(out(r)).toMatchObject({ status: "done", publishedCount: 2, proposedCount: 0, rejectedCount: 0 });
  });

  it("variant_held: completes with status held when candidate fails gates", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs({
        apply: {
          status: "held",
          publishedCount: 0,
          proposedCount: 0,
          rejectedCount: 1,
          summary: "graph-evolve: 0 auto-published, 0 proposed, 1 rejected",
        },
      }),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("digest collect plan_blueprint critique_plan synthesize audit_suite apply done");
    expect(out(r)).toMatchObject({ status: "held", publishedCount: 0, rejectedCount: 1 });
  });

  it("declares manual and schedule triggers with examples/not_for and is offered in catalog", () => {
    const nightly = builtinWorkflow("lp.graph-evolve-nightly");
    expect(nightly).toBeDefined();
    expect(nightly!.startedBy).toBeUndefined();
    expect(nightly!.triggers.map((t) => t.type)).toEqual(["manual", "schedule"]);
    expect(isOffered(nightly!)).toBe(true);
  });
});

describe("embedded test.sim cases, deprojectization, and real lp.save_process_state executor", () => {
  it("runs all testCasesOf for lp.graph-evolve-nightly via runDraftTest", async () => {
    const store = await chainStore();
    const db = journalDb();
    const wf = store.get("lp.graph-evolve-nightly")?.workflow;
    expect(wf).toBeDefined();
    const cases = testCasesOf(wf!);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const testCase of cases) {
      const res = await runDraftTest({ db, harnessVersion: "t", resolveWorkflow: store.resolve }, wf!, testCase);
      expect(res.green, `lp.graph-evolve-nightly/${testCase.id}: ${res.failures.join("; ")}`).toBe(true);
      expect(res.status).toBe("succeeded");
    }
  });

  it("passes checkDeprojectization on raw lp.graph-evolve-nightly.json", () => {
    const raw = readRawWorkflow("lp.graph-evolve-nightly.json");
    const loaded = loadWorkflow(raw);
    expect(loaded.ok).toBe(true);
    const verdict = checkDeprojectization(raw);
    expect(verdict).toEqual({ ok: true, workflowId: String(raw.id), findings: [] });
  });

  it("lp.save_process_state executor writes .agents/pilot/process-state.json cleanly via CAS", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "lp-site-state-"));
    tempDirs.push(rootPath);
    const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async ({ projectId }: { projectId: string }) => ({
            id: projectId,
            name: "Site Workspace",
            sources: [{ id: "src_1", hostId: "host_local", path: rootPath, isDefault: true }],
          }),
        },
        files: {
          read: async ({ path }: { hostId: string; path: string }) => {
            if (!existsSync(path)) {
              const err = new Error(`ENOENT: ${path}`) as Error & { code?: string };
              err.code = "ENOENT";
              throw err;
            }
            const buf = readFileSync(path);
            return { content: buf.toString("utf8"), sha256: sha(buf) };
          },
          write: async ({
            path,
            content,
            expectedSha256,
            createParents,
          }: {
            hostId: string;
            path: string;
            content: string;
            expectedSha256?: string | null;
            createParents?: boolean;
          }) => {
            if (expectedSha256 === null && existsSync(path)) {
              return { outcome: "sha_mismatch", currentSha256: sha(readFileSync(path)) };
            }
            if (typeof expectedSha256 === "string") {
              const existing = existsSync(path) ? sha(readFileSync(path)) : null;
              if (existing !== expectedSha256) {
                return { outcome: "sha_mismatch", currentSha256: existing };
              }
            }
            if (createParents) mkdirSync(dirname(path), { recursive: true });
            const next = Buffer.from(content, "utf8");
            writeFileSync(path, next);
            return { outcome: "written", sha256: sha(next) };
          },
        },
      } as never,
    });

    const db = openDatabase(bb);
    const logs: string[] = [];
    const ctx = { bb, db, log: (msg: string) => logs.push(msg) } as unknown as ServerCore;

    const workflow = parseWorkflow({
      id: "process-state-cas-check",
      name: { en: "Process state CAS check", ru: "Проверка CAS состояния процесса" },
      description: { en: "Saves process state via CAS", ru: "Сохраняет состояние процесса через CAS" },
      status: "published",
      triggers: ["manual"],
      inputs: { goal: { type: "string", required: true } },
      outputs: { status: "done", baseline_path: "string" },
      goal_check: "artifact",
      nodes: [
        {
          id: "visual_concepts",
          type: "agent",
          role: "analyst",
          title: { en: "Prepare baseline", ru: "Подготовить базовый дизайн" },
          prompt: "Design baseline for {{$inputs.goal}}",
          out: { baseline_path: "string", baseline_sha256: "string", handoff: "string" },
        },
        {
          id: "save_process_state",
          type: "action",
          action: "lp.save_process_state",
          params: {
            stage: "approved-design",
            workflowId: "process-state-cas-check",
            approvedDesignBaseline: {
              path: "{{visual_concepts.baseline_path}}",
              sha256: "{{visual_concepts.baseline_sha256}}",
            },
            activeSkills: ["ru-text", "karpathy-guidelines", "impeccable-ui", "design-taste", "web-design"],
          },
          out: { saved: "bool", path: "string", stage: "string" },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "'done'", baseline_path: "visual_concepts.baseline_path" },
        },
      ],
      edges: [
        { from: "start", to: "visual_concepts" },
        { from: "visual_concepts", to: "save_process_state" },
        { from: "save_process_state", to: "done" },
      ],
    });

    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
    registerReducers(engine);
    registerPilotProcessStateAction(engine, ctx);

    const stubs: Record<string, unknown> = {
      visual_concepts: {
        handoff: "Warm editorial palette and tokens",
        baseline_path: ".agents/site/baseline.html",
        baseline_sha256: SHA256_A,
      },
    };
    const stubExecutor: NodeExecutor = {
      reentrant: true,
      run: async (c: StepContext) => {
        const fields = outputFields(c.workflow, c.node) as Field[] | "unknown";
        const base =
          fields === "unknown"
            ? {}
            : Object.fromEntries(
                fields.map((f) => [
                  f.name,
                  f.default ??
                    (f.type === "enum"
                      ? f.values?.[0]
                      : f.type === "boolean"
                        ? false
                        : f.type === "number"
                          ? 1
                          : f.type === "array"
                            ? []
                            : f.type === "object"
                              ? {}
                              : ""),
                ]),
              );
        const given = stubs[c.nodeId];
        return {
          output: {
            ...base,
            ...(c.node.type === "agent" ? { handoff: `${c.nodeId} done` } : {}),
            ...(typeof given === "object" && given ? (given as Record<string, unknown>) : {}),
          },
        };
      },
    };
    for (const node of lowerWorkflow(workflow).nodes) {
      if (node.type === "note") continue;
      const key = executorKey(node);
      if (key && !engine.hasExecutor(key)) engine.register(key, stubExecutor);
    }

    const started = engine.start({
      workflow,
      inputs: { goal: "Создай сайт кофейни" },
      runtime: { projectId: "proj_site" },
    });
    const summary = await started.done;
    expect(summary.status, JSON.stringify(summary)).toBe("succeeded");
    expect(summary.output).toMatchObject({
      status: "done",
      baseline_path: ".agents/site/baseline.html",
    });

    const io = createProcessStateIo(ctx, "host_local", rootPath);
    const persisted = await readPilotProcessStateCas(io, { hostId: "host_local", rootPath, log: ctx.log });
    expect(persisted.error).toBeUndefined();
    expect(persisted.state).toMatchObject({
      stage: "approved-design",
      workflowId: "process-state-cas-check",
      approvedDesignBaseline: {
        path: ".agents/site/baseline.html",
        sha256: SHA256_A,
      },
      activeSkills: ["ru-text", "karpathy-guidelines", "impeccable-ui", "design-taste", "web-design"],
    });
    expect(existsSync(join(rootPath, PILOT_PROCESS_STATE_REL_PATH))).toBe(true);
  });
});

describe("SMA hollow-facts integrity", () => {
  it("lists lp.graph-evolve-nightly in hollow-facts.json with 0 workflowDefects and non-empty trace coverage", () => {
    const facts = JSON.parse(readFileSync(join(WORKTREE_ROOT, "src/rooms/sma-map/hollow-facts.json"), "utf8")) as HollowFacts;
    const graphIds = new Set(facts.graphs.map((g) => g.id));
    expect(graphIds.has("lp.graph-evolve-nightly")).toBe(true);

    const relevantDefects = facts.workflowDefects.filter((defect) => defect.graph === "lp.graph-evolve-nightly");
    expect(relevantDefects).toEqual([]);

    expect(facts.coverage["lp.graph-evolve-nightly"]?.length ?? 0).toBeGreaterThan(0);
  });
});
