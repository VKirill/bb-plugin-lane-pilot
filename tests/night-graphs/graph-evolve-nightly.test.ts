import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import {
  createDraftStore,
  createStatusResolver,
  definitionSha256,
  loadWorkflow,
  runDraftTest,
  testCasesOf,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import { recordTrajectoryDelta } from "../../src/rooms/errands";
import { checkDeprojectization, classifyEvolutionDiff } from "../../src/rooms/night-graphs";
import { applyGraphEvolveCandidates, collectGraphEvolveEvidence } from "../../src/rooms/night-graphs/server";
import { collectOwnerWaiting, listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { openDatabase } from "../../src/rooms/plugin-db";
import { createWorkflowArchitect } from "../../src/rooms/workflow/server";
import type { ServerCore } from "../../src/rooms/contracts/server";

const tempDirs: string[] = [];

function makeTempGlobalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-graph-evolve-"));
  tempDirs.push(dir);
  return dir;
}

function makeLandingWorkflow(overrides: {
  id?: string;
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
});
