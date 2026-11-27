import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  END,
  START,
  archiveDefinition,
  archivedDefinition,
  createDraftStore,
  createWorkflowCatalog,
  definitionSha256,
  loadWorkflowStore,
  parseWorkflow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { openDatabase } from "../../src/rooms/plugin-db";
import { archiveBuiltinWorkflows, builtinWorkflow, setBuiltinArchiveDb } from "../../src/rooms/workflow/builtin";
import { createWorkflowArchitect, grantOwner, publishEvolutionWorkflowDraft } from "../../src/rooms/workflow/server";
import { engineOn, journalDb, ok, trust } from "./engine-helpers";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setBuiltinArchiveDb(null);
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function childGraph(id: string, version: number, label = `v${version}`): Record<string, unknown> {
  return {
    id,
    version,
    name: { en: `${id} ${label}`, ru: `${id} ${label}` },
    description: { en: `Child ${id} ${label}`, ru: `Child ${id} ${label}` },
    inputs: [{ name: "query", type: "string", required: false }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      { id: "work", type: "action", action: `run_${label}`, out: [{ name: "text", type: "string" }] },
      { id: "done", type: "action", action: "emit", map: { result: "work.text" } },
    ],
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "done" },
    ],
    test: {
      id: `${id}-sim`,
      sim: {
        input: { query: "q" },
        stubs: { work: { text: label } },
        expect_path: ["work", "done"],
        expect_output: { result: label },
      },
    },
  };
}

function makeFakeCore(db: ReturnType<typeof openDatabase>, debugLogs: string[], warnLogs: string[]): ServerCore {
  return {
    bb: {
      log: {
        debug: (msg: string) => debugLogs.push(msg),
        info: () => undefined,
        warn: (msg: string) => warnLogs.push(msg),
        error: (msg: string) => warnLogs.push(msg),
      },
      sdk: {
        projects: { get: async () => ({ id: "proj_1", name: "Archive Test" }) },
        threads: { get: async () => null },
        environments: { get: async () => null },
      },
    },
    db,
    log: (msg: string) => warnLogs.push(msg),
    realtime: { notify: () => undefined },
    knownCustomAgentIds: () => null,
    ownedAgents: async () => ({}),
    effectiveProjectSettings: async () => ({ values: {} }),
    secrets: { list: async () => [] },
    host: { call: async () => ({}) },
  } as unknown as ServerCore;
}

describe("definition archive", () => {
  it("stores and resolves archived definitions idempotently and picks the newest sha per version", () => {
    const db = journalDb();
    try {
      const older = parseWorkflow(childGraph("arch-child", 1, "older"));
      const newer = parseWorkflow(childGraph("arch-child", 1, "newer"));
      const debug: string[] = [];
      const warn: string[] = [];
      const log = { debug: (m: string) => debug.push(m), warn: (m: string) => warn.push(m) };

      expect(archiveDefinition(db, {
        workflowId: "arch-child",
        version: 1,
        sha: definitionSha256(older),
        json: JSON.stringify(older),
        scope: "global",
        archivedAt: 1_000,
      }, { log })).toBe(true);

      // Same (workflowId, version, sha) is ignored cleanly.
      expect(archiveDefinition(db, {
        workflowId: "arch-child",
        version: 1,
        sha: definitionSha256(older),
        json: JSON.stringify(older),
        scope: "global",
        archivedAt: 1_500,
      }, { log })).toBe(false);

      expect(archiveDefinition(db, {
        workflowId: "arch-child",
        version: 1,
        sha: definitionSha256(newer),
        json: JSON.stringify(newer),
        scope: "global",
        archivedAt: 2_000,
      }, { log })).toBe(true);

      const resolved = archivedDefinition(db, "arch-child", 1);
      expect(resolved?.name.en).toBe("arch-child newer");
      expect(archivedDefinition(db, "arch-child", 99)).toBeNull();
      expect(debug.length).toBe(2);
      expect(debug[0]).toMatch(/^wf\.archive wf=arch-child v=1 sha=[0-9a-f]{8}$/);
      expect(warn).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("archives built-ins at startup and resolves older archived built-in versions via builtinWorkflow and catalog", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const debug: string[] = [];
    const warn: string[] = [];
    try {
      const inserted = archiveBuiltinWorkflows(db, { debug: (m) => debug.push(m), warn: (m) => warn.push(m) });
      expect(inserted).toBeGreaterThan(50);
      expect(warn).toEqual([]);
      expect(debug.some((line) => line.startsWith("wf.archive wf=lp-task-pipeline v="))).toBe(true);

      // Second startup call is a cheap no-op via INSERT OR IGNORE.
      expect(archiveBuiltinWorkflows(db)).toBe(0);

      // Archive an older synthetic revision (v0? min is 1, so archive a different version e.g. v99 on a builtin id, or v1 of an upgraded builtin).
      const current = builtinWorkflow("lp.analyze")!;
      const oldRev: Workflow = { ...current, version: 1, description: { en: "Archived v1 description", ru: "Archived v1 description" } };
      // Simulate current builtin having moved to v2 by archiving an old version number that differs from current.version:
      const oldVersion = current.version + 41;
      const altRev: Workflow = { ...current, version: oldVersion, description: { en: "Archived revision", ru: "Archived revision" } };
      archiveDefinition(db, {
        workflowId: current.id,
        version: oldVersion,
        sha: definitionSha256(altRev),
        json: JSON.stringify(altRev),
        scope: "builtin",
      });

      expect(builtinWorkflow(current.id, oldVersion)?.description.en).toBe("Archived revision");
      expect(builtinWorkflow(current.id, current.version)?.version).toBe(current.version);

      const catalog = createWorkflowCatalog({ builtin: [], db, globalDir: null });
      expect(catalog.builtin(current.id, oldVersion)?.description.en).toBe("Archived revision");
      const store = await catalog.store();
      expect(store.resolve(current.id, oldVersion)?.description.en).toBe("Archived revision");
      void oldRev;
    } finally {
      db.close();
    }
  });

  it("keeps v1 resolvable after architect publishes v2, and runs subworkflow pinned to version 1 on v1", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const globalDir = makeTempDir("lp-arch-global-");
    const debug: string[] = [];
    const warn: string[] = [];
    const ctx = makeFakeCore(db, debug, warn);
    const engine = engineOn(db, {
      run_v1: ok(() => ({ text: "from-v1" })),
      run_v2: ok(() => ({ text: "from-v2" })),
      emit: ok((c) => c.input.with),
    }, {
      resolveWorkflow: (id, version) => catalog.peek()?.resolve(id, version) ?? builtinWorkflow(id, version, db),
    });
    const catalog = createWorkflowCatalog({ builtin: [], db, globalDir });
    const architect = createWorkflowArchitect(ctx, { workflowEngine: engine as never, workflowCatalog: catalog }, {
      globalDir: () => globalDir,
      projectPlace: async () => null,
      writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "unused" }),
      capabilityPorts: () => ({}),
      hasExecutor: () => true,
    });

    try {
      // Publish v1 of arch-sub via architect.
      const v1Def = childGraph("arch-sub", 1, "v1");
      const created = architect.create({
        projectId: "proj_1",
        threadId: "thr_1",
        scope: "global",
        workflowId: "arch-sub",
        name: { en: "Arch sub", ru: "Arch sub" },
        description: { en: "Sub", ru: "Sub" },
        definition: v1Def,
      });
      const test1 = await architect.test({ projectId: "proj_1", draftId: created.draftId });
      expect(test1.green).toBe(true);
      grantOwner(db, created.draftId, "cli");
      const pub1 = await architect.publish({ projectId: "proj_1", draftId: created.draftId });
      expect(pub1).toMatchObject({ published: true, workflowVersion: 1 });

      // Patch to v2 and publish v2 via architect.
      const patched = architect.patch({
        projectId: "proj_1",
        draftId: created.draftId,
        ops: [{ op: "update_node", id: "work", set: { action: "run_v2" } }, { op: "set_meta", set: { test: childGraph("arch-sub", 2, "v2").test } }],
      });
      expect(patched.ok).toBe(true);
      const test2 = await architect.test({ projectId: "proj_1", draftId: created.draftId });
      expect(test2.green).toBe(true);
      grantOwner(db, created.draftId, "cli");
      const pub2 = await architect.publish({ projectId: "proj_1", draftId: created.draftId });
      expect(pub2).toMatchObject({ published: true, workflowVersion: 2 });

      // Reload catalog: current version on disk is v2, while v1 resolves from archive.
      await catalog.store();
      expect(catalog.peek()?.resolve("arch-sub")?.version).toBe(2);
      expect(catalog.peek()?.resolve("arch-sub", 1)?.version).toBe(1);
      expect(builtinWorkflow("arch-sub", 1)?.version).toBe(1);

      const directStore = await loadWorkflowStore({ builtin: [], globalDir, db });
      expect(directStore.resolve("arch-sub", 1)?.version).toBe(1);

      // A parent graph with subworkflow pinned to version: 1 runs v1 even though v2 is current.
      const pinnedParent = parseWorkflow({
        id: "pinned-parent",
        name: { en: "Pinned parent", ru: "Pinned parent" },
        description: { en: "Calls v1 of arch-sub", ru: "Calls v1 of arch-sub" },
        status: "published",
        outputs: [{ name: "result", type: "string" }],
        nodes: [
          { id: "call", type: "subworkflow", workflow: "arch-sub", version: 1, inputs: { query: "$inputs.query" } },
        ],
        edges: [
          { from: START, to: "call" },
          { from: "call", to: END, with: { result: "call.result" } },
        ],
        inputs: [{ name: "query", type: "string", required: false }],
      }, { resolve: (id, v) => catalog.peek()?.resolve(id, v) ?? builtinWorkflow(id, v, db) });

      const pinnedRun = engine.start({ workflow: pinnedParent, inputs: { query: "hello" } });
      expect(await pinnedRun.done).toMatchObject({ status: "succeeded", output: { result: "from-v1" } });

      // publishEvolutionWorkflowDraft also writes to the archive.
      const drafts = createDraftStore(db);
      const evoDraft = drafts.create({
        projectId: "proj_1",
        threadId: null,
        scope: "global",
        workflowId: "arch-evo",
        name: { en: "Arch evo", ru: "Arch evo" },
        description: { en: "Evo", ru: "Evo" },
        definition: childGraph("arch-evo", 1, "v1"),
      });
      const evoSim = (await architect.test({ projectId: "proj_1", draftId: evoDraft.id }));
      expect(evoSim.green).toBe(true);
      grantOwner(db, evoDraft.id, "cli");
      const evoRes = await publishEvolutionWorkflowDraft(ctx, { workflowEngine: engine as never, workflowCatalog: catalog, globalDir: () => globalDir }, { draftId: evoDraft.id });
      expect(evoRes.ok).toBe(true);
      expect(archivedDefinition(db, "arch-evo", 1)?.id).toBe("arch-evo");

      // If archive write fails, publish warns and still succeeds.
      db.exec("DROP TABLE lane_pilot_wf_definition");
      const warnBefore = warn.length;
      const patched3 = architect.patch({
        projectId: "proj_1",
        draftId: created.draftId,
        ops: [{ op: "set_meta", set: { description: { en: "v3", ru: "v3" } } }],
      });
      expect(patched3.ok).toBe(true);
      expect((await architect.test({ projectId: "proj_1", draftId: created.draftId })).green).toBe(true);
      grantOwner(db, created.draftId, "cli");
      const pub3 = await architect.publish({ projectId: "proj_1", draftId: created.draftId });
      expect(pub3.published).toBe(true);
      expect(warn.slice(warnBefore).some((line) => line.includes("wf.archive write failed wf=arch-sub"))).toBe(true);
    } finally {
      engine.dispose();
      db.close();
    }
  });

  it("lets a parent run started before v2 finish on its snapshot even when subworkflow had no version pin", async () => {
    const db = journalDb();
    let currentSub = parseWorkflow(childGraph("snap-sub", 1, "v1"));
    const parent = parseWorkflow({
      id: "snap-parent",
      name: { en: "Snap parent", ru: "Snap parent" },
      description: { en: "Starts before v2", ru: "Starts before v2" },
      status: "published",
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        { id: "wait", type: "action", uses: "builtin:wait", params: { event: "snap.next", eventKey: "k", durationSec: 600 } },
        { id: "call", type: "subworkflow", workflow: "snap-sub", inputs: { query: "$inputs.query" } },
      ],
      edges: [
        { from: START, to: "wait" },
        { from: "wait", to: "call" },
        { from: "call", to: END, with: { result: "call.result" } },
      ],
      inputs: [{ name: "query", type: "string", required: false }],
    }, { resolve: (id) => (id === "snap-sub" ? currentSub : null) });
    trust(db, currentSub);

    const first = engineOn(db, {
      run_v1: ok(() => ({ text: "from-v1" })),
      run_v2: ok(() => ({ text: "from-v2" })),
      emit: ok((c) => c.input.with),
    }, { instanceId: "first", resolveWorkflow: (id) => (id === "snap-sub" ? currentSub : null) });

    const started = first.start({ workflow: parent, inputs: { query: "q" } });
    await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM lane_pilot_wf_step WHERE run_id=? AND state='waiting'").all(started.runId).length).toBe(1));
    first.dispose();

    // Upgrade to v2 and archive v1; the resumed parent run still uses its v1 snapshot.
    archiveDefinition(db, {
      workflowId: "snap-sub",
      version: 1,
      sha: definitionSha256(currentSub),
      json: JSON.stringify(currentSub),
      scope: "global",
    });
    currentSub = parseWorkflow(childGraph("snap-sub", 2, "v2"));
    const second = engineOn(db, {
      run_v1: ok(() => ({ text: "from-v1" })),
      run_v2: ok(() => ({ text: "from-v2" })),
      emit: ok((c) => c.input.with),
    }, {
      instanceId: "second",
      resolveWorkflow: (id, version) => (id === "snap-sub" && (version === undefined || version === currentSub.version) ? currentSub : version !== undefined ? archivedDefinition(db, id, version) : null),
    });
    await second.resume({ takeOver: true });
    expect(await second.wake("snap.next", "k", {})).toBe(1);
    await second.idle();
    expect(second.get(started.runId)).toMatchObject({ status: "succeeded", output: { result: "from-v1" } });
    second.dispose();
    db.close();
  });
});
