// Owns: src/rooms/night-graphs/server/graph-evolve-graph.ts, src/rooms/night-graphs/server/graph-evolve-pipeline.ts, src/rooms/night-graphs/server/graph-evolve-suite.ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import {
  createDraftStore,
  createStatusResolver,
  definitionSha256,
  loadWorkflow,
  loadWorkflowStore,
  runDraftTest,
  testCasesOf,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTrajectoryDelta } from "../../src/rooms/errands";
import { lintSkillDir, readSkillDir } from "../../src/rooms/forge/skill-lint";
import { checkDeprojectization, classifyEvolutionDiff } from "../../src/rooms/night-graphs";
import {
  GRAPH_EVOLVE_WORKFLOW,
  applyGraphEvolveCandidates,
  auditSynthesizedSuite,
  collectGraphEvolveEvidence,
  critiqueEvolutionBlueprint,
  mountGraphEvolveNightly,
  planEvolutionBlueprint,
  synthesizeSuiteFromBlueprint,
  type EvolveCatalogContext,
  type EvolveRoleRunner,
  type GraphEvolveCandidate,
} from "../../src/rooms/night-graphs/server";
import { readExistingCompanionSkills } from "../../src/rooms/night-graphs/server/companion-skill-evolve";
import { synthesizeSuiteAndSkillsFromBlueprint } from "../../src/rooms/night-graphs/server/graph-evolve-pipeline";
import { collectOwnerWaiting, listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { openDatabase, savePilotDayDigest } from "../../src/rooms/plugin-db";
import { listSkillEvolutionsForDraft } from "../../src/rooms/storage";
import { BUILTIN_SOURCES, builtinWorkflow } from "../../src/rooms/workflow";
import { createWorkflowArchitect } from "../../src/rooms/workflow/server";
import { buildWorkflowMap } from "../../src/rooms/workflow/server/workflow-map";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { nightWorld } from "./world";

const tempDirs: string[] = [];

function makeTempGlobalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-graph-evolve-"));
  tempDirs.push(dir);
  return dir;
}

function makeLandingWorkflow(overrides: {
  id?: string;
  category?: unknown;
  prompt?: string;
  skills?: string[];
  extraInputs?: Record<string, unknown>;
  expectOutput?: Record<string, unknown>;
  extraSecrets?: string[];
  extraNodes?: Array<Record<string, unknown>>;
  extraEdges?: Array<Record<string, unknown>>;
} = {}): Record<string, unknown> {
  const id = overrides.id ?? "universal-landing-flow";
  return {
    id,
    ...(overrides.category !== undefined ? { category: overrides.category } : {}),
    name: { en: "Universal landing flow", ru: "Универсальный поток лендинга" },
    description: {
      en: "Designs landing copy for {{$inputs.target_domain}} using verified inputs.",
      ru: "Готовит структуру и текст лендинга для {{$inputs.target_domain}} по проверенным данным.",
    },
    inputs: {
      target_domain: { type: "string", default: "example.com", note: "Target domain" },
      ...(overrides.extraInputs ?? {}),
    },
    outputs: {
      status: "done|blocked",
      summary: "string",
    },
    goal_check: "artifact",
    requires: {
      plugins: ["lane-pilot"],
      skills: [],
      secrets: overrides.extraSecrets ?? [],
      machines: [],
    },
    nodes: [
      {
        id: "draft_page",
        type: "agent",
        role: "analyst",
        produces: [{ kind: "report", version: 1 }],
        profile: { skills: overrides.skills ?? [] },
        title: { en: "Draft landing page", ru: "Собрать структуру лендинга" },
        prompt: overrides.prompt ?? "Write landing copy for {{$inputs.target_domain}} based only on provided facts.",
        out: { handoff: "string", status: "done|blocked" },
      },
      ...(overrides.extraNodes ?? []),
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { status: "draft_page.status", summary: "draft_page.handoff" },
      },
    ],
    edges: [
      { from: "start", to: "draft_page" },
      ...(overrides.extraEdges ?? [{ from: "draft_page", to: "done" }]),
    ],
    test: {
      id: `${id}-sim`,
      sim: {
        input: { target_domain: "example.com" },
        stubs: {
          draft_page: { handoff: "Landing copy prepared for example.com", status: "done" },
        },
        expect_path: ["draft_page", "done"],
        expect_status: "succeeded",
        expect_output: overrides.expectOutput ?? { status: "done" },
      },
    },
  };
}

function makeTestArchitect(db: ReturnType<typeof openDatabase>, globalDir: string, logs: string[]) {
  const minCtx = { db, log: (m: string) => logs.push(m), realtime: { notify: () => undefined } } as unknown as ServerCore;
  return createWorkflowArchitect(minCtx, { workflowEngine: { hasExecutor: () => false } } as never, {
    globalDir: () => globalDir,
    projectPlace: async () => null,
    capabilityPorts: () => ({}),
    hasExecutor: () => false,
    writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "project_place_unknown" }),
  });
}

afterEach(() => {
  forgetSecrets();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("De-projectization Gate and diff classifier", () => {
  it("rejects hardcoded project domains, paths, host/project IDs, secrets and forbidden grants without leaking secrets in logs", () => {
    const secret = "sk-" + "x".repeat(24);
    const projectId = "proj_" + "vechkasov1";
    const hostId = "host_" + "macmini01";
    registerSecrets([secret]);

    const checks: Array<{ name: string; def: Record<string, unknown>; expectedCode: string }> = [
      {
        name: "hardcoded domain vechkasov.ru",
        def: makeLandingWorkflow({ prompt: "Check vechkasov.ru and report status." }),
        expectedCode: "project_name_or_domain",
      },
      {
        name: "POSIX path /Users/...",
        def: makeLandingWorkflow({ prompt: "Read /Users/alice/site/index.html before editing." }),
        expectedCode: "abs_path",
      },
      {
        name: "host ID",
        def: makeLandingWorkflow({ prompt: `Run build on ${hostId}.` }),
        expectedCode: "host_id",
      },
      {
        name: "project ID",
        def: makeLandingWorkflow({ prompt: `Query project ${projectId} settings.` }),
        expectedCode: "project_id",
      },
      {
        name: "secret shape",
        def: makeLandingWorkflow({ prompt: `Authenticate with ${secret} when calling API.` }),
        expectedCode: "secret_shape",
      },
      {
        name: "forbidden grant",
        def: makeLandingWorkflow({ prompt: "Invoke cli with --dangerously-skip-permissions flag." }),
        expectedCode: "forbidden_grant",
      },
    ];

    for (const item of checks) {
      const logs: string[] = [];
      const verdict = checkDeprojectization(item.def, {
        knownProjectIds: [projectId],
        knownHostIds: [hostId],
        knownDomains: ["vechkasov.ru"],
        log: (m) => logs.push(m),
        logLevel: "debug",
      });
      expect(verdict.ok, item.name).toBe(false);
      expect(verdict.findings.map((f) => f.code), item.name).toContain(item.expectedCode);
      expect(logs.some((line) => line.includes("WARN [nightGraphs.deprojectize] rejected")), item.name).toBe(true);
      expect(logs.join("\n"), item.name).not.toContain(secret);
    }
  });

  it("accepts a parameterized universal workflow with $inputs.* placeholders and example.com", () => {
    const logs: string[] = [];
    const def = makeLandingWorkflow({
      prompt: "Analyze {{$inputs.target_domain}} and compare with example.com baseline.",
    });
    const verdict = checkDeprojectization(def, {
      knownDomains: ["vechkasov.ru"],
      log: (m) => logs.push(m),
      logLevel: "debug",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
    expect(logs.some((line) => line.includes("DEBUG [nightGraphs.deprojectize] passed"))).toBe(true);
  });

  it("classifies minor skills/intake/trap updates as minor_patch and new/topology/secrets changes as structural_or_new", () => {
    const base = makeLandingWorkflow();
    const minorNext = makeLandingWorkflow({
      skills: ["ru-text"],
      extraInputs: {
        brand_tone: { type: "string", default: "", note: "Вопрос в intake: какой тон бренда использовать?" },
      },
      prompt: "Write landing copy for {{$inputs.target_domain}}. Trap: never invent metrics without proof.",
    });

    const minorDiff = classifyEvolutionDiff(base, minorNext);
    expect(minorDiff.kind).toBe("minor_patch");
    expect(minorDiff.addedSkills).toEqual(["ru-text"]);
    expect(minorDiff.addedInputs).toEqual(["brand_tone"]);
    expect(minorDiff.reasons).toContain("skills_added");
    expect(minorDiff.reasons).toContain("optional_inputs_added");

    expect(classifyEvolutionDiff(null, base)).toMatchObject({
      kind: "structural_or_new",
      reasons: ["new_v1"],
    });

    const topologyNext = makeLandingWorkflow({
      extraNodes: [{ id: "review_step", type: "action", action: "noop", out: {} }],
      extraEdges: [
        { from: "draft_page", to: "review_step" },
        { from: "review_step", to: "done" },
      ],
    });
    expect(classifyEvolutionDiff(base, topologyNext).kind).toBe("structural_or_new");

    const secretsNext = makeLandingWorkflow({ extraSecrets: ["OPENAI_API_KEY"] });
    const secretsDiff = classifyEvolutionDiff(base, secretsNext);
    expect(secretsDiff.kind).toBe("structural_or_new");
    expect(secretsDiff.reasons).toContain("permissions_expanded");
  });

  it("rejects project-bound dynamic categories in checkDeprojectization and classifies category.id vs label changes", () => {
    const logs: string[] = [];
    const leakyCategoryDef = makeLandingWorkflow({
      id: "project-sites-flow",
      category: {
        id: "vechkasov-web",
        label: { en: "Vechkasov.ru Sites", ru: "Сайты Vechkasov.ru" },
      },
    });
    const verdict = checkDeprojectization(leakyCategoryDef, {
      knownProjectNames: ["Vechkasov"],
      log: (m) => logs.push(m),
      logLevel: "debug",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toContain("project_name_or_domain");
    expect(logs.some((line) => line.includes("WARN [nightGraphs.deprojectize] rejected"))).toBe(true);

    const publishedWithCat = makeLandingWorkflow({
      id: "analytics-bi-flow",
      category: { id: "analytics-ops", label: { en: "Analytics & BI", ru: "Аналитика и BI" } },
    });
    const labelRefined = makeLandingWorkflow({
      id: "analytics-bi-flow",
      category: { id: "analytics-ops", label: { en: "Analytics & Reporting", ru: "Аналитика и отчётность" } },
    });
    expect(classifyEvolutionDiff(publishedWithCat, labelRefined)).toMatchObject({
      kind: "minor_patch",
    });

    const categoryChanged = makeLandingWorkflow({
      id: "analytics-bi-flow",
      category: { id: "bi-reporting", label: { en: "BI Reporting", ru: "BI отчёты" } },
    });
    const catChangedDiff = classifyEvolutionDiff(publishedWithCat, categoryChanged);
    expect(catChangedDiff.kind).toBe("structural_or_new");
    expect(catChangedDiff.reasons).toContain("category_changed");
  });
});

describe("lp.graph-evolve-nightly evidence collection and policy matrix", () => {
  it("collects enriched process clusters and unprocessed trajectory deltas with verbose diagnostic logs", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = 1_760_000_000_000;
    const projectId = "proj_" + "demo01";

    for (const runId of ["run_ep_1", "run_ep_2"]) {
      db.prepare(
        `INSERT INTO lane_pilot_wf_run
          (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
         VALUES (?, 'errand', 1, 'sha', '{}', ?, 'succeeded', '{}', '{}', 120, 50, ?, ?)`,
      ).run(runId, projectId, now - 10_000, now - 5_000);
      db.prepare(
        `INSERT INTO lane_pilot_errand_episode
          (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, process_key, summary_json, created_at, updated_at)
         VALUES (?, 1, ?, 'errand', 'succeeded', 'done', 'enriched', 'website|landing-design', ?, ?, ?)`,
      ).run(
        runId,
        projectId,
        JSON.stringify({
          goal: "Создать структуру лендинга и тексты",
          traps: ["Не выдумывать кейсы без фактов"],
          skills: [{ name: "ru-text", read: true, used: true }],
        }),
        now - 10_000,
        now - 5_000,
      );
    }

    const deltaRes = recordTrajectoryDelta(db, {
      projectId,
      workflowId: "universal-landing-flow",
      stageArchetype: "copywriting",
      interventionKind: "skill_request",
      rawSummary: "Подключи навык ru-text для текста первого экрана",
      resolvedSkills: ["ru-text"],
      now: now - 2_000,
    });
    expect(deltaRes.status).toBe("recorded");

    const logs: string[] = [];
    const evidence = collectGraphEvolveEvidence(db, { now: () => now, log: (m) => logs.push(m) });

    expect(evidence.status).toBe("ready");
    expect(evidence.clusters).toHaveLength(1);
    expect(evidence.clusters[0]).toMatchObject({
      processKey: "website|landing-design",
      count: 2,
      topSkills: ["ru-text"],
      sampleGoals: ["Создать структуру лендинга и тексты"],
      traps: ["Не выдумывать кейсы без фактов"],
    });
    expect(evidence.deltas).toHaveLength(1);
    expect(evidence.deltaIds).toEqual([deltaRes.row!.id]);
    expect(logs.some((line) => line.includes("INFO [nightGraphs.graphEvolve] collected"))).toBe(true);
  });

  it("merges singleton episodes and digests into domain-family and project-trajectory clusters and filters by projectId", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = 1_760_000_000_000;

    // 3 singleton enriched episodes from related website/design domains in proj_site
    const insertRun = db.prepare(`INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
      VALUES (?, 'errand', 1, 'sha', '{}', ?, 'succeeded', '{}', '{}', 50, 10, ?, ?)`);
    const insertEp = db.prepare(`INSERT INTO lane_pilot_errand_episode
      (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, process_key, summary_json, created_at, updated_at)
      VALUES (?, 1, ?, 'errand', 'succeeded', 'done', 'enriched', ?, ?, ?, ?)`);

    const singletons = [
      { id: "ep_comp", proj: "proj_site", key: "competitor-analysis|bench-sites", goal: "Benchmark 5 competitor landings", trap: "No CTA fold check", skill: "web-research" },
      { id: "ep_pen", proj: "proj_site", key: "website-design|pen-kit", goal: "Create .pen UI kit before pages", trap: "Missing mobile 375px tokens", skill: "project-design" },
      { id: "ep_img", proj: "proj_site", key: "image-studio|hero-art", goal: "Generate stylized hero illustrations", trap: "Inconsistent style across screens", skill: "image-prompting" },
      { id: "ep_other", proj: "proj_other", key: "seo-audit|crawl-site", goal: "Run SEO crawl", trap: "Robots blocked", skill: "seo-tech-audit-kit" },
    ];
    for (const s of singletons) {
      insertRun.run(s.id, s.proj, now - 10_000, now - 5_000);
      insertEp.run(s.id, s.proj, s.key, JSON.stringify({ goal: s.goal, traps: [s.trap], skills: [{ name: s.skill, read: true, used: true }] }), now - 10_000, now - 5_000);
    }

    // 2 unrelated-domain singleton digests inside proj_mixed
    savePilotDayDigest(db, {
      digestId: "pdigest_mix_1", dayKey: "2026-11-20", sourceKind: "pilot_chat", sourceId: "thr_mix_1",
      projectId: "proj_mixed", outcome: "done", processKey: "analytics|kpi-audit",
      skills: ["mkt-end-to-end-analytics"], traps: ["Missing UTM map"], maskedGoal: "Audit KPI funnel", maskedLessons: ["Check UTM first"], createdAt: now - 3_000,
    });
    savePilotDayDigest(db, {
      digestId: "pdigest_mix_2", dayKey: "2026-11-20", sourceKind: "pilot_chat", sourceId: "thr_mix_2",
      projectId: "proj_mixed", outcome: "done", processKey: "crm|webhook-sync",
      skills: ["env-catalog"], traps: ["Unverified webhook payload"], maskedGoal: "Sync CRM webhook", maskedLessons: ["Validate payload schema"], createdAt: now - 2_000,
    });

    const siteLogs: string[] = [];
    const siteOnly = collectGraphEvolveEvidence(db, { projectId: "proj_site", now: () => now, log: (m) => siteLogs.push(m) });
    expect(siteOnly.clusters).toHaveLength(1);
    expect(siteOnly.clusters[0]).toMatchObject({
      processKey: "websites|trajectory-suite",
      count: 3,
      categoryHint: { id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } },
    });
    expect(siteOnly.clusters[0]?.sampleGoals).toHaveLength(3);
    expect(siteOnly.clusters[0]?.traps).toHaveLength(3);
    expect(siteOnly.clusters[0]?.topSkills).toEqual(expect.arrayContaining(["web-research", "project-design", "image-prompting"]));
    expect(siteLogs.some((l) => l.includes('"singletonMerged":3') && l.includes('"projectId":"proj_site"'))).toBe(true);

    const mixedOnly = collectGraphEvolveEvidence(db, { projectId: "proj_mixed", now: () => now });
    expect(mixedOnly.clusters).toHaveLength(1);
    expect(mixedOnly.clusters[0]?.processKey).toMatch(/\|project-trajectory$/);
    expect(mixedOnly.clusters[0]?.count).toBe(2);
    expect(mixedOnly.clusters[0]?.lessons).toEqual(expect.arrayContaining(["Check UTM first", "Validate payload schema"]));
  });

  it("enforces the full policy matrix: (a) deprojectize reject, (b) minor v1->v2 auto-publish, (c) red test reject, (d) new v1 held in tested", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const globalDir = makeTempGlobalDir();
    let clock = 1_760_000_000_000;
    const now = () => {
      clock += 1_000;
      return clock;
    };
    const logs: string[] = [];

    // (a) Leaking global candidate is rejected before creating a draft or writing to globalDir.
    const leakyRes = await applyGraphEvolveCandidates(
      {
        db,
        globalDir: () => globalDir,
        knownContext: { knownDomains: ["vechkasov.ru"] },
        now,
        log: (m) => logs.push(m),
      },
      [
        {
          workflowId: "leaky-landing-flow",
          scope: "global",
          name: { en: "Leaky flow", ru: "Поток с утечкой" },
          description: { en: "Hardcodes domain", ru: "Содержит домен проекта" },
          definition: makeLandingWorkflow({
            id: "leaky-landing-flow",
            prompt: "Audit vechkasov.ru and /Users/alice/site before writing.",
          }),
        },
      ],
    );
    expect(leakyRes.rejectedCount).toBe(1);
    expect(leakyRes.publishedCount).toBe(0);
    expect(leakyRes.outcomes[0]).toMatchObject({ workflowId: "leaky-landing-flow", status: "rejected_deprojectize", draftId: null });
    expect(readdirSync(globalDir)).toEqual([]);
    expect(logs.some((line) => line.includes("WARN [nightGraphs.deprojectize] rejected"))).toBe(true);
    expect(logs.some((line) => line.includes("WARN [nightGraphs.graphEvolve] deprojectize_failed"))).toBe(true);

    // Seed published v1 of universal-landing-flow in DraftStore + globalDir.
    const drafts = createDraftStore(db, now);
    const v1Def = makeLandingWorkflow({ id: "universal-landing-flow" });
    const v1Draft = drafts.create({
      projectId: "*",
      threadId: null,
      scope: "global",
      name: { en: "Universal landing flow", ru: "Универсальный поток лендинга" },
      description: { en: "Designs landing copy", ru: "Готовит тексты лендинга" },
      workflowId: "universal-landing-flow",
      definition: v1Def,
    });
    const v1Loaded = loadWorkflow(v1Draft.definition);
    expect(v1Loaded.ok).toBe(true);
    if (!v1Loaded.ok) throw new Error("expected valid v1 workflow");
    const v1Results = [];
    for (const tc of testCasesOf(v1Loaded.workflow)) {
      v1Results.push(await runDraftTest({ db, harnessVersion: "test", now }, v1Loaded.workflow, tc));
    }
    drafts.recordTests(v1Draft.id, v1Draft.version, v1Results, true);
    const seedArchitect = makeTestArchitect(db, globalDir, logs);
    const v1Pub = await seedArchitect.publish({ projectId: "*", draftId: v1Draft.id });
    expect(v1Pub.published).toBe(true);

    // Record a trajectory delta consumed by the minor v1 -> v2 evolution.
    const delta = recordTrajectoryDelta(db, {
      projectId: "proj_" + "demo02",
      workflowId: "universal-landing-flow",
      stageArchetype: "copywriting",
      interventionKind: "skill_request",
      rawSummary: "Добавь навык ru-text, вопрос про тон бренда и проверку-ловушку",
      resolvedSkills: ["ru-text"],
      now: now(),
    });
    expect(delta.status).toBe("recorded");

    // (b) Minor patch (+skills, +intake question, +prompt trap) with green tests auto-publishes v1 -> v2.
    const v2Def = makeLandingWorkflow({
      id: "universal-landing-flow",
      skills: ["ru-text"],
      extraInputs: {
        brand_tone: { type: "string", default: "calm", note: "Вопрос при приёме: какой тон бренда?" },
      },
      prompt: "Write landing copy for {{$inputs.target_domain}}. Ловушка: не выдумывай цифры и факты.",
    });
    const minorRes = await applyGraphEvolveCandidates(
      { db, globalDir: () => globalDir, now, log: (m) => logs.push(m) },
      [
        {
          workflowId: "universal-landing-flow",
          scope: "global",
          name: { en: "Universal landing flow", ru: "Универсальный поток лендинга" },
          description: { en: "Designs landing copy", ru: "Готовит тексты лендинга" },
          definition: v2Def,
          sourceDeltaIds: [delta.row!.id],
          sourceProcessKey: "website|landing-design",
        },
      ],
    );

    expect(minorRes.publishedCount).toBe(1);
    expect(minorRes.rejectedCount).toBe(0);
    expect(minorRes.outcomes[0]).toMatchObject({
      workflowId: "universal-landing-flow",
      kind: "minor_patch",
      status: "auto_published",
      version: 2,
    });

    const v2FilePath = join(globalDir, "universal-landing-flow.json");
    const v2Disk = JSON.parse(readFileSync(v2FilePath, "utf8")) as Record<string, unknown>;
    expect(v2Disk.version).toBe(2);
    expect(v2Disk.status).toBe("published");

    const v2Loaded = loadWorkflow(v2Disk);
    expect(v2Loaded.ok).toBe(true);
    if (!v2Loaded.ok) throw new Error("expected valid v2 workflow on disk");
    const receipt = createStatusResolver(db).receipt("universal-landing-flow", definitionSha256(v2Loaded.workflow));
    expect(receipt?.green).toBe(1);

    const deltaAfter = db.prepare("SELECT processed_at FROM lane_pilot_trajectory_delta WHERE id=?").get(delta.row!.id) as { processed_at: number | null };
    expect(deltaAfter.processed_at).not.toBeNull();

    const draftIdV2 = minorRes.outcomes[0]!.draftId!;
    const prevSnapshot = drafts.previousVersionSnapshot(draftIdV2);
    expect(prevSnapshot?.version).toBe(1);

    const waitingAfterV2 = collectOwnerWaiting(db, now());
    const digestItem = waitingAfterV2.items.find((item) => item.kind === "workflow_evolved_digest");
    expect(digestItem).toBeDefined();
    expect(digestItem?.actions[0]?.rpc?.method).toBe("pilot_panel_rollback_workflow_draft");
    expect(digestItem?.actions[0]?.rpc?.input).toEqual({ draftId: draftIdV2 });

    // (c) Red runDraftTest refuses auto-publish, preserves v2 on disk, and posts no new digest.
    const redCandidateDef = makeLandingWorkflow({
      id: "universal-landing-flow",
      skills: ["ru-text"],
      extraInputs: {
        brand_tone: { type: "string", default: "calm", note: "Вопрос при приёме: какой тон бренда?" },
        cta_style: { type: "string", default: "direct", note: "Вопрос: стиль CTA?" },
      },
      prompt: "Write landing copy for {{$inputs.target_domain}}. Ловушка: проверь CTA.",
      expectOutput: { status: "impossible_status" },
    });
    const redRes = await applyGraphEvolveCandidates(
      { db, globalDir: () => globalDir, now, log: (m) => logs.push(m) },
      [
        {
          workflowId: "universal-landing-flow",
          scope: "global",
          name: { en: "Universal landing flow", ru: "Универсальный поток лендинга" },
          description: { en: "Designs landing copy", ru: "Готовит тексты лендинга" },
          definition: redCandidateDef,
        },
      ],
    );
    expect(redRes.rejectedCount).toBe(1);
    expect(redRes.publishedCount).toBe(0);
    expect(redRes.outcomes[0]).toMatchObject({
      workflowId: "universal-landing-flow",
      kind: "minor_patch",
      status: "rejected_tests",
      version: null,
    });
    expect(logs.some((line) => line.includes("WARN [nightGraphs.graphEvolve] tested") && line.includes('"green":false'))).toBe(true);

    const diskAfterRed = JSON.parse(readFileSync(v2FilePath, "utf8")) as Record<string, unknown>;
    expect(diskAfterRed.version).toBe(2);
    expect(listOpenOwnerItems(db, { kind: "workflow_evolved_digest" })).toHaveLength(1);

    // (d) Brand-new v1 universal graph with green tests stays in status `tested` until owner confirms.
    const newV1Res = await applyGraphEvolveCandidates(
      { db, globalDir: () => globalDir, now, log: (m) => logs.push(m) },
      [
        {
          workflowId: "new-site-archetype",
          scope: "global",
          name: { en: "New site archetype", ru: "Новый архетип сайта" },
          description: { en: "New green universal workflow", ru: "Новый универсальный граф" },
          definition: makeLandingWorkflow({ id: "new-site-archetype" }),
        },
      ],
    );
    expect(newV1Res.proposedCount).toBe(1);
    expect(newV1Res.publishedCount).toBe(0);
    expect(newV1Res.outcomes[0]).toMatchObject({
      workflowId: "new-site-archetype",
      kind: "structural_or_new",
      status: "proposed_tested",
      version: 1,
    });

    const newDraft = drafts.get(newV1Res.outcomes[0]!.draftId!);
    expect(newDraft?.status).toBe("tested");
    expect(existsSync(join(globalDir, "new-site-archetype.json"))).toBe(false);

    const waitingAfterNew = collectOwnerWaiting(db, now());
    const proposedItem = waitingAfterNew.items.find((item) => item.kind === "workflow_draft_proposed");
    expect(proposedItem).toBeDefined();
    expect(proposedItem?.actions[0]?.rpc?.method).toBe("pilot_panel_publish_workflow_draft");
    expect(proposedItem?.actions[0]?.rpc?.input).toEqual({ draftId: newDraft!.id });
  });

  it("supports end-to-end autonomous dynamic category creation, publish, store load, and workflow map projection", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const globalDir = makeTempGlobalDir();
    let clock = 1_760_100_000_000;
    const now = () => {
      clock += 1_000;
      return clock;
    };
    const logs: string[] = [];

    const applied = await applyGraphEvolveCandidates(
      { db, globalDir: () => globalDir, now, log: (m) => logs.push(m) },
      [
        {
          workflowId: "analytics-bi-flow",
          scope: "global",
          name: { en: "Analytics BI flow", ru: "Поток аналитики и BI" },
          description: { en: "Builds BI metrics report", ru: "Собирает отчёт по метрикам BI" },
          definition: makeLandingWorkflow({
            id: "analytics-bi-flow",
            category: { id: "analytics-ops", label: { en: "Analytics & BI", ru: "Аналитика и BI" } },
          }),
        },
      ],
    );

    expect(applied.proposedCount).toBe(1);
    expect(applied.rejectedCount).toBe(0);
    expect(applied.outcomes[0]).toMatchObject({
      workflowId: "analytics-bi-flow",
      kind: "structural_or_new",
      status: "proposed_tested",
      version: 1,
    });
    expect(logs.some((line) =>
      line.includes("INFO [nightGraphs.graphEvolve] category_selected")
      && line.includes('"categoryId":"analytics-ops"')
      && line.includes('"isDynamic":true'),
    )).toBe(true);

    const draftId = applied.outcomes[0]!.draftId!;
    const architect = makeTestArchitect(db, globalDir, logs);
    const pub = await architect.publish({ projectId: "*", draftId });
    expect(pub.published).toBe(true);

    const store = await loadWorkflowStore({ builtin: [], globalDir });
    const mapData = buildWorkflowMap(store.list(), () => ({ runs30d: 0, successRate: null }), "test-sha");
    const mapped = mapData.graphs.find((g) => g.id === "analytics-bi-flow");
    expect(mapped).toMatchObject({
      id: "analytics-bi-flow",
      category: "analytics-ops",
      categoryLabel: { en: "Analytics & BI", ru: "Аналитика и BI" },
    });
  });
});

describe("4-model evolution pipeline and topological subworkflow suite publication", () => {
  const websitesCategory = { id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } };

  function makeWebsiteBlueprint(complete: boolean) {
    return {
      decision: "suite_or_structural",
      rationale: "Synthesize modular 3-phase website creation suite from trajectory clusters",
      category: websitesCategory,
      orderInvariants: [
        "Build CTA and conversion map before visual design",
        "Approve multi-variant visual direction and UI kit before CMS templates",
      ],
      variantParameters: complete
        ? [{ name: "variants_count", rangeOrValues: "1..10", purpose: "Explore multiple visual concepts and palettes" }]
        : [],
      requiredIntegrations: complete
        ? { mcp: ["metamcp"], plugins: ["image-studio"], skills: ["ru-text", "impeccable-ui"] }
        : { mcp: [], plugins: [], skills: ["ru-text"] },
      graphs: [
        {
          workflowId: "site-strategy-cta",
          kind: "phase_graph",
          name: { en: "Site Strategy & CTA Map", ru: "Стратегия сайта и карта CTA" },
          description: { en: "Builds conversion and CTA map for {{$inputs.goal}}", ru: "Строит карту CTA и конверсии для {{$inputs.goal}}" },
          dependsOnGraphs: [],
          inputs: { goal: "string", niche: "string" },
          outputs: { status: "done|blocked", cta_map: "string" },
          stages: [
            {
              id: "map_cta",
              nodeType: "agent",
              role: "specialist:copy-lead",
              purpose: "Create conversion and CTA map before visual design",
              skills: ["ru-text"],
              mcp: [],
              plugins: [],
              contractRules: ["CTA map must precede visual design"],
            },
          ],
          acceptanceCriteria: ["Non-empty CTA map artifact"],
        },
        {
          workflowId: "site-design-concepts",
          kind: "phase_graph",
          name: { en: "Site Visual Concepts", ru: "Визуальные концепции сайта" },
          description: { en: "Generates multi-variant visual concepts in Pencil .pen", ru: "Создаёт несколько визуальных концепций в Pencil .pen" },
          dependsOnGraphs: ["site-strategy-cta"],
          inputs: { goal: "string", cta_map: "string", variants_count: "int" },
          outputs: { status: "done|blocked", approved_concept: "string" },
          stages: [
            {
              id: "draw_concepts",
              nodeType: "agent",
              role: "specialist:design-lead",
              purpose: "Generate variants_count visual concepts in Pencil .pen and imagery",
              skills: ["impeccable-ui"],
              mcp: complete ? ["metamcp"] : [],
              plugins: complete ? ["image-studio"] : [],
              contractRules: ["Export PNGs and inspect text clipping"],
            },
            {
              id: "choose_concept",
              nodeType: "human",
              role: "owner",
              purpose: "Select winning visual concept",
              skills: [],
              mcp: [],
              plugins: [],
              contractRules: [],
            },
          ],
          acceptanceCriteria: ["Owner approves one visual concept"],
        },
        {
          workflowId: "site-ui-kit-cms",
          kind: "phase_graph",
          name: { en: "Site UI Kit & CMS", ru: "UI-кит и сборка сайта" },
          description: { en: "Implements UI kit, templates, and verifies browser QA", ru: "Собирает UI-кит, шаблоны и проверяет вёрстку в браузере" },
          dependsOnGraphs: ["site-design-concepts"],
          inputs: { goal: "string", approved_concept: "string" },
          outputs: { status: "done|blocked", summary: "string" },
          stages: [
            {
              id: "build_site",
              nodeType: "lp-task",
              purpose: "Implement UI kit and CMS templates",
              skills: ["impeccable-ui"],
              mcp: [],
              plugins: [],
              contractRules: ["Verify 375px and 1280px viewports"],
            },
          ],
          acceptanceCriteria: ["UI kit and CMS templates accepted"],
        },
        {
          workflowId: "site-creation-suite",
          kind: "master_orchestrator",
          name: { en: "Site Creation Suite", ru: "Оркестратор создания сайта" },
          description: { en: "Chains strategy, multi-variant design, and CMS build", ru: "Связывает стратегию, дизайн-концепции и сборку сайта" },
          dependsOnGraphs: ["site-strategy-cta", "site-design-concepts", "site-ui-kit-cms"],
          inputs: { goal: "string", niche: "string", variants_count: "int" },
          outputs: { status: "done|blocked", summary: "string" },
          stages: [
            { id: "strategy", nodeType: "subworkflow", subworkflowId: "site-strategy-cta", purpose: "Run strategy", skills: [], mcp: [], plugins: [], contractRules: [] },
            { id: "concepts", nodeType: "subworkflow", subworkflowId: "site-design-concepts", purpose: "Run concepts", skills: [], mcp: [], plugins: [], contractRules: [] },
            { id: "build_cms", nodeType: "subworkflow", subworkflowId: "site-ui-kit-cms", purpose: "Run UI kit and CMS", skills: [], mcp: [], plugins: [], contractRules: [] },
          ],
          acceptanceCriteria: ["All 3 phase graphs execute in order"],
        },
      ],
    };
  }

  function makeSuiteCandidates(opts: { includeMcpAndVariants?: boolean; childPromptLeak?: string; childExpectOutput?: Record<string, unknown> } = {}): GraphEvolveCandidate[] {
    const includeMcp = opts.includeMcpAndVariants ?? true;
    const strategyDef: Record<string, unknown> = {
      id: "site-strategy-cta",
      version: 1,
      category: websitesCategory,
      name: { en: "Site Strategy & CTA Map", ru: "Стратегия сайта и карта CTA" },
      description: { en: "Builds CTA map for {{$inputs.goal}}", ru: "Строит карту CTA для {{$inputs.goal}}" },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        goal: { type: "string", required: true, description: "Website goal" },
        niche: { type: "string", default: "general", description: "Target niche" },
      },
      outputs: { status: "done|blocked", cta_map: "string" },
      goal_check: "artifact",
      requires: { plugins: ["lane-pilot"], skills: ["ru-text"], secrets: [], machines: [] },
      nodes: [
        {
          id: "map_cta",
          type: "agent",
          role: "specialist:copy-lead",
          profile: { skills: ["ru-text"] },
          title: { en: "Map CTA and conversion", ru: "Собрать карту CTA" },
          prompt: opts.childPromptLeak ?? "Build CTA and conversion map for {{$inputs.goal}} in niche {{$inputs.niche}} before any visual design.",
          out: { status: "done|blocked", cta_map: "string", handoff: "string" },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "map_cta.status", cta_map: "map_cta.cta_map" },
        },
      ],
      edges: [
        { from: "start", to: "map_cta" },
        { from: "map_cta", to: "done" },
      ],
      test: {
        id: "site-strategy-cta-sim",
        sim: {
          input: { goal: "Launch landing page", niche: "saas" },
          stubs: { map_cta: { status: "done", cta_map: "Hero CTA -> Demo form", handoff: "CTA map ready" } },
          expect_path: ["map_cta", "done"],
          expect_status: "succeeded",
          expect_output: opts.childExpectOutput ?? { status: "done" },
        },
      },
    };

    const conceptsDef: Record<string, unknown> = {
      id: "site-design-concepts",
      version: 1,
      category: websitesCategory,
      name: { en: "Site Visual Concepts", ru: "Визуальные концепции сайта" },
      description: { en: "Designs visual concepts in Pencil .pen", ru: "Готовит визуальные концепции в Pencil .pen" },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        goal: { type: "string", required: true, description: "Website goal" },
        cta_map: { type: "string", required: true, description: "Approved CTA map" },
        variants_count: { type: "int", default: 4, description: "Number of distinct visual concepts and palettes" },
      },
      outputs: { status: "done|blocked", approved_concept: "string" },
      goal_check: "artifact",
      requires: { plugins: includeMcp ? ["lane-pilot", "image-studio"] : ["lane-pilot"], skills: ["impeccable-ui"], secrets: [], machines: [] },
      nodes: [
        {
          id: "draw_concepts",
          type: "agent",
          role: "specialist:design-lead",
          profile: { skills: ["impeccable-ui"] },
          ...(includeMcp ? { mcp: ["metamcp"], plugins: ["image-studio"] } : {}),
          title: { en: "Design visual concepts", ru: "Создать визуальные концепции" },
          prompt: includeMcp
            ? "Create {{$inputs.variants_count}} distinct Pencil .pen concepts and palettes for {{$inputs.goal}} using CTA map {{$inputs.cta_map}}."
            : "Create visual concept for {{$inputs.goal}} using CTA map {{$inputs.cta_map}}.",
          out: { status: "done|blocked", concepts_summary: "string", handoff: "string" },
        },
        {
          id: "choose_concept",
          type: "human",
          title: { en: "Select visual concept", ru: "Выбрать визуальную концепцию" },
          question: "Approve one of the generated visual concepts?",
          options: ["approve", "abort"],
          out: { answer: "string", answer_kind: "approve|abort" },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "draw_concepts.status", approved_concept: "draw_concepts.concepts_summary" },
        },
      ],
      edges: [
        { from: "start", to: "draw_concepts" },
        { from: "draw_concepts", to: "choose_concept" },
        { from: "choose_concept", to: "done" },
      ],
      test: {
        id: "site-design-concepts-sim",
        sim: {
          input: { goal: "Launch landing page", cta_map: "Hero CTA -> Demo", variants_count: 4 },
          stubs: { draw_concepts: { status: "done", concepts_summary: "Concept B warm editorial", handoff: "4 concepts rendered" } },
          human_answers: { choose_concept: "approve" },
          expect_path: ["draw_concepts", "choose_concept", "done"],
          expect_status: "succeeded",
          expect_output: { status: "done" },
        },
      },
    };

    const uiKitCmsDef: Record<string, unknown> = {
      id: "site-ui-kit-cms",
      version: 1,
      category: websitesCategory,
      name: { en: "Site UI Kit & CMS", ru: "UI-кит и сборка сайта" },
      description: { en: "Builds UI kit and CMS templates", ru: "Собирает UI-кит и шаблоны CMS" },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        goal: { type: "string", required: true, description: "Website goal" },
        approved_concept: { type: "string", required: true, description: "Approved concept" },
      },
      outputs: { status: "done|blocked", summary: "string" },
      goal_check: "artifact",
      requires: { plugins: ["lane-pilot"], skills: ["impeccable-ui"], secrets: [], machines: [] },
      nodes: [
        {
          id: "build_site",
          type: "lp-task",
          title: { en: "Build UI kit and CMS", ru: "Собрать UI-кит и CMS" },
          owns_paths: ["src/**", "public/**"],
          contract: {
            title: "Build UI kit and CMS for {{$inputs.goal}}",
            goal: "Implement {{$inputs.approved_concept}} with 375px and 1280px QA checks",
            acceptance: ["Responsive 375px and 1280px layouts pass"],
          },
          out: { state: "accepted|blocked|failed", summary: "string" },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "'done'", summary: "build_site.summary" },
        },
      ],
      edges: [
        { from: "start", to: "build_site" },
        { from: "build_site", to: "done" },
      ],
      test: {
        id: "site-ui-kit-cms-sim",
        sim: {
          input: { goal: "Launch landing page", approved_concept: "Concept B" },
          stubs: { build_site: { state: "accepted", summary: "UI kit and CMS built" } },
          expect_path: ["build_site", "done"],
          expect_status: "succeeded",
          expect_output: { status: "done" },
        },
      },
    };

    const orchestratorDef: Record<string, unknown> = {
      id: "site-creation-suite",
      version: 1,
      category: websitesCategory,
      name: { en: "Site Creation Suite", ru: "Оркестратор создания сайта" },
      description: { en: "Orchestrates strategy, design concepts, and UI kit CMS", ru: "Оркестрирует стратегию, дизайн-концепции и сборку CMS" },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        goal: { type: "string", required: true, description: "Website goal" },
        niche: { type: "string", default: "general", description: "Target niche" },
        variants_count: { type: "int", default: 4, description: "Visual concept count" },
      },
      outputs: { status: "done|blocked", summary: "string" },
      goal_check: "artifact",
      requires: { plugins: ["lane-pilot"], skills: [], secrets: [], machines: [] },
      nodes: [
        {
          id: "strategy",
          type: "subworkflow",
          workflow: "site-strategy-cta",
          title: { en: "Phase 1: Strategy & CTA", ru: "Фаза 1: Стратегия и CTA" },
          inputs: { goal: "{{$inputs.goal}}", niche: "{{$inputs.niche}}" },
          out: { status: "done|blocked", cta_map: "string" },
          guards: { maxVisits: 1 },
        },
        {
          id: "concepts",
          type: "subworkflow",
          workflow: "site-design-concepts",
          title: { en: "Phase 2: Visual Concepts", ru: "Фаза 2: Визуальные концепции" },
          inputs: { goal: "{{$inputs.goal}}", cta_map: "{{strategy.cta_map}}", variants_count: "{{$inputs.variants_count}}" },
          out: { status: "done|blocked", approved_concept: "string" },
          guards: { maxVisits: 1 },
        },
        {
          id: "build_cms",
          type: "subworkflow",
          workflow: "site-ui-kit-cms",
          title: { en: "Phase 3: UI Kit & CMS", ru: "Фаза 3: UI-кит и CMS" },
          inputs: { goal: "{{$inputs.goal}}", approved_concept: "{{concepts.approved_concept}}" },
          out: { status: "done|blocked", summary: "string" },
          guards: { maxVisits: 1 },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "build_cms.status", summary: "build_cms.summary" },
        },
      ],
      edges: [
        { from: "start", to: "strategy" },
        { from: "strategy", to: "concepts" },
        { from: "concepts", to: "build_cms" },
        { from: "build_cms", to: "done" },
      ],
      test: {
        id: "site-creation-suite-sim",
        sim: {
          input: { goal: "Launch landing page", niche: "saas", variants_count: 4 },
          stubs: {
            strategy: { status: "done", cta_map: "Hero CTA -> Demo" },
            concepts: { status: "done", approved_concept: "Concept B" },
            build_cms: { status: "done", summary: "Suite completed" },
          },
          expect_path: ["strategy", "concepts", "build_cms", "done"],
          expect_status: "succeeded",
          expect_output: { status: "done", summary: "Suite completed" },
        },
      },
    };

    const toCandidate = (def: Record<string, unknown>): GraphEvolveCandidate => ({
      workflowId: String(def.id),
      scope: "global",
      name: def.name as { en: string; ru: string },
      description: def.description as { en: string; ru: string },
      category: websitesCategory,
      definition: def,
    });

    // Intentionally return orchestrator FIRST and leaves AFTER to prove topological sorting.
    return [
      toCandidate(orchestratorDef),
      toCandidate(uiKitCmsDef),
      toCandidate(conceptsDef),
      toCandidate(strategyDef),
    ];
  }

  it("runs the 4-role pipeline (rework loops on critique + audit), sorts topologically, publishes all 4 subworkflow suite files with green receipts, and maps calls edges", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const globalDir = makeTempGlobalDir();
    let clock = 1_760_200_000_000;
    const now = () => {
      clock += 1_000;
      return clock;
    };
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const collected = {
      clusters: [{
        processKey: "websites|trajectory-suite",
        count: 4,
        topSkills: ["ru-text", "impeccable-ui"],
        sampleGoals: ["Design .pen concepts and build responsive website"],
        traps: ["Map CTA before visual design", "Verify 375px layout"],
        lessons: ["Generate multiple concepts in metamcp Pencil .pen and image-studio before UI kit"],
        categoryHint: websitesCategory,
      }],
      deltas: [],
      deltaIds: [],
      status: "ready" as const,
    };
    const catalog: EvolveCatalogContext = {
      knownCategories: [{ id: "code" }, { id: "seo" }],
      existingGlobal: [],
      reservedBuiltinIds: ["seo-page", "lp.graph-evolve-nightly"],
      availableSkills: ["ru-text", "impeccable-ui"],
      availablePlugins: ["image-studio", "browser-automation"],
      availableMcp: ["metamcp"],
    };

    let planIter = 0;
    let critiqueIter = 0;
    let synthIter = 0;
    let auditIter = 0;
    const runRole: EvolveRoleRunner = async (role) => {
      if (role === "planner") {
        planIter += 1;
        return JSON.stringify(makeWebsiteBlueprint(planIter >= 2));
      }
      if (role === "plan-critic") {
        critiqueIter += 1;
        return critiqueIter === 1
          ? JSON.stringify({ verdict: "rework", findings: ["Missing Pencil/metamcp and variants_count"], mustFix: ["Add metamcp, image-studio, and variants_count"] })
          : JSON.stringify({ verdict: "pass", findings: [], mustFix: [] });
      }
      if (role === "workflow-architect") {
        synthIter += 1;
        return JSON.stringify({ candidates: makeSuiteCandidates({ includeMcpAndVariants: synthIter >= 2 }) });
      }
      auditIter += 1;
      return auditIter === 1
        ? JSON.stringify({ verdict: "rework", findings: ["Missing metamcp and variants_count in concepts graph"], mustFix: ["Wire metamcp, image-studio, and variants_count"] })
        : JSON.stringify({ verdict: "pass", findings: [], mustFix: [] });
    };

    // Stage 1 -> Stage 2 rework -> Stage 1 revision -> Stage 2 pass
    const bp1 = await planEvolutionBlueprint({ collected, catalog, runRole, iteration: 1, log });
    const crit1 = await critiqueEvolutionBlueprint({ blueprint: bp1, collected, catalog, runRole, iteration: 1, log });
    expect(crit1.verdict).toBe("rework");
    const bp2 = await planEvolutionBlueprint({ collected, catalog, runRole, priorBlueprint: bp1, criticFeedback: crit1, iteration: 2, log });
    const crit2 = await critiqueEvolutionBlueprint({ blueprint: bp2, collected, catalog, runRole, iteration: 2, log });
    expect(crit2.verdict).toBe("pass");
    expect(bp2.graphs.map((g) => g.workflowId)).toEqual(["site-strategy-cta", "site-design-concepts", "site-ui-kit-cms", "site-creation-suite"]);

    // Stage 3 -> Stage 4 rework -> Stage 3 repair -> Stage 4 pass
    const cand1 = await synthesizeSuiteFromBlueprint({ blueprint: bp2, collected, catalog, runRole, iteration: 1, log });
    const aud1 = await auditSynthesizedSuite({ blueprint: bp2, candidates: cand1, collected, runRole, iteration: 1, log });
    expect(aud1.verdict).toBe("rework");
    const cand2 = await synthesizeSuiteFromBlueprint({ blueprint: bp2, collected, catalog, runRole, priorCandidates: cand1, auditFeedback: aud1, iteration: 2, log });
    const aud2 = await auditSynthesizedSuite({ blueprint: bp2, candidates: cand2, collected, runRole, iteration: 2, log });
    expect(aud2.verdict).toBe("pass");

    // Reverse order input -> topological publisher emits leaves before site-creation-suite
    expect(cand2.map((c) => c.workflowId)).toEqual(["site-creation-suite", "site-ui-kit-cms", "site-design-concepts", "site-strategy-cta"]);
    const applied = await applyGraphEvolveCandidates(
      { db, globalDir: () => globalDir, now, log },
      cand2,
      { publishApprovedSuite: true },
    );
    expect(applied.publishedCount).toBe(4);
    expect(applied.rejectedCount).toBe(0);

    const topoLine = logs.find((l) => l.includes("[nightGraphs.graphEvolve] suite_topology"))!;
    expect(topoLine).toBeDefined();
    const topoOrder = (JSON.parse(topoLine.slice(topoLine.indexOf("{"))) as { order: string[] }).order;
    expect(topoOrder.indexOf("site-strategy-cta")).toBeLessThan(topoOrder.indexOf("site-creation-suite"));
    expect(topoOrder.indexOf("site-design-concepts")).toBeLessThan(topoOrder.indexOf("site-creation-suite"));
    expect(topoOrder.indexOf("site-ui-kit-cms")).toBeLessThan(topoOrder.indexOf("site-creation-suite"));

    const resolver = createStatusResolver(db);
    for (const id of ["site-strategy-cta", "site-design-concepts", "site-ui-kit-cms", "site-creation-suite"]) {
      const diskPath = join(globalDir, `${id}.json`);
      expect(existsSync(diskPath), diskPath).toBe(true);
      const raw = JSON.parse(readFileSync(diskPath, "utf8")) as Record<string, unknown>;
      expect(raw.status).toBe("published");
      expect(raw.version).toBe(1);
      const loaded = loadWorkflow(raw, {
        resolve: (refId) => {
          const p = join(globalDir, `${refId}.json`);
          if (!existsSync(p)) return null;
          const dep = loadWorkflow(JSON.parse(readFileSync(p, "utf8")));
          return dep.ok ? dep.workflow : null;
        },
      });
      expect(loaded.ok, id).toBe(true);
      if (!loaded.ok) throw new Error(id);
      const sha = definitionSha256(loaded.workflow);
      const receipt = resolver.receipt(id, sha);
      expect(receipt?.green, id).toBe(1);
    }

    const store = await loadWorkflowStore({
      builtin: BUILTIN_SOURCES,
      globalDir,
      resolveStatus: (item) => resolver.resolve(item),
    });
    expect(store.problems).toEqual([]);
    for (const id of ["site-strategy-cta", "site-design-concepts", "site-ui-kit-cms", "site-creation-suite"]) {
      expect(store.get(id)?.workflow.status, id).toBe("published");
    }

    const mapData = buildWorkflowMap(store.list(), () => ({ runs30d: 0, successRate: null }), "test-sha");
    expect(mapData.graphs.find((g) => g.id === "site-creation-suite")).toMatchObject({
      category: "websites",
      categoryLabel: { en: "Websites & Design", ru: "Сайты и дизайн" },
      status: "published",
    });
    const suiteCalls = mapData.calls.filter((c) => c.fromGraph === "site-creation-suite").map((c) => c.toGraph);
    expect(suiteCalls).toEqual(["site-strategy-cta", "site-design-concepts", "site-ui-kit-cms"]);

    // Verbose logging assertions across all 4 pipeline stages and suite publisher
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).toContain("[nightGraphs.evolvePipeline] blueprint_planned");
    expect(joinedLogs).toContain("[nightGraphs.evolvePipeline] blueprint_critiqued");
    expect(joinedLogs).toContain("[nightGraphs.evolvePipeline] suite_synthesized");
    expect(joinedLogs).toContain("[nightGraphs.evolvePipeline] suite_audited");
    expect(joinedLogs).toContain("[nightGraphs.graphEvolve] suite_topology");
    expect(joinedLogs).toContain("[nightGraphs.graphEvolve] test_receipt_recorded");
  });

  it("executes full lp.graph-evolve-nightly engine runs for approved suite publication and decision:noop branch", async () => {
    const tempHome = makeTempGlobalDir();
    const prevHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const w = nightWorld({
        hostReply: (command) => (command.includes('"$HOME/.lane-pilot/graph-evolve"') ? join(tempHome, ".lane-pilot/graph-evolve") : undefined),
      });
      const logs: string[] = [];
      const origLog = w.ctx.log;
      w.ctx.log = (m: string) => {
        logs.push(m);
        origLog(m);
      };

      const nowMs = Date.now();
      w.db.prepare(
        `INSERT INTO lane_pilot_wf_run
          (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
         VALUES ('run_suite_1', 'errand', 1, 'sha', '{}', 'proj-1', 'succeeded', '{}', '{}', 100, 10, ?, ?)`,
      ).run(nowMs - 5_000, nowMs - 2_000);
      w.db.prepare(
        `INSERT INTO lane_pilot_errand_episode
          (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, process_key, summary_json, created_at, updated_at)
         VALUES ('run_suite_1', 1, 'proj-1', 'errand', 'succeeded', 'done', 'enriched', 'website-design|pen-kit', ?, ?, ?)`,
      ).run(
        JSON.stringify({
          goal: "Build multi-variant website concepts in Pencil .pen and CMS",
          traps: ["Map CTA before design"],
          skills: [{ name: "ru-text", read: true, used: true }],
        }),
        nowMs - 5_000,
        nowMs - 2_000,
      );
      w.db.prepare(
        `INSERT INTO lane_pilot_wf_run
          (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
         VALUES ('run_suite_2', 'errand', 1, 'sha', '{}', 'proj-1', 'succeeded', '{}', '{}', 100, 10, ?, ?)`,
      ).run(nowMs - 4_000, nowMs - 1_000);
      w.db.prepare(
        `INSERT INTO lane_pilot_errand_episode
          (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, process_key, summary_json, created_at, updated_at)
         VALUES ('run_suite_2', 1, 'proj-1', 'errand', 'succeeded', 'done', 'enriched', 'image-studio|hero-art', ?, ?, ?)`,
      ).run(
        JSON.stringify({
          goal: "Generate hero illustrations with image-studio",
          traps: ["Check 375px layout"],
          skills: [{ name: "impeccable-ui", read: true, used: true }],
        }),
        nowMs - 4_000,
        nowMs - 1_000,
      );

      let mode: "suite" | "noop" = "suite";
      const runAnalyzer = vi.fn(async (_projId: string, _key: string, _prompt: string, _host: unknown, _model: unknown, _meta: unknown, role?: string) => {
        if (mode === "noop") {
          return JSON.stringify({
            decision: "noop",
            rationale: "Existing workflows already cover this minor variation",
            category: null,
            orderInvariants: [],
            variantParameters: [],
            requiredIntegrations: { mcp: [], plugins: [], skills: [] },
            graphs: [],
          });
        }
        if (role === "planner") return JSON.stringify(makeWebsiteBlueprint(true));
        if (role === "plan-critic" || role === "auditor") return JSON.stringify({ verdict: "pass", findings: [], mustFix: [] });
        if (role === "workflow-architect") return JSON.stringify({ candidates: makeSuiteCandidates({ includeMcpAndVariants: true }) });
        return "{}";
      });

      w.harness.sdk.stub("hosts.list", async () => []);
      w.services.ruleScan = { runAnalyzer };
      mountGraphEvolveNightly(w.ctx, w.services);

      const nightlyWorkflow = builtinWorkflow(GRAPH_EVOLVE_WORKFLOW)!;
      const run1 = await w.engine.start({
        workflow: nightlyWorkflow,
        inputs: { project_id: "proj-1", lookback_days: 14, publish_approved_suite: true },
        runtime: { ctx: w.ctx, services: w.services, pmThreadId: null, projectId: "proj-1", runId: null, origin: "manual" },
      }).done;
      expect(run1.status, JSON.stringify(run1)).toBe("succeeded");
      expect(run1.output).toMatchObject({ status: "done", publishedCount: 4, proposedCount: 0, rejectedCount: 0 });

      const publishedDir = join(tempHome, ".lane-pilot", "workflows");
      expect(readdirSync(publishedDir).sort()).toEqual([
        "site-creation-suite.json",
        "site-design-concepts.json",
        "site-strategy-cta.json",
        "site-ui-kit-cms.json",
      ]);

      // decision: "noop" branch exits via noop_done with publishedCount: 0
      mode = "noop";
      const run2 = await w.engine.start({
        workflow: nightlyWorkflow,
        inputs: { project_id: "proj-1", lookback_days: 14, publish_approved_suite: true },
        runtime: { ctx: w.ctx, services: w.services, pmThreadId: null, projectId: "proj-1", runId: null, origin: "manual" },
      }).done;
      expect(run2.status, JSON.stringify(run2)).toBe("succeeded");
      expect(run2.output).toMatchObject({
        status: "noop",
        publishedCount: 0,
        proposedCount: 0,
        rejectedCount: 0,
        summary: "graph-evolve: planner decided noop",
      });

      await w.harness.lifecycle.dispose();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("atomically rejects parent master_orchestrator with dependency_failed:<childId> when a child phase_graph fails deprojectize or runDraftTest", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);

    // Case 1: child fails checkDeprojectization (leaks vechkasov.ru)
    const dir1 = makeTempGlobalDir();
    const resDeproj = await applyGraphEvolveCandidates(
      { db, globalDir: () => dir1, knownContext: { knownDomains: ["vechkasov.ru"] } },
      makeSuiteCandidates({ childPromptLeak: "Audit vechkasov.ru before writing CTA map." }),
      { publishApprovedSuite: true },
    );
    expect(resDeproj.rejectedCount).toBe(2);
    expect(resDeproj.outcomes.find((o) => o.workflowId === "site-strategy-cta")).toMatchObject({
      status: "rejected_deprojectize",
    });
    expect(resDeproj.outcomes.find((o) => o.workflowId === "site-creation-suite")).toMatchObject({
      status: "rejected_invalid",
      reason: "dependency_failed:site-strategy-cta",
    });
    expect(existsSync(join(dir1, "site-strategy-cta.json"))).toBe(false);
    expect(existsSync(join(dir1, "site-creation-suite.json"))).toBe(false);

    // Case 2: child fails runDraftTest
    const dir2 = makeTempGlobalDir();
    const resTest = await applyGraphEvolveCandidates(
      { db, globalDir: () => dir2 },
      makeSuiteCandidates({ childExpectOutput: { status: "impossible_status" } }),
      { publishApprovedSuite: true },
    );
    expect(resTest.rejectedCount).toBe(2);
    expect(resTest.outcomes.find((o) => o.workflowId === "site-strategy-cta")).toMatchObject({
      status: "rejected_tests",
    });
    expect(resTest.outcomes.find((o) => o.workflowId === "site-creation-suite")).toMatchObject({
      status: "rejected_invalid",
      reason: "dependency_failed:site-strategy-cta",
    });
    expect(existsSync(join(dir2, "site-strategy-cta.json"))).toBe(false);
    expect(existsSync(join(dir2, "site-creation-suite.json"))).toBe(false);
  });

  it("preserves structured object findings/mustFix in auditSynthesizedSuite and supplies WORKFLOW_REFERENCE to auditor", async () => {
    const prompts: string[] = [];
    const verdict = await auditSynthesizedSuite({
      blueprint: {
        decision: "suite_or_structural",
        rationale: "Site suite",
        category: { id: "websites", label: { en: "Websites", ru: "Сайты" } },
        orderInvariants: ["CTA before design"],
        variantParameters: [{ name: "variants_count", rangeOrValues: "1..8", purpose: "Concepts" }],
        requiredIntegrations: { mcp: ["metamcp"], plugins: ["image-studio"], skills: [] },
        graphs: [],
      },
      candidates: makeSuiteCandidates(),
      collected: { status: "ready", clusters: [], deltas: [], deltaIds: [] },
      runRole: async (_role, prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          verdict: "rework",
          findings: [{ workflowId: "site-strategy-cta", detail: "Missing archetype output" }],
          mustFix: [{ scope: "Suite contracts", action: "Forward homepage_archetype to variants phase" }],
        });
      },
    });
    expect(prompts[0]).toContain("WORKFLOW_REFERENCE");
    expect(prompts[0]).toContain("nodeSchema is .strict()");
    expect(verdict.verdict).toBe("rework");
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.mustFix).toHaveLength(1);
    expect(verdict.mustFix[0]).toContain("homepage_archetype");
  });
});

describe("Operator-driven multi-day convergence, companion skills, and auditVerdict gate", () => {
  const websitesCategory = { id: "websites", label: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" } };

  function makeTempSkillsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lp-graph-evolve-skills-"));
    tempDirs.push(dir);
    return dir;
  }

  function makeSiteUikitDef(opts: {
    extraInputs?: Record<string, unknown>;
    extraPromptRule?: string;
    skills?: string[];
  } = {}): Record<string, unknown> {
    const promptLines = [
      "Build CTA conversion map and responsive UI kit for {{$inputs.goal}} ({{$inputs.project_archetype}}).",
      ...(opts.extraPromptRule ? [opts.extraPromptRule] : []),
    ];
    return {
      id: "site-uikit",
      version: 1,
      category: websitesCategory,
      name: { en: "Site UI Kit & CTA", ru: "UI-кит и карта CTA сайта" },
      description: {
        en: "Creates conversion CTA map and reusable UI kit for {{$inputs.project_archetype}}.",
        ru: "Создаёт карту CTA и переиспользуемый UI-кит для {{$inputs.project_archetype}}.",
      },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        goal: { type: "string", required: true, description: "Website goal" },
        project_archetype: { type: "string", default: "personal-brand", description: "Domain archetype overlay slug" },
        variants_count: { type: "int", default: 3, description: "Visual directions to explore" },
        ...(opts.extraInputs ?? {}),
      },
      outputs: { status: "done|blocked", uikit_summary: "string" },
      goal_check: "artifact",
      requires: { plugins: ["lane-pilot", "image-studio"], skills: opts.skills ?? [], secrets: [], machines: [] },
      nodes: [
        {
          id: "craft_uikit",
          type: "agent",
          role: "specialist:design-lead",
          ...(opts.skills?.length ? { skills: opts.skills } : {}),
          mcp: ["metamcp"],
          plugins: ["image-studio"],
          title: { en: "Craft CTA map & UI kit", ru: "Собрать карту CTA и UI-кит" },
          prompt: promptLines.join("\n"),
          out: { status: "done|blocked", uikit_summary: "string", handoff: "string" },
        },
        {
          id: "approve_uikit",
          type: "human",
          title: { en: "Approve UI kit", ru: "Утвердить UI-кит" },
          question: "Approve generated UI kit direction?",
          options: ["approve", "abort"],
          out: { answer: "string", answer_kind: "approve|abort" },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "craft_uikit.status", uikit_summary: "craft_uikit.uikit_summary" },
        },
      ],
      edges: [
        { from: "start", to: "craft_uikit" },
        { from: "craft_uikit", to: "approve_uikit" },
        { from: "approve_uikit", to: "done" },
      ],
      test: {
        id: "site-uikit-sim",
        sim: {
          input: { goal: "Launch website", project_archetype: "personal-brand", variants_count: 3 },
          stubs: { craft_uikit: { status: "done", uikit_summary: "CTA map & UI kit approved", handoff: "Ready" } },
          human_answers: { approve_uikit: "approve" },
          expect_path: ["craft_uikit", "approve_uikit", "done"],
          expect_status: "succeeded",
          expect_output: { status: "done" },
        },
      },
    };
  }

  function makeSiteSuiteDef(): Record<string, unknown> {
    return {
      id: "site-suite",
      version: 1,
      category: websitesCategory,
      name: { en: "Site Delivery Suite", ru: "Сюит разработки сайта" },
      description: {
        en: "Orchestrates universal website UI kit and archetype delivery for {{$inputs.project_archetype}}.",
        ru: "Оркестрирует универсальный UI-кит и сборку сайта для {{$inputs.project_archetype}}.",
      },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        goal: { type: "string", required: true, description: "Website goal" },
        project_archetype: { type: "string", default: "personal-brand", description: "Domain archetype overlay slug" },
        variants_count: { type: "int", default: 3, description: "Visual directions to explore" },
      },
      outputs: { status: "done|blocked", summary: "string" },
      goal_check: "artifact",
      requires: { plugins: ["lane-pilot"], skills: [], secrets: [], machines: [] },
      nodes: [
        {
          id: "uikit_phase",
          type: "subworkflow",
          workflow: "site-uikit",
          title: { en: "Phase 1: UI Kit & CTA", ru: "Фаза 1: UI-кит и CTA" },
          inputs: {
            goal: "{{$inputs.goal}}",
            project_archetype: "{{$inputs.project_archetype}}",
            variants_count: "{{$inputs.variants_count}}",
          },
          out: { status: "done|blocked", uikit_summary: "string" },
          guards: { maxVisits: 1 },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "uikit_phase.status", summary: "uikit_phase.uikit_summary" },
        },
      ],
      edges: [
        { from: "start", to: "uikit_phase" },
        { from: "uikit_phase", to: "done" },
      ],
      test: {
        id: "site-suite-sim",
        sim: {
          input: { goal: "Launch website", project_archetype: "personal-brand", variants_count: 3 },
          stubs: { uikit_phase: { status: "done", uikit_summary: "CTA map & UI kit approved" } },
          expect_path: ["uikit_phase", "done"],
          expect_status: "succeeded",
          expect_output: { status: "done", summary: "CTA map & UI kit approved" },
        },
      },
    };
  }

  it("converges Personal Site v1 -> E-commerce v2 -> Fachwerk Landing v3 via patch_converge, retires legacy pbs-brief, and preserves golden skeleton & archetype overlays", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const tempWorkflows = makeTempGlobalDir();
    const tempSkills = makeTempSkillsDir();
    let clock = 1_760_300_000_000;
    const now = () => {
      clock += 1_000;
      return clock;
    };
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    // Seed legacy narrow global workflow pbs-brief.json
    const legacyBrief = JSON.stringify({ id: "pbs-brief", version: 1, status: "published", name: { en: "Legacy PBS Brief", ru: "Устаревший бриф PBS" } }, null, 2);
    writeFileSync(join(tempWorkflows, "pbs-brief.json"), legacyBrief, "utf8");

    // Day 1: VECHKASOV.RU-shaped masked digest (personal-brand)
    savePilotDayDigest(db, {
      digestId: "pdigest_site_day1",
      dayKey: "2026-11-18",
      sourceKind: "pilot_run",
      sourceId: "run_site_day1",
      projectId: "proj_site_conv",
      outcome: "done",
      processKey: "websites|site-suite",
      categoryHint: websitesCategory,
      archetypeHint: "personal-brand",
      taskCount: 3,
      skills: ["impeccable-ui", "ru-text"],
      traps: ["Map CTA before visual tokens"],
      maskedGoal: "Build site CTA map and UI kit for [domain]",
      maskedLessons: ["Approve UI kit and CTA map before building full templates"],
      artifactSkeleton: {
        deliverableClass: "ui-kit-spec",
        sections: ["CTA & Conversion Map", "UI Kit Tokens & Components", "Responsive Layout Grid"],
        matrices: ["Section Conversion Matrix"],
        qaChecks: ["Verify 375px and 1280px states"],
      },
      createdAt: now(),
    });

    const collected1 = collectGraphEvolveEvidence(db, { projectId: "proj_site_conv", now, log });
    expect(collected1.status).toBe("ready");
    expect(collected1.clusters[0]?.processKey).toBe("websites|site-suite");
    expect(collected1.clusters[0]?.archetypeHints).toEqual(["personal-brand"]);

    const baseCatalog: EvolveCatalogContext = {
      knownCategories: [{ id: "code" }, { id: "seo" }, websitesCategory],
      existingGlobal: [{ id: "pbs-brief", version: 1, title: { en: "Legacy PBS Brief", ru: "Устаревший бриф PBS" }, category: websitesCategory }],
      reservedBuiltinIds: ["seo-page", "lp.graph-evolve-nightly"],
      availableSkills: ["impeccable-ui", "ru-text"],
      availablePlugins: ["image-studio", "browser-automation"],
      availableMcp: ["metamcp"],
    };

    const day1Blueprint = {
      operator: "create_suite",
      decision: "suite_or_structural",
      rationale: "Converge narrow pbs-* brief into universal websites suite and companion skill",
      category: websitesCategory,
      supersededWorkflowIds: ["pbs-brief"],
      orderInvariants: ["CTA conversion map before UI kit visual design"],
      variantParameters: [{ name: "variants_count", rangeOrValues: "1..6", purpose: "Explore multiple visual concepts" }],
      requiredIntegrations: { mcp: ["metamcp"], plugins: ["image-studio"], skills: ["site-uikit-standard"] },
      graphs: [
        {
          workflowId: "site-uikit",
          kind: "phase_graph",
          name: { en: "Site UI Kit & CTA", ru: "UI-кит и карта CTA сайта" },
          description: { en: "Builds CTA map and UI kit", ru: "Строит карту CTA и UI-кит" },
          dependsOnGraphs: [],
          inputs: { goal: "string", project_archetype: "string", variants_count: "int" },
          outputs: { status: "done|blocked", uikit_summary: "string" },
          stages: [
            {
              id: "craft_uikit",
              nodeType: "agent",
              role: "specialist:design-lead",
              purpose: "Craft CTA map and responsive UI kit",
              skills: ["site-uikit-standard"],
              mcp: ["metamcp"],
              plugins: ["image-studio"],
              contractRules: ["Follow golden skeleton sections"],
            },
          ],
          acceptanceCriteria: ["Approved UI kit and CTA map"],
        },
        {
          workflowId: "site-suite",
          kind: "master_orchestrator",
          name: { en: "Site Delivery Suite", ru: "Сюит разработки сайта" },
          description: { en: "Orchestrates universal website delivery", ru: "Оркестрирует разработку сайта" },
          dependsOnGraphs: ["site-uikit"],
          inputs: { goal: "string", project_archetype: "string", variants_count: "int" },
          outputs: { status: "done|blocked", summary: "string" },
          stages: [
            { id: "uikit_phase", nodeType: "subworkflow", subworkflowId: "site-uikit", purpose: "Run UI kit phase", skills: [], mcp: [], plugins: [], contractRules: [] },
          ],
          acceptanceCriteria: ["UI kit phase completes"],
        },
      ],
      companionSkills: [
        {
          skillId: "site-uikit-standard",
          workflowIds: ["site-uikit"],
          mergeMode: "create_bundle",
          summary: "Universal website UI kit and CTA conversion specification standard.",
          whenToUse: "Use when designing website UI kits, conversion maps, or responsive component specs.",
          whenNotToUse: "Do not use for backend services or non-web CLI tools.",
          coreRules: [
            "Build the CTA & conversion map before defining visual tokens and components.",
            "Verify 375px mobile and 1280px desktop breakpoints before approval.",
          ],
          goldenSkeletonSections: [
            "CTA & Conversion Map",
            "UI Kit Tokens & Components",
            "Responsive Layout Grid",
          ],
          qaRubricChecks: [
            "CTA & conversion map precedes visual token definitions.",
            "375px mobile and 1280px desktop component states pass contrast checks.",
          ],
          archetypeOverlays: [
            {
              slug: "personal-brand",
              title: "Expert Authority Site",
              whenToUse: "applying this process to an expert or founder personal-brand website",
              rules: [
                "Lead above the fold with positioning statement, proof metrics, and one primary consultation CTA.",
              ],
            },
          ],
        },
      ],
    };

    const runDay1: EvolveRoleRunner = async (role) => {
      if (role === "planner") return JSON.stringify(day1Blueprint);
      if (role === "plan-critic" || role === "auditor") return JSON.stringify({ verdict: "pass", findings: [], mustFix: [] });
      const uikitDef = makeSiteUikitDef();
      const suiteDef = makeSiteSuiteDef();
      return JSON.stringify({
        candidates: [
          { workflowId: "site-suite", scope: "global", name: suiteDef.name, description: suiteDef.description, category: websitesCategory, definition: suiteDef },
          { workflowId: "site-uikit", scope: "global", name: uikitDef.name, description: uikitDef.description, category: websitesCategory, definition: uikitDef },
        ],
      });
    };

    const bp1 = await planEvolutionBlueprint({ collected: collected1, catalog: baseCatalog, runRole: runDay1, iteration: 1, log });
    expect(bp1.operator).toBe("create_suite");
    const crit1 = await critiqueEvolutionBlueprint({ blueprint: bp1, collected: collected1, catalog: baseCatalog, runRole: runDay1, iteration: 1, log });
    expect(crit1.verdict).toBe("pass");

    const synth1 = await synthesizeSuiteAndSkillsFromBlueprint({ blueprint: bp1, collected: collected1, catalog: baseCatalog, runRole: runDay1, iteration: 1, log });
    const aud1 = await auditSynthesizedSuite({
      blueprint: bp1, candidates: synth1.candidates, companionSkills: synth1.companionSkills, collected: collected1, runRole: runDay1, iteration: 1, log,
    });
    expect(aud1.verdict).toBe("pass");

    const applied1 = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, knownContext: { knownDomains: ["vechkasov.ru"] }, now, log },
      synth1.candidates,
      {
        publishApprovedSuite: true,
        auditVerdict: aud1.verdict,
        companionSkills: synth1.companionSkills,
        operator: bp1.operator,
        supersededWorkflowIds: synth1.supersededWorkflowIds,
      },
    );
    expect(applied1.publishedCount).toBe(2);
    expect(applied1.rejectedCount).toBe(0);
    expect(existsSync(join(tempWorkflows, "pbs-brief.json"))).toBe(false);
    expect(readdirSync(tempWorkflows).sort()).toEqual(["site-suite.json", "site-uikit.json"]);

    const uikitDisk1 = JSON.parse(readFileSync(join(tempWorkflows, "site-uikit.json"), "utf8")) as {
      version: number;
      category: { id: string };
      nodes: Array<{ id: string; skills?: string[] }>;
    };
    expect(uikitDisk1.version).toBe(1);
    expect(uikitDisk1.category.id).toBe("websites");
    expect(uikitDisk1.nodes.find((n) => n.id === "craft_uikit")?.skills).toContain("site-uikit-standard");

    const uikitDraftId = applied1.outcomes.find((o) => o.workflowId === "site-uikit")!.draftId!;
    const day1Ledger = listSkillEvolutionsForDraft(db, uikitDraftId, { status: "published" });
    expect(day1Ledger.some((r) => r.skillId === "site-uikit-standard" && r.supersededWorkflowIds.includes("pbs-brief"))).toBe(true);

    const skillDir = join(tempSkills, "site-uikit-standard");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "references", "golden-skeleton.md"))).toBe(true);
    expect(existsSync(join(skillDir, "references", "qa-rubric.md"))).toBe(true);
    expect(existsSync(join(skillDir, "references", "archetype-personal-brand.md"))).toBe(true);
    expect(lintSkillDir(readSkillDir(skillDir)).errors).toEqual([]);

    // Day 2: E-commerce chat with Competitor Structure Matrix -> patch_converge (v1 -> v2)
    savePilotDayDigest(db, {
      digestId: "pdigest_site_day2",
      dayKey: "2026-11-19",
      sourceKind: "pilot_run",
      sourceId: "run_site_day2",
      projectId: "proj_site_conv",
      outcome: "done",
      processKey: "websites|site-suite",
      categoryHint: websitesCategory,
      archetypeHint: "ecommerce",
      taskCount: 3,
      skills: ["site-uikit-standard", "impeccable-ui"],
      traps: ["Compare >= 3 competitor funnels before sketching catalog cards"],
      maskedGoal: "Design catalog storefront UI kit with competitor structure matrix",
      maskedLessons: ["Elevate Competitor Structure Matrix into core website UI kit skeleton"],
      artifactSkeleton: {
        deliverableClass: "ui-kit-spec",
        sections: ["Competitor Structure Matrix", "Catalog & PDP Card System"],
        matrices: ["Competitor Structure Matrix"],
        qaChecks: ["Competitor Structure Matrix compares at least 3 peers"],
      },
      createdAt: now(),
    });

    const collected2 = collectGraphEvolveEvidence(db, { projectId: "proj_site_conv", now, log });
    const existingDay2 = await readExistingCompanionSkills(tempSkills);
    const catalog2: EvolveCatalogContext = {
      ...baseCatalog,
      existingGlobal: [
        { id: "site-uikit", version: 1, title: { en: "Site UI Kit & CTA", ru: "UI-кит и карта CTA сайта" }, category: websitesCategory },
        { id: "site-suite", version: 1, title: { en: "Site Delivery Suite", ru: "Сюит разработки сайта" }, category: websitesCategory },
      ],
      existingCompanionSkills: existingDay2.existingCompanionSkills,
    };

    const day2Blueprint = {
      operator: "patch_converge",
      decision: "minor_patch",
      rationale: "Converge ecommerce teardown insights into existing site-uikit & site-uikit-standard without cloning",
      category: websitesCategory,
      supersededWorkflowIds: [],
      orderInvariants: ["Competitor Structure Matrix and CTA conversion map before visual tokens"],
      variantParameters: [{ name: "variants_count", rangeOrValues: "1..6", purpose: "Explore multiple visual concepts" }],
      requiredIntegrations: { mcp: ["metamcp"], plugins: ["image-studio"], skills: ["site-uikit-standard"] },
      graphs: [
        {
          workflowId: "site-uikit",
          kind: "phase_graph",
          name: { en: "Site UI Kit & CTA", ru: "UI-кит и карта CTA сайта" },
          description: { en: "Builds competitor matrix, CTA map, and UI kit", ru: "Строит матрицу конкурентов, карту CTA и UI-кит" },
          dependsOnGraphs: [],
          inputs: { goal: "string", project_archetype: "string", variants_count: "int", competitor_teardown: "string" },
          outputs: { status: "done|blocked", uikit_summary: "string" },
          stages: [
            {
              id: "craft_uikit",
              nodeType: "agent",
              role: "specialist:design-lead",
              purpose: "Include Competitor Structure Matrix before UI kit tokens",
              skills: ["site-uikit-standard"],
              mcp: ["metamcp"],
              plugins: ["image-studio"],
              contractRules: ["Complete Competitor Structure Matrix first"],
            },
          ],
          acceptanceCriteria: ["Competitor matrix and UI kit approved"],
        },
      ],
      companionSkills: [
        {
          skillId: "site-uikit-standard",
          workflowIds: ["site-uikit"],
          mergeMode: "merge_core_and_overlay",
          summary: "Universal website UI kit and CTA conversion specification standard.",
          whenToUse: "Use when designing website UI kits, conversion maps, or responsive component specs across archetypes.",
          whenNotToUse: "Do not use for backend services or non-web CLI tools.",
          coreRules: [
            "Complete the Competitor Structure Matrix comparing >= 3 peers before sketching layout blocks.",
          ],
          goldenSkeletonSections: [
            "Competitor Structure Matrix",
          ],
          qaRubricChecks: [
            "Competitor Structure Matrix compares at least 3 peer sites with CTA and fold notes.",
          ],
          archetypeOverlays: [
            {
              slug: "ecommerce",
              title: "Storefront & Catalog Archetype",
              whenToUse: "applying this process to an ecommerce catalog or storefront site",
              rules: [
                "Standardize faceted filter chips, quick-add cart states, and PDP trust badges inside the UI kit.",
              ],
            },
          ],
        },
      ],
    };

    const runDay2: EvolveRoleRunner = async (role) => {
      if (role === "planner") return JSON.stringify(day2Blueprint);
      if (role === "plan-critic" || role === "auditor") return JSON.stringify({ verdict: "pass", findings: [], mustFix: [] });
      const uikitV2 = makeSiteUikitDef({
        extraInputs: { competitor_teardown: { type: "string", default: "", note: "Optional competitor teardown notes" } },
        extraPromptRule: "Complete the Competitor Structure Matrix before drafting UI kit tokens.",
      });
      return JSON.stringify({
        candidates: [
          { workflowId: "site-uikit", scope: "global", name: uikitV2.name, description: uikitV2.description, category: websitesCategory, definition: uikitV2 },
        ],
      });
    };

    const bp2 = await planEvolutionBlueprint({ collected: collected2, catalog: catalog2, runRole: runDay2, iteration: 1, log });
    expect(bp2.operator).toBe("patch_converge");
    const crit2 = await critiqueEvolutionBlueprint({ blueprint: bp2, collected: collected2, catalog: catalog2, runRole: runDay2, iteration: 1, log });
    expect(crit2.verdict).toBe("pass");

    const synth2 = await synthesizeSuiteAndSkillsFromBlueprint({
      blueprint: bp2, collected: collected2, catalog: catalog2, runRole: runDay2, existingSkillBundles: existingDay2.existingSkillBundles, iteration: 1, log,
    });
    const aud2 = await auditSynthesizedSuite({
      blueprint: bp2, candidates: synth2.candidates, companionSkills: synth2.companionSkills, existingSkillBundles: existingDay2.existingSkillBundles, collected: collected2, runRole: runDay2, iteration: 1, log,
    });
    expect(aud2.verdict).toBe("pass");

    const applied2 = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, knownContext: { knownDomains: ["vechkasov.ru"] }, now, log },
      synth2.candidates,
      { auditVerdict: aud2.verdict, companionSkills: synth2.companionSkills, operator: bp2.operator },
    );
    expect(applied2.publishedCount).toBe(1);
    expect(applied2.outcomes[0]).toMatchObject({ workflowId: "site-uikit", kind: "minor_patch", status: "auto_published", version: 2 });
    expect(readdirSync(tempWorkflows).sort()).toEqual(["site-suite.json", "site-uikit.json"]);

    const skeletonDay2 = readFileSync(join(skillDir, "references", "golden-skeleton.md"), "utf8");
    expect(skeletonDay2).toContain("CTA & Conversion Map");
    expect(skeletonDay2).toContain("UI Kit Tokens & Components");
    expect(skeletonDay2).toContain("Responsive Layout Grid");
    expect(skeletonDay2).toContain("Competitor Structure Matrix");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("Competitor Structure Matrix");
    expect(existsSync(join(skillDir, "references", "archetype-personal-brand.md"))).toBe(true);
    expect(existsSync(join(skillDir, "references", "archetype-ecommerce.md"))).toBe(true);
    expect(lintSkillDir(readSkillDir(skillDir)).errors).toEqual([]);

    // Day 3: High-ticket construction/architectural landing (Fachwerk Houses) -> patch_converge (v2 -> v3)
    savePilotDayDigest(db, {
      digestId: "pdigest_site_day3",
      dayKey: "2026-11-20",
      sourceKind: "pilot_run",
      sourceId: "run_site_day3",
      projectId: "proj_site_conv",
      outcome: "done",
      processKey: "websites|site-suite",
      categoryHint: websitesCategory,
      archetypeHint: "high-ticket-leadgen",
      taskCount: 3,
      skills: ["site-uikit-standard"],
      traps: ["Pair high-ticket estimation calculator with architectural proof gallery"],
      maskedGoal: "Design high-ticket architectural housing landing UI kit",
      maskedLessons: ["Add high-ticket-leadgen archetype overlay without duplicating site-uikit"],
      artifactSkeleton: {
        deliverableClass: "ui-kit-spec",
        sections: ["Competitor Structure Matrix", "CTA & Conversion Map"],
        matrices: ["Qualification Calculator Matrix"],
        qaChecks: ["Verify project-qualification lead form states"],
      },
      createdAt: now(),
    });

    const collected3 = collectGraphEvolveEvidence(db, { projectId: "proj_site_conv", now, log });
    const existingDay3 = await readExistingCompanionSkills(tempSkills);
    const catalog3: EvolveCatalogContext = {
      ...catalog2,
      existingGlobal: [
        { id: "site-uikit", version: 2, title: { en: "Site UI Kit & CTA", ru: "UI-кит и карта CTA сайта" }, category: websitesCategory },
        { id: "site-suite", version: 1, title: { en: "Site Delivery Suite", ru: "Сюит разработки сайта" }, category: websitesCategory },
      ],
      existingCompanionSkills: existingDay3.existingCompanionSkills,
    };

    const day3Blueprint = {
      ...day2Blueprint,
      rationale: "Add high-ticket-leadgen archetype overlay while keeping Day 1/2 core and overlays intact",
      graphs: [
        {
          ...day2Blueprint.graphs[0]!,
          inputs: { ...day2Blueprint.graphs[0]!.inputs, trust_proof_pack: "string" },
        },
      ],
      companionSkills: [
        {
          ...day2Blueprint.companionSkills[0]!,
          coreRules: ["Require verifiable engineering or craftsmanship proof adjacent to high-ticket lead forms."],
          goldenSkeletonSections: [],
          qaRubricChecks: ["High-ticket lead form includes transparent project budget/timeline steps."],
          archetypeOverlays: [
            {
              slug: "high-ticket-leadgen",
              title: "High-Ticket Leadgen Landing",
              whenToUse: "applying this process to high-ticket custom builds or architectural leadgen landings",
              rules: [
                "Combine interactive project estimate / qualification steps with site-visit booking CTA.",
              ],
            },
          ],
        },
      ],
    };

    const runDay3: EvolveRoleRunner = async (role) => {
      if (role === "planner") return JSON.stringify(day3Blueprint);
      if (role === "plan-critic" || role === "auditor") return JSON.stringify({ verdict: "pass", findings: [], mustFix: [] });
      const uikitV3 = makeSiteUikitDef({
        extraInputs: {
          competitor_teardown: { type: "string", default: "", note: "Optional competitor teardown notes" },
          trust_proof_pack: { type: "string", default: "", note: "Optional engineering proof references" },
        },
        extraPromptRule: "Complete the Competitor Structure Matrix and verify high-ticket proof elements.",
      });
      return JSON.stringify({
        candidates: [
          { workflowId: "site-uikit", scope: "global", name: uikitV3.name, description: uikitV3.description, category: websitesCategory, definition: uikitV3 },
        ],
      });
    };

    const bp3 = await planEvolutionBlueprint({ collected: collected3, catalog: catalog3, runRole: runDay3, iteration: 1, log });
    const crit3 = await critiqueEvolutionBlueprint({ blueprint: bp3, collected: collected3, catalog: catalog3, runRole: runDay3, iteration: 1, log });
    expect(crit3.verdict).toBe("pass");

    const synth3 = await synthesizeSuiteAndSkillsFromBlueprint({
      blueprint: bp3, collected: collected3, catalog: catalog3, runRole: runDay3, existingSkillBundles: existingDay3.existingSkillBundles, iteration: 1, log,
    });
    const aud3 = await auditSynthesizedSuite({
      blueprint: bp3, candidates: synth3.candidates, companionSkills: synth3.companionSkills, existingSkillBundles: existingDay3.existingSkillBundles, collected: collected3, runRole: runDay3, iteration: 1, log,
    });
    expect(aud3.verdict).toBe("pass");

    const applied3 = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, knownContext: { knownDomains: ["vechkasov.ru"] }, now, log },
      synth3.candidates,
      { auditVerdict: aud3.verdict, companionSkills: synth3.companionSkills, operator: bp3.operator },
    );
    expect(applied3.publishedCount).toBe(1);
    expect(applied3.outcomes[0]).toMatchObject({ workflowId: "site-uikit", kind: "minor_patch", status: "auto_published", version: 3 });
    expect(readdirSync(tempWorkflows).sort()).toEqual(["site-suite.json", "site-uikit.json"]);

    const skeletonDay3 = readFileSync(join(skillDir, "references", "golden-skeleton.md"), "utf8");
    expect(skeletonDay3).toContain("CTA & Conversion Map");
    expect(skeletonDay3).toContain("Competitor Structure Matrix");
    expect(existsSync(join(skillDir, "references", "archetype-personal-brand.md"))).toBe(true);
    expect(existsSync(join(skillDir, "references", "archetype-ecommerce.md"))).toBe(true);
    expect(existsSync(join(skillDir, "references", "archetype-high-ticket-leadgen.md"))).toBe(true);
    expect(lintSkillDir(readSkillDir(skillDir)).errors).toEqual([]);
  });

  it("holds minor_patch + companion skill update in proposed_tested when auditVerdict is rework (held_without_audit_pass)", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const tempWorkflows = makeTempGlobalDir();
    const tempSkills = makeTempSkillsDir();
    let clock = 1_760_400_000_000;
    const now = () => {
      clock += 1_000;
      return clock;
    };
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    // Seed v1 workflow + v1 companion skill on disk via approved publish
    const v1Def = makeSiteUikitDef({ skills: ["site-uikit-standard"] });
    const v1Skill = {
      skillId: "site-uikit-standard",
      workflowIds: ["site-uikit"],
      mergeMode: "create_bundle" as const,
      files: [
        {
          path: "SKILL.md",
          text: [
            "---",
            "name: site-uikit-standard",
            'description: "Universal website UI kit standard. Use when designing site UI kits. Do not use for backend APIs."',
            "---",
            "",
            "# site-uikit-standard",
            "",
            "## Core Rules",
            "",
            "- Build CTA & conversion map before visual tokens.",
            "",
            "## References",
            "",
            "- [Golden Skeleton](references/golden-skeleton.md)",
            "- [QA Rubric](references/qa-rubric.md)",
            "",
          ].join("\n"),
        },
        {
          path: "references/golden-skeleton.md",
          text: "# Golden Skeleton: site-uikit-standard\n\n## 1. CTA & Conversion Map\n\nV1 baseline section.\n",
        },
        {
          path: "references/qa-rubric.md",
          text: "# QA Rubric: site-uikit-standard\n\n- [ ] Verify CTA map.\n",
        },
      ],
    };

    const seedRes = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, now, log },
      [{ workflowId: "site-uikit", scope: "global", name: v1Def.name as { en: string; ru: string }, description: v1Def.description as { en: string; ru: string }, category: websitesCategory, definition: v1Def }],
      { publishApprovedSuite: true, auditVerdict: "pass", companionSkills: [v1Skill], operator: "create_suite" },
    );
    expect(seedRes.publishedCount).toBe(1);

    // Attempt minor_patch v2 with auditVerdict: "rework"
    const v2Def = makeSiteUikitDef({
      skills: ["site-uikit-standard"],
      extraInputs: { extra_audit_note: { type: "string", default: "", note: "Optional note" } },
      extraPromptRule: "V2 extra prompt guidance.",
    });
    const v2Skill = {
      skillId: "site-uikit-standard",
      workflowIds: ["site-uikit"],
      mergeMode: "merge_core_and_overlay" as const,
      files: [
        ...v1Skill.files.filter((f) => f.path !== "references/golden-skeleton.md"),
        {
          path: "references/golden-skeleton.md",
          text: "# Golden Skeleton: site-uikit-standard\n\n## 1. CTA & Conversion Map\n\nV1 baseline section.\n\n## 2. V2 Held Section\n\nMust stay staged until audit passes.\n",
        },
      ],
    };

    const heldRes = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, now, log },
      [{ workflowId: "site-uikit", scope: "global", name: v2Def.name as { en: string; ru: string }, description: v2Def.description as { en: string; ru: string }, category: websitesCategory, definition: v2Def }],
      { auditVerdict: "rework", companionSkills: [v2Skill], operator: "patch_converge" },
    );

    expect(heldRes.publishedCount).toBe(0);
    expect(heldRes.proposedCount).toBe(1);
    expect(heldRes.rejectedCount).toBe(0);
    expect(heldRes.outcomes[0]).toMatchObject({ workflowId: "site-uikit", kind: "minor_patch", status: "proposed_tested" });

    const wfOnDisk = JSON.parse(readFileSync(join(tempWorkflows, "site-uikit.json"), "utf8")) as {
      version: number;
      inputs: Array<{ name: string }>;
    };
    expect(wfOnDisk.version).toBe(1);
    expect(wfOnDisk.inputs.some((i) => i.name === "extra_audit_note")).toBe(false);

    const skeletonOnDisk = readFileSync(join(tempSkills, "site-uikit-standard", "references", "golden-skeleton.md"), "utf8");
    expect(skeletonOnDisk).not.toContain("V2 Held Section");

    const stagedRows = listSkillEvolutionsForDraft(db, heldRes.outcomes[0]!.draftId!, { draftVersion: heldRes.outcomes[0]!.version!, status: "staged" });
    expect(stagedRows).toHaveLength(1);
    expect(stagedRows[0]!.skillId).toBe("site-uikit-standard");
    expect(stagedRows[0]!.candidateFiles.find((f) => f.path === "references/golden-skeleton.md")?.text).toContain("V2 Held Section");

    expect(logs.some((line) => line.includes("INFO [nightGraphs.graphEvolve] held_without_audit_pass"))).toBe(true);
  });
});
