import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createDraftStore,
  globalWorkflowDir,
  loadWorkflow,
  runDraftTest,
  testCasesOf,
} from "@lane-pilot/workflow-engine";
import { HARNESS_VERSION, listSkillEvolutionsForDraft } from "../../src/rooms/storage";
import { coreRequiredSessionAdvertisement } from "../../src/rooms/contracts";
import { lintSkillDir, readSkillDir } from "../../src/rooms/forge/skill-lint";
import { applyGraphEvolveCandidates } from "../../src/rooms/night-graphs/server";
import { renderCompanionSkillBundle } from "../../src/rooms/night-graphs/server/companion-skill-merge";
import { listOpenOwnerItems, postOwnerItem } from "../../src/rooms/owner-waiting";
import { openDatabase, type RunRow } from "../../src/rooms/plugin-db";
import {
  PILOT_PROCESS_STATE_REL_PATH,
  buildPilotActionPrompt,
  readPilotProcessStateCas,
  setCachedProcessState,
  writePilotProcessStateCas,
  type PilotProcessState,
} from "../../src/rooms/pilot-panel";
import {
  createPilotPanelService,
  pilotPanelRpc,
} from "../../src/rooms/pilot-panel/server";
import {
  createProcessStateIo,
  publishPanelWorkflowDraft,
  rollbackPanelWorkflowDraft,
} from "../../src/rooms/pilot-panel/server/workflow-drafts";
import { createWorkflowArchitect } from "../../src/rooms/workflow/server";
import { maybeNotifyWorkflowRun, notifyWorkflowIfEnded } from "../../src/rooms/workflow/server/pm-notice";
import type { ServerCore } from "../../src/rooms/contracts/server";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTempWorkspace(): string {
  const dir = createTempDir("lp-pilot-evo-ws-");
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function makeWorkflowDef(id: string, prompt: string): Record<string, unknown> {
  return {
    id,
    name: { en: `Flow ${id}`, ru: `Поток ${id}` },
    description: { en: `Description for ${id}`, ru: `Описание ${id}` },
    inputs: { target_domain: { type: "string", default: "example.com", note: "Target domain" } },
    outputs: { status: "done|blocked", summary: "string" },
    goal_check: "artifact",
    requires: { plugins: ["lane-pilot"], skills: [], secrets: [], machines: [] },
    nodes: [
      {
        id: "draft_page",
        type: "agent",
        role: "analyst",
        produces: [{ kind: "report", version: 1 }],
        profile: { skills: [] },
        title: { en: "Draft", ru: "Черновик" },
        prompt,
        out: { handoff: "string", status: "done|blocked" },
      },
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { status: "draft_page.status", summary: "draft_page.handoff" },
      },
    ],
    edges: [
      { from: "start", to: "draft_page" },
      { from: "draft_page", to: "done" },
    ],
    test: {
      id: `${id}-sim`,
      sim: {
        input: { target_domain: "example.com" },
        stubs: { draft_page: { handoff: "Prepared", status: "done" } },
        expect_path: ["draft_page", "done"],
        expect_status: "succeeded",
        expect_output: { status: "done" },
      },
    },
  };
}

function createEvolutionHarness(rootPath: string) {
  const logs: string[] = [];
  const realtimeSignals: Array<{ projectId: string; kind: string; threadId?: string; id?: string }> = [];
  const advertised = coreRequiredSessionAdvertisement();
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: "Evolution Repo",
          sources: [{ id: "src_1", hostId: "host_local", path: rootPath, isDefault: true }],
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          projectId: "proj_evo",
          hostId: "host_local",
          path: rootPath,
        }),
        list: async () => [{ id: "env_evo", projectId: "proj_evo", hostId: "host_local", path: rootPath }],
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          projectId: "proj_evo",
          environmentId: "env_evo",
          providerId: "claude-code",
          status: "idle",
          runtime: { displayStatus: "idle" },
          pendingQuestionsCount: 0,
        }),
        getPluginMetadata: async () => ({}),
        list: async () => [],
      },
      providers: {
        list: async () => [{ id: "claude-code", displayName: "Claude Code", available: true }],
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

  (bb as unknown as { agents: Record<string, unknown> }).agents = {
    experimental_vkRequiredSessionPolicy: () => advertised,
  };

  const host = {
    call: async (_method: string, params: { cwd: string; command: string }) => {
      const out = execFileSync("bash", ["-lc", params.command], { cwd: params.cwd, encoding: "utf8" });
      return { exitCode: 0, stdout: out, stderr: "", timedOut: false };
    },
  };

  const db = openDatabase(bb);
  const ctx = {
    bb,
    db,
    host,
    log: (msg: string) => logs.push(msg),
    realtime: {
      notify: (projectId: string, kind: string, threadId?: string, id?: string) => {
        realtimeSignals.push({ projectId, kind, threadId, id });
      },
    },
  } as unknown as ServerCore;

  return { ctx, db, logs, realtimeSignals };
}

beforeEach(() => {
  vi.stubEnv("HOME", createTempDir("lp-pilot-evo-home-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("pilot-panel process-state and workflow evolution RPC", () => {
  it("reads/writes process-state.json with CAS, reports corrupt JSON diagnostics, and enriches action prompts", async () => {
    const rootPath = createTempWorkspace();
    const { ctx, logs } = createEvolutionHarness(rootPath);
    setCachedProcessState(rootPath, null);
    const io = createProcessStateIo(ctx, "host_local", rootPath);

    const sampleState: PilotProcessState = {
      stage: "design-approved",
      workflowId: "universal-landing-flow",
      approvedDesignBaseline: {
        path: "docs/design/landing-v2.md",
        sha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        label: "Landing v2",
      },
      rejectedVariants: ["Dark gradient without contrast"],
      activeSkills: ["ru-text"],
      notes: "Keep calm tone",
      updatedAt: "2026-11-18T10:00:00.000Z",
    };

    const writeOk = await writePilotProcessStateCas(io, {
      hostId: "host_local",
      rootPath,
      state: sampleState,
      expectedSha256: null,
      log: ctx.log,
    });
    expect(writeOk.ok).toBe(true);

    // Writing again with stale null expectedSha256 yields a CAS conflict.
    const conflict = await writePilotProcessStateCas(io, {
      hostId: "host_local",
      rootPath,
      state: { ...sampleState, stage: "implementing" },
      expectedSha256: null,
      log: ctx.log,
    });
    expect(conflict).toMatchObject({ ok: false, conflict: true });

    const loaded = await readPilotProcessStateCas(io, { hostId: "host_local", rootPath, log: ctx.log });
    expect(loaded.state).toEqual(sampleState);
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);

    const service = createPilotPanelService(ctx);
    const snap = await service.status({ threadId: "thr_evo_1" });
    expect(snap.processState).toEqual(sampleState);

    const prompt = buildPilotActionPrompt("plan", snap);
    expect(prompt?.context).toContain("Контекст .agents/pilot/process-state.json:");
    expect(prompt?.context).toContain("Стадия процесса: design-approved");
    expect(prompt?.context).toContain("baseline=docs/design/landing-v2.md#a1b2c3d4");

    // Corrupt JSON produces a diagnostic entry in status.diagnostics and logs WARN.
    writeFileSync(join(rootPath, PILOT_PROCESS_STATE_REL_PATH), "{not-valid-json", "utf8");
    const corruptSnap = await service.status({ threadId: "thr_evo_1", force: true });
    expect(corruptSnap.processState).toBeNull();
    expect(corruptSnap.diagnostics).toContain("Повреждён .agents/pilot/process-state.json");
    expect(logs.some((line) => line.includes("WARN [pilotPanel.processState] invalid_json"))).toBe(true);
  });

  it("surfaces tested v1 and published v2 drafts in status and supports 1-click publish and rollback", async () => {
    const rootPath = createTempWorkspace();
    const { ctx, db, logs, realtimeSignals } = createEvolutionHarness(rootPath);
    const drafts = createDraftStore(db);

    const runStubTests = async (draftId: string) => {
      const d = drafts.get(draftId)!;
      const loaded = loadWorkflow(d.definition);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error("expected valid workflow");
      const results = [];
      for (const tc of testCasesOf(loaded.workflow)) {
        results.push(await runDraftTest({ db, harnessVersion: HARNESS_VERSION }, loaded.workflow, tc));
      }
      drafts.recordTests(d.id, d.version, results, true);
    };

    // 1) Tested v1 proposal awaiting owner approval.
    const v1Proposed = drafts.create({
      projectId: "proj_evo",
      threadId: null,
      scope: "global",
      name: { en: "New site archetype", ru: "Новый архетип сайта" },
      description: { en: "New universal graph", ru: "Новый универсальный граф" },
      workflowId: "new-site-archetype",
      definition: makeWorkflowDef("new-site-archetype", "Write copy for {{$inputs.target_domain}}."),
    });
    await runStubTests(v1Proposed.id);
    postOwnerItem(db, {
      key: `workflow-draft:${v1Proposed.id}:v1`,
      source: "night",
      kind: "workflow_draft_proposed",
      projectId: "proj_evo",
      what: "Предложен новый универсальный граф new-site-archetype",
      why: "Собран ночным циклом",
      wake: true,
    });

    // 2) Published v2 minor update with rollback history (v1 -> v2).
    const v2Draft = drafts.create({
      projectId: "*",
      threadId: null,
      scope: "global",
      name: { en: "Universal landing flow", ru: "Универсальный поток лендинга" },
      description: { en: "Landing flow", ru: "Поток лендинга" },
      workflowId: "universal-landing-flow",
      definition: makeWorkflowDef("universal-landing-flow", "V1 prompt for {{$inputs.target_domain}}."),
    });
    await runStubTests(v2Draft.id);
    const architect = createWorkflowArchitect(ctx, { workflowEngine: { hasExecutor: () => false } } as never);
    const pub1 = await architect.publish({ projectId: "*", draftId: v2Draft.id });
    expect(pub1.published).toBe(true);

    drafts.replaceDefinition(
      v2Draft.id,
      makeWorkflowDef("universal-landing-flow", "V2 minor prompt with extra guard for {{$inputs.target_domain}}."),
      "Утреннее обновление v1 -> v2: добавлен чек",
    );
    await runStubTests(v2Draft.id);
    const pub2 = await architect.publish({ projectId: "*", draftId: v2Draft.id });
    expect(pub2.published).toBe(true);
    postOwnerItem(db, {
      key: `workflow-evolved:${v2Draft.id}:v2`,
      source: "night",
      kind: "workflow_evolved_digest",
      projectId: "proj_evo",
      what: "Утреннее обновление v1 -> v2",
      why: "Минорный патч авто-опубликован",
      wake: false,
    });

    const rpc = pilotPanelRpc(ctx);
    const statusBefore = await rpc.pilot_panel_status({ threadId: "thr_evo_2" });
    expect(statusBefore.workflowEvolution?.pendingApprovalCount).toBe(1);
    expect(statusBefore.workflowEvolution?.autoPublishedCount).toBe(1);
    const proposedRow = statusBefore.workflowEvolution?.items.find((i) => i.draftId === v1Proposed.id);
    const evolvedRow = statusBefore.workflowEvolution?.items.find((i) => i.draftId === v2Draft.id);
    expect(proposedRow).toMatchObject({ status: "tested", testedGreen: true, canPublish: true, canRollback: false });
    expect(evolvedRow).toMatchObject({ status: "published", publishedVersion: 2, canPublish: false, canRollback: true });

    // 1-click publish closes workflow_draft_proposed owner item, writes to globalDir, and notifies realtime.
    const pubRes = await rpc.pilot_panel_publish_workflow_draft({ threadId: "thr_evo_2", draftId: v1Proposed.id });
    expect(pubRes.ok).toBe(true);
    expect(pubRes.message).toContain("new-site-archetype");
    expect(existsSync(join(globalWorkflowDir(), "new-site-archetype.json"))).toBe(true);
    expect(listOpenOwnerItems(db, {}).some((item) => item.key === `workflow-draft:${v1Proposed.id}:v1`)).toBe(false);
    expect(realtimeSignals.some((s) => s.kind === "workflow-draft" && s.id === v1Proposed.id)).toBe(true);
    expect(pubRes.snapshot?.workflowEvolution?.pendingApprovalCount).toBe(0);

    // 1-click rollback restores v2 -> v1, writes v1 content back to globalDir, and closes digest owner item.
    const rollbackRes = await rpc.pilot_panel_rollback_workflow_draft({ threadId: "thr_evo_2", draftId: v2Draft.id });
    expect(rollbackRes.ok).toBe(true);
    expect(rollbackRes.message).toContain("откачен");
    const rolledDisk = JSON.parse(readFileSync(join(globalWorkflowDir(), "universal-landing-flow.json"), "utf8")) as {
      nodes: Array<{ id: string; prompt?: string }>;
    };
    expect(rolledDisk.nodes.find((n) => n.id === "draft_page")?.prompt).toContain("V1 prompt");
    expect(listOpenOwnerItems(db, {}).some((item) => item.key === `workflow-evolved:${v2Draft.id}:v2`)).toBe(false);
    expect(realtimeSignals.some((s) => s.kind === "workflow-draft" && s.id === v2Draft.id)).toBe(true);

    // Failure diagnostics when draft is missing or has no prior version.
    const missingRes = await rpc.pilot_panel_rollback_workflow_draft({ threadId: "thr_evo_2", draftId: "wfd_missing" });
    expect(missingRes.ok).toBe(false);
    expect(missingRes.message).toContain("не найден");

    const noPrevRes = await rpc.pilot_panel_rollback_workflow_draft({ threadId: "thr_evo_2", draftId: v1Proposed.id });
    expect(noPrevRes.ok).toBe(false);
    expect(noPrevRes.message).toContain("Нет предыдущей версии");
    expect(logs.some((line) => line.includes("WARN [pilotPanel.workflowDrafts] rollback_unavailable"))).toBe(true);
  });

  it("preserves panel visibility and 1-click rollback to v1 after a rejected red candidate or pending structural proposal, and leaves uncited deltas unprocessed", async () => {
    const { applyGraphEvolveCandidates } = await import("../../src/rooms/night-graphs/server");
    const { recordTrajectoryDelta, listUnprocessedTrajectoryDeltas } = await import("../../src/rooms/errands");
    const rootPath = createTempWorkspace();
    const { ctx, db, logs } = createEvolutionHarness(rootPath);
    const drafts = createDraftStore(db);
    const architect = createWorkflowArchitect(ctx, { workflowEngine: { hasExecutor: () => false } } as never);
    const rpc = pilotPanelRpc(ctx);

    // Publish v1 ("V1 baseline prompt") -> auto-publish v2 ("V2 minor prompt").
    const seed = drafts.create({
      projectId: "*",
      threadId: null,
      scope: "global",
      name: { en: "Resilient landing flow", ru: "Устойчивый поток лендинга" },
      description: { en: "Landing flow", ru: "Поток лендинга" },
      workflowId: "resilient-landing-flow",
      definition: makeWorkflowDef("resilient-landing-flow", "V1 baseline prompt for {{$inputs.target_domain}}."),
    });
    const v1Loaded = loadWorkflow(seed.definition);
    if (!v1Loaded.ok) throw new Error("expected valid v1");
    const v1Tests = [];
    for (const tc of testCasesOf(v1Loaded.workflow)) {
      v1Tests.push(await runDraftTest({ db, harnessVersion: HARNESS_VERSION }, v1Loaded.workflow, tc));
    }
    drafts.recordTests(seed.id, seed.version, v1Tests, true);
    expect((await architect.publish({ projectId: "*", draftId: seed.id })).published).toBe(true);

    const dCited = recordTrajectoryDelta(db, {
      projectId: "proj_evo",
      workflowId: "resilient-landing-flow",
      stageArchetype: "copywriting",
      interventionKind: "skill_request",
      rawSummary: "Добавь уточнение тона для resilient-landing-flow",
      resolvedSkills: ["ru-text"],
    });
    const dUncited = recordTrajectoryDelta(db, {
      projectId: "proj_evo",
      workflowId: "other-future-flow",
      stageArchetype: "seo",
      interventionKind: "rule_added",
      rawSummary: "Проверяй canonical теги в отдельном будущем процессе",
    });

    const v2Apply = await applyGraphEvolveCandidates(
      { db, globalDir: globalWorkflowDir, architect, log: ctx.log },
      [
        {
          workflowId: "resilient-landing-flow",
          scope: "global",
          name: { en: "Resilient landing flow", ru: "Устойчивый поток лендинга" },
          description: { en: "Landing flow", ru: "Поток лендинга" },
          definition: makeWorkflowDef("resilient-landing-flow", "V2 minor prompt for {{$inputs.target_domain}}."),
          sourceDeltaIds: [dCited.row!.id],
        },
      ],
      { deltaIds: [dCited.row!.id, dUncited.row!.id] },
    );
    expect(v2Apply.publishedCount).toBe(1);
    // Uncited delta from another topic must remain unprocessed.
    expect(listUnprocessedTrajectoryDeltas(db).map((d) => d.id)).toEqual([dUncited.row!.id]);

    // Subsequent night: a broken minor candidate fails runDraftTest.
    const redDef = {
      ...makeWorkflowDef("resilient-landing-flow", "V3 broken prompt for {{$inputs.target_domain}}."),
      test: {
        id: "resilient-landing-flow-sim",
        sim: {
          input: { target_domain: "example.com" },
          stubs: { draft_page: { handoff: "Prepared", status: "done" } },
          expect_path: ["draft_page", "done"],
          expect_status: "succeeded",
          expect_output: { status: "impossible_value" },
        },
      },
    };
    const redApply = await applyGraphEvolveCandidates(
      { db, globalDir: globalWorkflowDir, architect, log: ctx.log },
      [
        {
          workflowId: "resilient-landing-flow",
          scope: "global",
          name: { en: "Resilient landing flow", ru: "Устойчивый поток лендинга" },
          description: { en: "Landing flow", ru: "Поток лендинга" },
          definition: redDef,
        },
      ],
    );
    expect(redApply.rejectedCount).toBe(1);

    // Published v2 must stay visible in Pilot panel with canRollback: true.
    const statusAfterRed = await rpc.pilot_panel_status({ threadId: "thr_evo_3", force: true });
    const rowAfterRed = statusAfterRed.workflowEvolution?.items.find((i) => i.draftId === seed.id);
    expect(rowAfterRed).toMatchObject({ status: "published", publishedVersion: 2, canRollback: true });

    // Next night: a green structural proposal (extra required secret -> structural_or_new) is queued as `tested` (rev 3) while v2 stays live.
    const structuralDef = {
      ...makeWorkflowDef("resilient-landing-flow", "V3 structural prompt for {{$inputs.target_domain}}."),
      requires: { plugins: ["lane-pilot"], skills: [], secrets: ["NEW_API_TOKEN"], machines: [] },
    };
    const structApply = await applyGraphEvolveCandidates(
      { db, globalDir: globalWorkflowDir, architect, log: ctx.log },
      [
        {
          workflowId: "resilient-landing-flow",
          scope: "global",
          name: { en: "Resilient landing flow", ru: "Устойчивый поток лендинга" },
          description: { en: "Landing flow", ru: "Поток лендинга" },
          definition: structuralDef,
        },
      ],
    );
    expect(structApply.proposedCount).toBe(1);

    // Clicking 1-click rollback (from panel or open v2 digest) must still restore V1 baseline prompt, NOT republish V2!
    const statusAfterStruct = await rpc.pilot_panel_status({ threadId: "thr_evo_3", force: true });
    const rowAfterStruct = statusAfterStruct.workflowEvolution?.items.find((i) => i.draftId === seed.id);
    expect(rowAfterStruct).toMatchObject({ canPublish: true, canRollback: true });

    const rb = await rpc.pilot_panel_rollback_workflow_draft({ threadId: "thr_evo_3", draftId: seed.id });
    expect(rb.ok).toBe(true);
    const diskAfterRollback = JSON.parse(readFileSync(join(globalWorkflowDir(), "resilient-landing-flow.json"), "utf8")) as {
      nodes: Array<{ id: string; prompt?: string }>;
    };
    expect(diskAfterRollback.nodes.find((n) => n.id === "draft_page")?.prompt).toContain("V1 baseline prompt");
    expect(logs.length).toBeGreaterThan(0);
  });

  it("supports modular UI Kit -> Brandbook expansion, 1-click coupled publish, v1 -> v2 evolution, atomic 1-click rollback, and silent upkeep", async () => {
    const rootPath = createTempWorkspace();
    const { ctx, db, logs } = createEvolutionHarness(rootPath);
    const tempWorkflows = createTempDir("lp-evo-brandbook-wf-");
    const tempSkills = createTempDir("lp-evo-brandbook-skills-");
    let clock = 1_760_500_000_000;
    const now = () => {
      clock += 1_000;
      return clock;
    };

    const brandingCategory = { id: "branding", label: { en: "Branding & Identity", ru: "Брендинг и айдентика" } };
    const makeBrandbookDef = (opts: { extraInputs?: Record<string, unknown>; promptSuffix?: string } = {}): Record<string, unknown> => ({
      id: "brandbook",
      version: 1,
      category: brandingCategory,
      name: { en: "Brandbook System", ru: "Система брендбука" },
      description: {
        en: "Builds modular brandbook deliverable for {{$inputs.brand_brief}}.",
        ru: "Собирает модульный брендбук по брифу {{$inputs.brand_brief}}.",
      },
      status: "draft",
      triggers: ["manual"],
      inputs: {
        brand_brief: { type: "string", default: "Modular design system", description: "Brand brief" },
        brand_tokens_artifact: { type: "string", default: "", description: "Optional handoff tokens from site UI kit" },
        ...(opts.extraInputs ?? {}),
      },
      outputs: { status: "done|blocked", summary: "string" },
      goal_check: "artifact",
      requires: { plugins: ["lane-pilot"], skills: ["brandbook-standard"], secrets: [], machines: [] },
      nodes: [
        {
          id: "craft_brandbook",
          type: "agent",
          role: "specialist:design-lead",
          skills: ["brandbook-standard"],
          title: { en: "Craft Brandbook", ru: "Собрать брендбук" },
          prompt: `Assemble brandbook for {{$inputs.brand_brief}} using tokens {{$inputs.brand_tokens_artifact}}.${opts.promptSuffix ? ` ${opts.promptSuffix}` : ""}`,
          out: { status: "done|blocked", summary: "string", handoff: "string" },
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { status: "craft_brandbook.status", summary: "craft_brandbook.summary" },
        },
      ],
      edges: [
        { from: "start", to: "craft_brandbook" },
        { from: "craft_brandbook", to: "done" },
      ],
      test: {
        id: "brandbook-sim",
        sim: {
          input: { brand_brief: "Modular design system", brand_tokens_artifact: "tokens.json" },
          stubs: { craft_brandbook: { status: "done", summary: "Brandbook compiled", handoff: "Done" } },
          expect_path: ["craft_brandbook", "done"],
          expect_status: "succeeded",
          expect_output: { status: "done", summary: "Brandbook compiled" },
        },
      },
    });

    const v1Skill = renderCompanionSkillBundle({
      skillId: "brandbook-standard",
      workflowIds: ["brandbook"],
      mergeMode: "create_bundle",
      summary: "Modular brandbook deliverable standard extending UI kit tokens.",
      whenToUse: "Use when producing a brandbook or visual identity guideline.",
      whenNotToUse: "Do not use for backend APIs or unrelated deployment scripts.",
      coreRules: ["Preserve UI kit color and type token parity inside brandbook sections."],
      goldenSkeletonSections: ["Logo & Clearspace", "Color Palette", "Typography Scale"],
      qaRubricChecks: ["Logo minimum clearspace rule is explicit.", "WCAG contrast pairs are checked for Color Palette."],
      archetypeOverlays: [],
    });

    // 1) Propose brandbook v1 (proposed_tested) + staged brandbook-standard v1
    const v1Def = makeBrandbookDef();
    const proposed = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, now, log: ctx.log },
      [
        {
          workflowId: "brandbook",
          scope: "global",
          name: v1Def.name as { en: string; ru: string },
          description: v1Def.description as { en: string; ru: string },
          category: brandingCategory,
          definition: v1Def,
        },
      ],
      { publishApprovedSuite: false, auditVerdict: "pass", operator: "extend_module", companionSkills: [v1Skill] },
    );
    expect(proposed.proposedCount).toBe(1);
    expect(proposed.publishedCount).toBe(0);
    expect(proposed.outcomes[0]).toMatchObject({ workflowId: "brandbook", status: "proposed_tested", version: 1 });
    const draftId = proposed.outcomes[0]!.draftId!;
    expect(existsSync(join(tempWorkflows, "brandbook.json"))).toBe(false);
    expect(existsSync(join(tempSkills, "brandbook-standard"))).toBe(false);

    // 2) Owner 1-click publish writes BOTH brandbook.json v1 AND brandbook-standard v1 atomically
    const pubRes = await publishPanelWorkflowDraft(
      ctx,
      { globalDir: () => tempWorkflows, skillsDir: () => tempSkills },
      { draftId, threadId: "thr_evo_bb" },
    );
    expect(pubRes.ok).toBe(true);

    const wfPath = join(tempWorkflows, "brandbook.json");
    const skillDir = join(tempSkills, "brandbook-standard");
    const skeletonPath = join(skillDir, "references", "golden-skeleton.md");
    const skillMdPath = join(skillDir, "SKILL.md");

    expect(existsSync(wfPath)).toBe(true);
    expect(existsSync(skillMdPath)).toBe(true);
    expect(existsSync(skeletonPath)).toBe(true);
    expect(lintSkillDir(readSkillDir(skillDir)).errors).toEqual([]);

    const v1WorkflowRaw = readFileSync(wfPath, "utf8");
    const v1WorkflowJson = JSON.parse(v1WorkflowRaw) as Record<string, unknown>;
    expect(v1WorkflowJson.version).toBe(1);
    const v1SkeletonRaw = readFileSync(skeletonPath, "utf8");
    const v1SkillMdRaw = readFileSync(skillMdPath, "utf8");
    expect(v1SkeletonRaw).toContain("Logo & Clearspace");
    expect(v1SkeletonRaw).toContain("Color Palette");
    expect(v1SkeletonRaw).toContain("Typography Scale");

    // 3) Next day: patch_converge auto-publishes brandbook v2 + brandbook-standard v2 (adding Tone of Voice & Motion Guidelines)
    const v2Def = makeBrandbookDef({
      extraInputs: { voice_and_motion: { type: "string", default: "calm", description: "Optional tone & motion notes" } },
      promptSuffix: "Include Tone of Voice and Motion Guidelines sections ({{$inputs.voice_and_motion}}).",
    });
    const v2Skill = renderCompanionSkillBundle(
      {
        skillId: "brandbook-standard",
        workflowIds: ["brandbook"],
        mergeMode: "merge_core_and_overlay",
        summary: "Modular brandbook deliverable standard extending UI kit tokens.",
        whenToUse: "Use when producing a brandbook or visual identity guideline.",
        whenNotToUse: "Do not use for backend APIs or unrelated deployment scripts.",
        coreRules: ["Define Tone of Voice and Motion Guidelines alongside visual tokens."],
        goldenSkeletonSections: ["Tone of Voice", "Motion Guidelines"],
        qaRubricChecks: ["Tone of Voice examples and Motion Guidelines timings are documented."],
        archetypeOverlays: [],
      },
      readSkillDir(skillDir),
    );

    const v2Apply = await applyGraphEvolveCandidates(
      { db, globalDir: () => tempWorkflows, skillsDir: () => tempSkills, now, log: ctx.log },
      [
        {
          workflowId: "brandbook",
          scope: "global",
          name: v2Def.name as { en: string; ru: string },
          description: v2Def.description as { en: string; ru: string },
          category: brandingCategory,
          definition: v2Def,
        },
      ],
      { auditVerdict: "pass", operator: "patch_converge", companionSkills: [v2Skill] },
    );
    expect(v2Apply.publishedCount).toBe(1);
    expect(v2Apply.outcomes[0]).toMatchObject({ workflowId: "brandbook", kind: "minor_patch", status: "auto_published", version: 2 });

    const v2WorkflowJson = JSON.parse(readFileSync(wfPath, "utf8")) as { version: number; inputs: Array<{ name: string }> };
    expect(v2WorkflowJson.version).toBe(2);
    expect(v2WorkflowJson.inputs.some((i) => i.name === "voice_and_motion")).toBe(true);

    const v2SkeletonRaw = readFileSync(skeletonPath, "utf8");
    expect(v2SkeletonRaw).toContain("Logo & Clearspace");
    expect(v2SkeletonRaw).toContain("Color Palette");
    expect(v2SkeletonRaw).toContain("Typography Scale");
    expect(v2SkeletonRaw).toContain("Tone of Voice");
    expect(v2SkeletonRaw).toContain("Motion Guidelines");
    expect(lintSkillDir(readSkillDir(skillDir)).errors).toEqual([]);

    // 4) Owner clicks 1-click rollback -> BOTH brandbook.json content AND brandbook-standard revert to v1
    const rbRes = await rollbackPanelWorkflowDraft(
      ctx,
      { globalDir: () => tempWorkflows, skillsDir: () => tempSkills },
      { draftId, threadId: "thr_evo_bb" },
    );
    expect(rbRes.ok).toBe(true);

    // Skill files revert byte-for-byte to v1 (v2-only sections removed, all 3 v1 sections intact)
    expect(readFileSync(skeletonPath, "utf8")).toBe(v1SkeletonRaw);
    expect(readFileSync(skillMdPath, "utf8")).toBe(v1SkillMdRaw);
    expect(readFileSync(skeletonPath, "utf8")).not.toContain("Tone of Voice");
    expect(readFileSync(skeletonPath, "utf8")).not.toContain("Motion Guidelines");

    // Workflow JSON reverts byte-for-byte to v1 content (excluding monotonic published version counter)
    const rolledWfJson = JSON.parse(readFileSync(wfPath, "utf8")) as Record<string, unknown> & { inputs: Array<{ name: string }> };
    expect(`${JSON.stringify({ ...rolledWfJson, version: 1 }, null, 2)}\n`).toBe(v1WorkflowRaw);
    expect(rolledWfJson.inputs.some((i) => i.name === "voice_and_motion")).toBe(false);

    const ledgerEvents = listSkillEvolutionsForDraft(db, draftId);
    expect(ledgerEvents.some((ev) => ev.skillId === "brandbook-standard" && ev.status === "rolled_back")).toBe(true);
    expect(logs.some((line) => line.includes("INFO [pilotPanel.workflowDrafts] coupled_skill_restored"))).toBe(true);

    // 5) Silent upkeep verification for lp.graph-evolve-nightly (UPKEEP_WORKFLOWS suppresses PM chat & owner spam)
    const pmSends: string[] = [];
    const kv = new Map<string, unknown>();
    const noticeBb = {
      sdk: {
        threads: {
          send: async (req: { input: Array<{ text: string }> }) => {
            pmSends.push(req.input[0]!.text);
          },
        },
      },
      storage: {
        kv: {
          get: async (k: string) => kv.get(k) ?? null,
          set: async (k: string, v: unknown) => {
            kv.set(k, v);
          },
        },
      },
    };
    const upkeepRun: RunRow = {
      id: "wfrun_upkeep_nightly",
      idem_key: "wf:graph-evolve:nightly",
      workflow_id: "lp.graph-evolve-nightly",
      workflow_version: 1,
      workflow_sha256: "sha",
      definition_json: "{}",
      project_id: "proj_evo",
      link_run_id: "run_linked_pm",
      link_task_id: null,
      link_attempt_id: null,
      parent_run_id: null,
      parent_step_key: null,
      depth: 0,
      status: "succeeded",
      reason: null,
      mode: null,
      inputs_json: "{}",
      output_json: JSON.stringify({ status: "done", summary: "2 proposed" }),
      harness_version: HARNESS_VERSION,
      steps_used: 1,
      tokens_used: 0,
      cost_micro_usd: 0,
      wait_ms: 0,
      owner_id: null,
      lease_until: 0,
      created_at: now(),
      updated_at: now(),
    };
    expect(await maybeNotifyWorkflowRun({ bb: noticeBb, log: ctx.log, pmThreadId: "thr_evo_bb", startedBySchedule: false, run: upkeepRun })).toBe(false);
    expect(await maybeNotifyWorkflowRun({ bb: noticeBb, log: ctx.log, pmThreadId: "thr_evo_bb", startedBySchedule: true, run: upkeepRun })).toBe(false);
    expect(await notifyWorkflowIfEnded({ bb: noticeBb, db, log: ctx.log, run: { ...upkeepRun, link_run_id: null } })).toBe(false);
    expect(pmSends).toEqual([]);
  });
});
