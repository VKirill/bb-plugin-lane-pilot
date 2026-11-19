import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  isOffered,
  loadWorkflow,
  lowerWorkflow,
  executorKey,
  outputFields,
  registerReducers,
  routeIntent,
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
import { builtinWorkflow, builtinWorkflows } from "../../src/rooms/workflow/builtin";
import { chainStore, runSim } from "./chain-harness";
import { out, pathOf } from "./chain-helpers";
import { journalDb, rows } from "./engine-helpers";
import { publishedCatalog } from "./router-catalog";

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

const baseSiteStubs = (overrides: Record<string, unknown> = {}) => ({
  smart_intake: {
    objective: "Create coffee shop website",
    tasks: [{ id: "t1", title: "Build site" }],
    needs_brief: false,
    has_references: false,
    questions: [],
  },
  discover_references: {
    handoff: "Collected 3 competitor references",
    direction_pack: ".agents/site/references.md",
  },
  copy_and_structure: {
    handoff: "Prepared sections and copy",
    sections_path: ".agents/site/sections.md",
  },
  visual_concepts: {
    handoff: "Warm editorial palette and tokens",
    baseline_path: ".agents/site/baseline.html",
    baseline_sha256: SHA256_A,
  },
  save_process_state: {
    saved: true,
    path: PILOT_PROCESS_STATE_REL_PATH,
    stage: "approved-design",
  },
  build_site: { state: "accepted", merge_commit: "abc1234" },
  verify_browser: {
    status: "pass",
    findings: [],
    screenshots: [".agents/site/375.png", ".agents/site/1280.png"],
  },
  ...overrides,
});

const graphEvolveStubs = (overrides: Record<string, unknown> = {}) => ({
  collect: {
    status: "ready",
    clustersCount: 2,
    deltasCount: 3,
    payload_json: JSON.stringify({ status: "ready" }),
  },
  synthesize: {
    candidatesCount: 1,
    candidates_json: JSON.stringify([{ workflowId: "universal-candidate" }]),
  },
  apply: {
    status: "done",
    publishedCount: 1,
    proposedCount: 0,
    rejectedCount: 0,
    summary: "graph-evolve: 1 auto-published, 0 proposed, 0 rejected",
  },
  ...overrides,
});

function readRawWorkflow(fileName: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(WORKTREE_ROOT, "workflows", fileName), "utf8")) as Record<string, unknown>;
}

describe("site-creation simulations", () => {
  it("happy_no_refs: discovers competitor references when none provided and reaches done", async () => {
    const r = await runSim("site-creation", {
      input: { goal: "Создай сайт кофейни с нуля", niche: "кофейня", locale: "ru" },
      stubs: baseSiteStubs(),
      humans: { approve_direction: { answer_kind: "approve", answer: "" } },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction save_process_state build_site verify_browser done");
    expect(out(r)).toMatchObject({
      status: "done",
      baseline_path: ".agents/site/baseline.html",
      merge_commit: "abc1234",
    });
    expect(r.skipped).toEqual(["ask_brief"]);
    expect(r.called("discover_references")).toHaveLength(1);
    expect(r.called("save_process_state")).toHaveLength(1);
    expect(r.steps.every((step) => step.state === "succeeded" || step.state === "skipped")).toBe(true);
    expect(r.calls.length).toBeGreaterThanOrEqual(7);
  });

  it("variant_with_refs: skips discover_references via skip_when and passes skip_out handoff downstream", async () => {
    const r = await runSim("site-creation", {
      input: {
        goal: "Build a B2B analytics website from provided references",
        references: "https://example.com/ref-1",
        locale: "en",
      },
      stubs: baseSiteStubs({
        smart_intake: {
          objective: "Build B2B analytics website",
          tasks: [{ id: "t1", title: "Build site" }],
          needs_brief: false,
          has_references: true,
          questions: [],
        },
      }),
      humans: { approve_direction: { answer_kind: "approve", answer: "" } },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction save_process_state build_site verify_browser done");
    expect(out(r)).toMatchObject({ status: "done" });
    expect(r.skipped).toEqual(["ask_brief", "discover_references"]);
    expect(r.called("discover_references")).toHaveLength(0);

    const skippedStep = rows<{ state: string; output_json: string | null }>(
      r.db,
      "SELECT state, output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='discover_references'",
      r.summary.runId,
    )[0];
    expect(skippedStep?.state).toBe("skipped");
    expect(JSON.parse(skippedStep?.output_json ?? "{}")).toEqual({
      handoff: "Owner references provided",
      direction_pack: "owner-references",
    });
  });

  it("owner_concept_rework: loops back to visual_concepts on rework then approves and finishes", async () => {
    const r = await runSim("site-creation", {
      input: { goal: "Создай сайт стоматологии", niche: "стоматология" },
      stubs: baseSiteStubs(),
      humans: {
        ask_brief: { answer_kind: "answered", answer: "Фокус на семейную стоматологию" },
        approve_direction: [
          { answer_kind: "rework", answer: "Сделай палитру теплее" },
          { answer_kind: "approve", answer: "Подходит" },
        ],
      },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe(
      "smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction visual_concepts approve_direction save_process_state build_site verify_browser done",
    );
    expect(r.called("visual_concepts")).toHaveLength(2);
    expect(r.called("visual_concepts")[1]!.input).toMatchObject({ feedback: "Сделай палитру теплее" });
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("variant_rework: loops back from verify_browser to build_site with findings and finishes on pass", async () => {
    const qaFinding = { severity: "high", title: "Mobile hero CTA wraps awkwardly at 375 px" };
    const r = await runSim("site-creation", {
      input: { goal: "Создай сайт кофейни" },
      stubs: baseSiteStubs({
        build_site: [
          { state: "accepted", merge_commit: "abc1234" },
          { state: "accepted", merge_commit: "def5678" },
        ],
        verify_browser: [
          { status: "rework", findings: [qaFinding], screenshots: [".agents/site/375-v1.png"] },
          { status: "pass", findings: [], screenshots: [".agents/site/375-v2.png", ".agents/site/1280-v2.png"] },
        ],
      }),
      humans: { approve_direction: { answer_kind: "approve", answer: "" } },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe(
      "smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction save_process_state build_site verify_browser build_site verify_browser done",
    );
    expect(r.called("build_site")).toHaveLength(2);
    expect(r.called("build_site")[1]!.input).toMatchObject({ qa_findings: [qaFinding] });
    expect(out(r)).toMatchObject({ status: "done", merge_commit: "def5678" });
  });

  it("variant_blocked: routes cleanly to blocked when build_site or verify_browser blocks", async () => {
    const buildBlocked = await runSim("site-creation", {
      input: { goal: "Создай сайт" },
      stubs: baseSiteStubs({ build_site: { state: "blocked", merge_commit: "" } }),
      humans: { approve_direction: { answer_kind: "approve", answer: "" } },
    });
    expect(buildBlocked.summary.status).toBe("succeeded");
    expect(pathOf(buildBlocked)).toBe(
      "smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction save_process_state build_site blocked",
    );
    expect(out(buildBlocked)).toMatchObject({ status: "blocked" });

    const qaBlocked = await runSim("site-creation", {
      input: { goal: "Создай сайт" },
      stubs: baseSiteStubs({
        verify_browser: { status: "block", findings: [{ severity: "critical", title: "App fails to boot" }], screenshots: [] },
      }),
      humans: { approve_direction: { answer_kind: "approve", answer: "" } },
    });
    expect(qaBlocked.summary.status).toBe("succeeded");
    expect(pathOf(qaBlocked)).toBe(
      "smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction save_process_state build_site verify_browser blocked",
    );
    expect(out(qaBlocked)).toMatchObject({ status: "blocked" });
  });

  it("variant_abort and ask_brief abort/timeout: routes cleanly to aborted", async () => {
    const briefAbort = await runSim("site-creation", {
      input: { goal: "Создай сайт" },
      stubs: baseSiteStubs({
        smart_intake: {
          objective: "Clarify brief",
          tasks: [{ id: "t1", title: "Clarify" }],
          needs_brief: true,
          has_references: false,
          questions: ["Какой основной оффер?"],
        },
      }),
      humans: { ask_brief: { answer_kind: "abort", answer: "" } },
    });
    expect(briefAbort.summary.status).toBe("succeeded");
    expect(pathOf(briefAbort)).toBe("smart_intake ask_brief aborted");
    expect(out(briefAbort)).toMatchObject({ status: "aborted" });

    const briefTimeout = await runSim("site-creation", {
      input: { goal: "Создай сайт" },
      stubs: baseSiteStubs({
        smart_intake: {
          objective: "Clarify brief",
          tasks: [{ id: "t1", title: "Clarify" }],
          needs_brief: true,
          has_references: false,
          questions: ["Какой основной оффер?"],
        },
      }),
      humans: { ask_brief: { answer_kind: "timeout", answer: "" } },
    });
    expect(briefTimeout.summary.status).toBe("succeeded");
    expect(pathOf(briefTimeout)).toBe("smart_intake ask_brief aborted");
    expect(out(briefTimeout)).toMatchObject({ status: "aborted" });

    const directionAbort = await runSim("site-creation", {
      input: { goal: "Создай сайт" },
      stubs: baseSiteStubs(),
      humans: { approve_direction: { answer_kind: "abort", answer: "" } },
    });
    expect(directionAbort.summary.status).toBe("succeeded");
    expect(pathOf(directionAbort)).toBe(
      "smart_intake ask_brief discover_references copy_and_structure visual_concepts approve_direction aborted",
    );
    expect(out(directionAbort)).toMatchObject({ status: "aborted" });
  });
});

describe("lp.graph-evolve-nightly simulations", () => {
  it("happy: runs collect -> synthesize -> apply -> done", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs(),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("collect synthesize apply done");
    expect(out(r)).toMatchObject({
      status: "done",
      publishedCount: 1,
      proposedCount: 0,
      rejectedCount: 0,
    });
  });

  it("variant_empty: short-circuits collect -> empty_done when nothing to process", async () => {
    const r = await runSim("lp.graph-evolve-nightly", {
      input: {},
      stubs: graphEvolveStubs({
        collect: { status: "empty", clustersCount: 0, deltasCount: 0, payload_json: JSON.stringify({ status: "empty" }) },
      }),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("collect empty_done");
    expect(r.called("synthesize")).toHaveLength(0);
    expect(r.called("apply")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "empty", publishedCount: 0, proposedCount: 0, rejectedCount: 0 });
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
    expect(pathOf(r)).toBe("collect synthesize apply done");
    expect(out(r)).toMatchObject({ status: "held", publishedCount: 0, rejectedCount: 1 });
  });

  it("is excluded from user-facing router offers via startedBy", () => {
    const nightly = builtinWorkflow("lp.graph-evolve-nightly");
    expect(nightly).toBeDefined();
    expect(nightly!.startedBy).toBe("graph-evolve-nightly");
    expect(isOffered(nightly!)).toBe(false);
  });
});

describe("embedded test.sim cases, deprojectization, and real lp.save_process_state executor", () => {
  it("runs all testCasesOf for site-creation and lp.graph-evolve-nightly via runDraftTest", async () => {
    const store = await chainStore();
    const db = journalDb();
    for (const id of ["site-creation", "lp.graph-evolve-nightly"] as const) {
      const wf = store.get(id)?.workflow;
      expect(wf, id).toBeDefined();
      const cases = testCasesOf(wf!);
      expect(cases.length, id).toBeGreaterThanOrEqual(3);
      for (const testCase of cases) {
        const res = await runDraftTest({ db, harnessVersion: "t", resolveWorkflow: store.resolve }, wf!, testCase);
        expect(res.green, `${id}/${testCase.id}: ${res.failures.join("; ")}`).toBe(true);
        expect(res.status).toBe("succeeded");
      }
    }
  });

  it("passes checkDeprojectization on raw site-creation.json and lp.graph-evolve-nightly.json", () => {
    for (const file of ["site-creation.json", "lp.graph-evolve-nightly.json"] as const) {
      const raw = readRawWorkflow(file);
      const loaded = loadWorkflow(raw);
      expect(loaded.ok, file).toBe(true);
      const verdict = checkDeprojectization(raw);
      expect(verdict, file).toEqual({ ok: true, workflowId: String(raw.id), findings: [] });
    }
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

    const store = await chainStore();
    const workflow = store.get("site-creation")!.workflow;
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", resolveWorkflow: store.resolve });
    registerReducers(engine);
    registerPilotProcessStateAction(engine, ctx);

    const stubs = baseSiteStubs();
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
        const given = (stubs as Record<string, unknown>)[c.nodeId];
        return {
          output: {
            ...base,
            ...(c.node.type === "agent" ? { handoff: `${c.nodeId} done` } : {}),
            ...(typeof given === "object" && given ? (given as Record<string, unknown>) : {}),
          },
        };
      },
    };
    for (const node of lowerWorkflow(workflow, store.resolve).nodes) {
      if (node.type === "note") continue;
      const key = executorKey(node);
      if (key && !engine.hasExecutor(key)) engine.register(key, stubExecutor);
    }
    engine.register("builtin:human", {
      reentrant: true,
      run: async () => ({ output: { answer: "", answer_kind: "approve" } }),
    });

    const started = engine.start({
      workflow,
      inputs: { goal: "Создай сайт кофейни", niche: "кофейня", locale: "ru" },
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
      workflowId: "site-creation",
      approvedDesignBaseline: {
        path: ".agents/site/baseline.html",
        sha256: SHA256_A,
      },
      activeSkills: ["ru-text", "karpathy-guidelines", "impeccable-ui", "design-taste", "web-design"],
    });
    expect(existsSync(join(rootPath, PILOT_PROCESS_STATE_REL_PATH))).toBe(true);
  });
});

describe("site-creation router classification", () => {
  const catalog = publishedCatalog();
  const route = (intent: string) => routeIntent({ intent, workflows: catalog });

  it("routes Russian and English website creation requests to site-creation", async () => {
    const ru = await route(
      "Хочу создать сайт с нуля под тематику кофейни: собери референсы конкурентов, структуру, копирайтинг и дизайн",
    );
    expect(ru).toMatchObject({ decision: "route", workflowId: "site-creation" });

    const en = await route(
      "Create a new website from scratch for our B2B niche: analyze competitors, gather design references, write copy and build",
    );
    expect(en).toMatchObject({ decision: "route", workflowId: "site-creation" });
  });

  it("keeps personal anamnesis site on about-site and vague site requests on clarify", async () => {
    const about = await route("Сделай сайт-визитку обо мне из публичных записей анамнеза");
    expect(about.workflowId).toBe("about-site");

    const vague = await route("Сделай что-нибудь с сайтом");
    expect(vague.decision).toBe("clarify");
  });

  it("registers site-creation in builtinWorkflows", () => {
    const wf = builtinWorkflows().find((w) => w.id === "site-creation");
    expect(wf).toBeDefined();
    expect(wf!.status).toBe("published");
    expect(isOffered(wf!)).toBe(true);
  });
});

describe("SMA hollow-facts integrity", () => {
  it("lists site-creation and lp.graph-evolve-nightly in hollow-facts.json with 0 workflowDefects and non-empty trace coverage", () => {
    const facts = JSON.parse(readFileSync(join(WORKTREE_ROOT, "src/rooms/sma-map/hollow-facts.json"), "utf8")) as HollowFacts;
    const graphIds = new Set(facts.graphs.map((g) => g.id));
    expect(graphIds.has("site-creation")).toBe(true);
    expect(graphIds.has("lp.graph-evolve-nightly")).toBe(true);

    const relevantDefects = facts.workflowDefects.filter(
      (defect) => defect.graph === "site-creation" || defect.graph === "lp.graph-evolve-nightly",
    );
    expect(relevantDefects).toEqual([]);

    expect(facts.coverage["site-creation"]?.length ?? 0).toBeGreaterThan(0);
    expect(facts.coverage["lp.graph-evolve-nightly"]?.length ?? 0).toBeGreaterThan(0);
  });
});
