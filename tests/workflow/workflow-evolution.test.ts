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
import { HARNESS_VERSION } from "../../src/rooms/storage";
import { coreRequiredSessionAdvertisement } from "../../src/rooms/contracts";
import { listOpenOwnerItems, postOwnerItem } from "../../src/rooms/owner-waiting";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  createWorkflowArchitect,
  workflowsRpc,
} from "../../src/rooms/workflow/server";
import type { ServerCore } from "../../src/rooms/contracts/server";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTempWorkspace(): string {
  const dir = createTempDir("lp-wf-evo-ws-");
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

function makeWorkflowRpc(ctx: ServerCore) {
  return workflowsRpc(ctx, {
    docsPlaces: async () => [],
    stability: {} as never,
    workflowCatalog: { invalidate: () => undefined } as never,
    workflowEngine: { hasExecutor: () => false } as never,
    workflowTriggers: {} as never,
  });
}

beforeEach(() => {
  vi.stubEnv("HOME", createTempDir("lp-wf-evo-home-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow evolution RPC in Graphs room", () => {
  it("surfaces tested v1 and published v2 drafts in workflow_evolution_list and supports 1-click publish and rollback", async () => {
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
      reason: "decision",
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
      reason: "decision",
      projectId: "proj_evo",
      what: "Утреннее обновление v1 -> v2",
      why: "Минорный патч авто-опубликован",
      wake: false,
    });

    const rpc = makeWorkflowRpc(ctx);
    const statusBefore = await rpc.workflow_evolution_list({ projectId: "proj_evo" });
    expect(statusBefore.pendingApprovalCount).toBe(1);
    expect(statusBefore.autoPublishedCount).toBe(1);
    const proposedRow = statusBefore.items.find((i) => i.draftId === v1Proposed.id);
    const evolvedRow = statusBefore.items.find((i) => i.draftId === v2Draft.id);
    expect(proposedRow).toMatchObject({ status: "tested", testedGreen: true, canPublish: true, canRollback: false });
    expect(evolvedRow).toMatchObject({ status: "published", publishedVersion: 2, canPublish: false, canRollback: true });

    // 1-click publish closes workflow_draft_proposed owner item, writes to globalDir, and notifies realtime.
    const pubRes = await rpc.workflow_evolution_publish({ threadId: "thr_evo_2", draftId: v1Proposed.id });
    expect(pubRes.ok).toBe(true);
    expect(pubRes.message).toContain("new-site-archetype");
    expect(existsSync(join(globalWorkflowDir(), "new-site-archetype.json"))).toBe(true);
    expect(listOpenOwnerItems(db, {}).some((item) => item.key === `workflow-draft:${v1Proposed.id}:v1`)).toBe(false);
    expect(realtimeSignals.some((s) => s.kind === "workflow-draft" && s.id === v1Proposed.id)).toBe(true);
    expect((await rpc.workflow_evolution_list({ projectId: "proj_evo" })).pendingApprovalCount).toBe(0);

    // 1-click rollback restores v2 -> v1, writes v1 content back to globalDir, and closes digest owner item.
    const rollbackRes = await rpc.workflow_draft_rollback({ threadId: "thr_evo_2", draftId: v2Draft.id });
    expect(rollbackRes.ok).toBe(true);
    expect(rollbackRes.message).toContain("откачен");
    const rolledDisk = JSON.parse(readFileSync(join(globalWorkflowDir(), "universal-landing-flow.json"), "utf8")) as {
      nodes: Array<{ id: string; prompt?: string }>;
    };
    expect(rolledDisk.nodes.find((n) => n.id === "draft_page")?.prompt).toContain("V1 prompt");
    expect(listOpenOwnerItems(db, {}).some((item) => item.key === `workflow-evolved:${v2Draft.id}:v2`)).toBe(false);
    expect(realtimeSignals.some((s) => s.kind === "workflow-draft" && s.id === v2Draft.id)).toBe(true);

    // Failure diagnostics when draft is missing or has no prior version.
    const missingRes = await rpc.workflow_draft_rollback({ threadId: "thr_evo_2", draftId: "wfd_missing" });
    expect(missingRes.ok).toBe(false);
    expect(missingRes.message).toContain("не найден");

    const noPrevRes = await rpc.workflow_draft_rollback({ threadId: "thr_evo_2", draftId: v1Proposed.id });
    expect(noPrevRes.ok).toBe(false);
    expect(noPrevRes.message).toContain("Нет предыдущей версии");
    expect(logs.some((line) => line.includes("WARN [workflow.drafts] rollback_unavailable"))).toBe(true);
  });
});
