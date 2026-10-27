import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { localDateKey } from "../../src/rooms/docs/docs";
import { DOCS_MAINTENANCE, DOCS_NIGHT, builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { claimActivation, createAttempt, createRun, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/storage/database";
import { recordStage } from "../../src/rooms/runs/server";
import { maybeNotifyWorkflowRun } from "../../src/rooms/workflow/server/pm-notice";
import { collectEntries } from "../../src/rooms/wall/journal";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ev = (seq: number, type: string, data: Record<string, unknown> = {}, createdAt = 1_000) => ({ seq, type, createdAt, threadId: "thr_docs", data });
const idleEvents = [ev(1, "client/turn/requested", {}, 1_000), ev(2, "turn/started", {}, 1_100), ev(3, "turn/completed", { status: "completed" }, 2_000)].reverse();
const settle = async (ready: () => boolean | Promise<boolean>) => { for (let tick = 0; tick < 200 && !(await ready()); tick++) await new Promise((done) => setTimeout(done, 10)); };

describe("the nightly docs of a unit is the graph lp.docs-night", () => {
  it("is a starter graph of the docs schedules: prepare, write, verify, commit; a unit with nothing to do ends after prepare", () => {
    const workflow = builtinWorkflow(DOCS_NIGHT)!;
    expect(workflow).toMatchObject({ id: "lp.docs-night", startedBy: "docs-nightly", status: "published" });
    expect(workflow.nodes.map((node) => node.id)).toEqual(["prepare", "write", "verify", "commit", "skipped-prepare", "skipped-verify", "done"]);
    expect(workflow.nodes.find((node) => node.id === "write")).toMatchObject({ type: "agent", role: "docs-maintainer", uses: "lp.docs-unit" });
    expect(builtinWorkflow(DOCS_MAINTENANCE)).toMatchObject({ startedBy: "docs-maintenance", status: "published" });
  });

  it("finishes a unit with saved progress on one run: checks the pages, commits only the docs, merges them, stores the row and drops the record", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { get: async () => ({ id: "thr_docs", status: "idle" }) as never, events: { list: async () => idleEvents as never } } as never, files: { read: async () => { throw new Error("no such file"); } } as never },
      experimental_callHostRpc: (call) => {
        const input = call.input as Record<string, unknown>;
        calls.push({ method: call.method, input });
        if (call.method === "gitDocsScope") return { hostId: "ovh", status: "ready", isRepoRoot: true, hasDocs: true, changed: [], dirty: ["docs/overview.md", "src/stray.ts"], base: null, workspaces: [], localDate: "x", localHour: 1, reason: null };
        if (call.method === "gitRevertPaths") return { hostId: "ovh", reverted: input.paths, failed: [] };
        if (call.method === "listDocsPages") return { hostId: "ovh", pages: [], oversized: [] };
        if (call.method === "docsLineCounts") return { hostId: "ovh", counts: {} };
        if (call.method === "writeDocsPages") return { hostId: "ovh", previewSha256: sha("p"), status: "applied", writes: [], reason: null };
        if (call.method === "gitCommitDocs") return { hostId: "ovh", status: "committed", commit: "abc123", reason: null };
        if (call.method === "gitIntegrate") return { hostId: "ovh", status: "merged", commit: "def456", conflicts: [], reason: null };
        throw new Error(`stop at ${call.method}`);
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const today = localDateKey(new Date());
    const key = `docs-unit:proj_docs:${sha("/work/docs-wt\ndocs").slice(0, 12)}`;
    await bb.storage.kv.set(key, { version: 1, projectId: "proj_docs", place: { hostId: "ovh", path: "/work/docs-wt" }, basePath: "/work/project", label: "docs", unit: { docsDir: "docs" }, threadId: "thr_docs",
      phase: "writing", beforeDirty: [], localDate: today, since: "7d", roots: ["docs"], workspaces: [], hasDocs: true, changedCount: 3, refresh: [], gaps: { missingPages: [], uncoveredCore: [] },
      anchors: null, core: [], kvKey: "docs-unit-report" });
    await bb.storage.kv.set("docs-units-open", { [key]: true });
    await harness.runSchedule("docs-nightly-catchup");
    await settle(async () => !(await bb.storage.kv.get(key)));

    // The row of the unit is what the pass has always stored; the record is gone; the stray code file the agent touched was put back.
    expect(await bb.storage.kv.get(key)).toBeUndefined();
    expect(await bb.storage.kv.get("docs-unit-report")).toMatchObject({ state: "passed", commit: "abc123", merged: "merged", docsWritten: ["docs/overview.md"], reverted: ["src/stray.ts"], docsDir: "docs", path: "/work/project" });
    expect(calls.find((call) => call.method === "gitRevertPaths")?.input.paths).toEqual(["src/stray.ts"]);
    expect(calls.find((call) => call.method === "gitCommitDocs")?.input.paths).toEqual(expect.arrayContaining(["docs/overview.md"]));
    expect(calls.find((call) => call.method === "gitCommitDocs")?.input.paths).not.toContain("src/stray.ts");
    // The merge into the project checkout is the one the writers' work goes through (committed work only, the docs worktree removed by the pass).
    expect(calls.find((call) => call.method === "gitIntegrate")?.input).toMatchObject({ basePath: "/work/project", worktreePath: "/work/docs-wt", committedOnly: true });

    const db = openDatabase(bb);
    const runs = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE workflow_id=?").all(DOCS_NIGHT) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", link_run_id: null, idem_key: `docs-night:${key}:${today}:0` });
    expect(JSON.parse(String(runs[0]!.output_json)).row).toMatchObject({ state: "passed", commit: "abc123" });
    const steps = db.prepare("SELECT node_id, state FROM lane_pilot_wf_step WHERE run_id=? ORDER BY started_at").all(runs[0]!.id) as Array<{ node_id: string; state: string }>;
    expect(steps.map((step) => step.node_id)).toEqual(["prepare", "write", "verify", "commit", "done"]);
    // Nothing reaches the PM or the owner's list for a unit of the night.
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE source='workflow'").get()).toEqual({ n: 0 });
  });

  it("a second tick over the same record joins the same run: one run, one commit", async () => {
    const calls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { get: async () => ({ id: "thr_docs", status: "idle" }) as never, events: { list: async () => idleEvents as never } } as never, files: { read: async () => { throw new Error("no such file"); } } as never },
      experimental_callHostRpc: (call) => {
        calls.push(call.method);
        if (call.method === "gitDocsScope") return { hostId: "ovh", status: "ready", isRepoRoot: true, hasDocs: true, changed: [], dirty: ["docs/a.md"], base: null, workspaces: [], localDate: "x", localHour: 1, reason: null };
        if (call.method === "listDocsPages") return { hostId: "ovh", pages: [], oversized: [] };
        if (call.method === "docsLineCounts") return { hostId: "ovh", counts: {} };
        if (call.method === "writeDocsPages") return { hostId: "ovh", previewSha256: sha("p"), status: "applied", writes: [], reason: null };
        if (call.method === "gitCommitDocs") return { hostId: "ovh", status: "committed", commit: "abc123", reason: null };
        throw new Error(`stop at ${call.method}`);
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const key = `docs-unit:proj_docs:${sha("/work/p\ndocs").slice(0, 12)}`;
    await bb.storage.kv.set(key, { version: 1, projectId: "proj_docs", place: { hostId: "ovh", path: "/work/p" }, label: "docs", unit: { docsDir: "docs" }, threadId: "thr_docs",
      phase: "writing", beforeDirty: [], localDate: localDateKey(new Date()), since: "7d", roots: ["docs"], workspaces: [], hasDocs: true, changedCount: 1, refresh: [], gaps: { missingPages: [], uncoveredCore: [] },
      anchors: null, core: [], kvKey: "docs-unit-report2" });
    await bb.storage.kv.set("docs-units-open", { [key]: true });
    await Promise.all([harness.runSchedule("docs-nightly-catchup"), harness.runSchedule("docs-nightly-catchup")]);
    await settle(async () => !(await bb.storage.kv.get(key)));
    expect(calls.filter((method) => method === "gitCommitDocs")).toHaveLength(1);
    expect((openDatabase(bb).prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_run WHERE workflow_id=?").get(DOCS_NIGHT) as { n: number }).n).toBe(1);
  });

  it("starts the docs agent as a step of the run: one spawn under the unit's night key, tagged with the run, the record names the run", async () => {
    const projectId = "proj_docs_write";
    const spawned: Array<Record<string, any>> = [];
    const calls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        files: { read: async () => { throw new Error("no such file"); } } as never,
        projects: { get: async () => ({ id: projectId, name: "P", sources: [{ hostId: "ovh", path: "/work/p", isDefault: true }] }) as never, list: async () => [{ id: projectId }] as never },
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
          models: async () => ({ models: [{ id: "gpt-6-luna", model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] }) as never,
        } as never,
        threads: {
          spawn: async (args: Record<string, any>) => { spawned.push(args); return { id: "thr_docs" } as never; },
          get: async () => ({ id: "thr_docs", status: "idle" }) as never,
          events: { list: async () => idleEvents as never },
        } as never,
      },
      experimental_callHostRpc: (call) => {
        calls.push(call.method);
        const input = call.input as Record<string, unknown>;
        if (call.method === "gitDocsScope") return { hostId: "ovh", status: "ready", isRepoRoot: true, hasDocs: false, changed: ["src/a.ts"], dirty: input.docsDir ? ["docs/overview.md"] : [], base: null, workspaces: [], localDate: "2026-10-27", localHour: 4, reason: null };
        if (call.method === "gitCreateWorktree") return { hostId: "ovh", status: "failed", path: null, branch: null, reason: "no worktree in the test" };
        if (call.method === "listDocsPages") return { hostId: "ovh", pages: [], oversized: [] };
        if (call.method === "docsFlows") return { hostId: "ovh", briefPath: "/tmp/flows.md", jev: "disabled", routes: 0, flows: [] };
        if (call.method === "docsAnchors") return { hostId: "ovh", briefPath: "/tmp/brief.md", anchors: 0, jev: "disabled", tables: [], deploy: false, core: [], productFiles: [] };
        if (call.method === "docsLineCounts") return { hostId: "ovh", counts: {} };
        if (call.method === "writeDocsPages") return { hostId: "ovh", previewSha256: sha("p"), status: "applied", writes: [], reason: null };
        if (call.method === "gitCommitDocs") return { hostId: "ovh", status: "committed", commit: "abc123", reason: null };
        throw new Error(`stop at ${call.method}`);
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "ovh", pmWorkspacePath: "/work/p", writerWorkspacePath: "/work/p", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    saveProjectSetting(db, projectId, "docs.enabled", true);
    const result = await harness.behavior.runCli(["docs-nightly", projectId]) as { stdout: string };
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(rows).toEqual([expect.objectContaining({ projectId, state: "passed", docsDir: "docs", onboarding: true, commit: "abc123", threadId: "thr_docs" })]);
    expect(spawned).toHaveLength(1);
    const run = db.prepare("SELECT id, idem_key FROM lane_pilot_wf_run WHERE workflow_id=?").get(DOCS_NIGHT) as { id: string; idem_key: string };
    expect(spawned[0]!.pluginMetadata).toMatchObject({ role: "docs-nightly", stageId: "docs-nightly", lanePilotWorkflowRunId: run.id, lanePilotWorkflowNode: "write" });
    expect(spawned[0]!.visibility).toBe("hidden");
    expect(run.idem_key).toMatch(/^docs-night:docs-unit:proj_docs_write:[0-9a-f]{12}:\d{4}-\d{2}-\d{2}:\d{13}$/);
  });

  it("the hourly docs upkeep of an accepted task is the graph lp.docs-maintenance: one run per task, the stage function inside it, and no notice to the PM", async () => {
    const projectId = "proj_docs_task";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      // The stage function fails here (the fake host has no PM thread metadata): the run ends failed, with the stage's failure as its reason, and tells no one.
      sdk: { threads: { get: async () => ({ id: "thr_pm", status: "idle" }) as never } as never },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "ovh", pmWorkspacePath: "/work/p", writerWorkspacePath: "/work/p", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    saveProjectSetting(db, projectId, "docs.enabled", true);
    saveProjectSetting(db, projectId, "docs.maintain", true);
    saveProjectSetting(db, projectId, "docs.hour", new Date().getHours());
    createRun(db, "run-1", projectId, "bb", "/work/p");
    setRunThread(db, "run-1", "thr_pm");
    claimActivation(db, { projectId, pmThreadId: "thr_pm", runId: "run-1" });
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run-1','bb','{}',1)").run();
    createAttempt(db, { id: "att-1", runId: "run-1", taskId: "T1" });
    recordStage(db, { runId: "run-1", taskId: "T1", stageId: "acceptance-receipt", state: "passed", input: "x" });
    await harness.runSchedule("docs-maintenance-hourly");
    await settle(() => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_run WHERE workflow_id=? AND status<>'running'").get(DOCS_MAINTENANCE) as { n: number }).n > 0);
    const runs = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE workflow_id=?").all(DOCS_MAINTENANCE) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ idem_key: "docs-maintenance:run-1:T1:0", status: "failed", reason: "step_failed:verdict", link_run_id: "run-1", link_task_id: "T1" });
    // The docs step keeps what the stage answered; the verdict step is what failed the run. The wall sees this one run, once.
    expect(db.prepare("SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='docs'").get(runs[0]!.id)).toEqual({ output_json: expect.stringContaining('"state":"failed"') });
    expect(collectEntries(db, { since: 0, until: Date.now() + 60_000, isReal: () => true }).map((entry) => `${entry.failureClass}:${entry.n}:${entry.sources.wf}`)).toEqual(["workflow:1:1"]);
    // The upkeep graphs tell no one: not the PM chat of the run, not the owner's list.
    const sent: unknown[] = [];
    const told = await maybeNotifyWorkflowRun({ bb: { sdk: { threads: { send: async (request: never) => { sent.push(request); } } }, storage: bb.storage as never }, log: () => undefined, run: { ...runs[0], status: "failed" } as never, pmThreadId: "thr_pm", startedBySchedule: false });
    expect(told).toBe(false);
    expect(sent).toEqual([]);
  });

  it("a unit with nothing to do is one run that ends after prepare, with the skipped row the pass reports", async () => {
    const projectId = "proj_docs_skip";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { files: { read: async () => { throw new Error("no such file"); } } as never, projects: { get: async () => ({ id: projectId, name: "P", sources: [{ hostId: "ovh", path: "/work/p", isDefault: true }] }) as never, list: async () => [{ id: projectId }] as never } },
      experimental_callHostRpc: (call) => {
        if (call.method === "gitDocsScope") return { hostId: "ovh", status: "ready", isRepoRoot: true, hasDocs: true, changed: [], dirty: [], base: null, workspaces: [], localDate: "2026-10-27", localHour: 4, reason: null };
        if (call.method === "gitCreateWorktree") return { hostId: "ovh", status: "failed", path: null, branch: null, reason: "no worktree in the test" };
        if (call.method === "listDocsPages") return (call.input as { roots?: string[] }).roots?.includes(".agents/decisions") ? { hostId: "ovh", pages: [], oversized: [] } : { hostId: "ovh", pages: [{ path: "docs/index.md", modifiedAt: 1, sha256: sha("x"), content: "---\ntitle: T\n---\n# T\n" }, { path: "docs/overview.md", modifiedAt: 1, sha256: sha("y"), content: "---\ntitle: O\n---\n# O\n" }], oversized: [] };
        if (call.method === "docsFlows") return { hostId: "ovh", briefPath: "/tmp/flows.md", jev: "disabled", routes: 0, flows: [] };
        if (call.method === "docsAnchors") return { hostId: "ovh", briefPath: "/tmp/brief.md", anchors: 0, jev: "disabled", tables: [], deploy: false, core: [], productFiles: [] };
        throw new Error(`stop at ${call.method}`);
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "ovh", pmWorkspacePath: "/work/p", writerWorkspacePath: "/work/p", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    saveProjectSetting(db, projectId, "docs.enabled", true);
    const result = await harness.behavior.runCli(["docs-nightly", projectId]) as { stdout: string };
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(rows).toEqual([expect.objectContaining({ projectId, state: "skipped", reason: "no code changes", docsDir: "docs" })]);
    const runs = db.prepare("SELECT status, output_json FROM lane_pilot_wf_run WHERE workflow_id=?").all(DOCS_NIGHT) as Array<{ status: string; output_json: string }>;
    expect(runs.map((run) => run.status)).toEqual(["succeeded"]);
    expect(JSON.parse(runs[0]!.output_json).row).toMatchObject({ state: "skipped" });
  });
});
