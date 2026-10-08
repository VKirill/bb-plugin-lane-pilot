import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { createWorkflowLibrary } from "../../src/rooms/workflow/server/workflow-library";
import { createWorkflowOps } from "../../src/rooms/workflow/server/workflow-ops";
import { createStatusResolver } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok, wf } from "./engine-helpers";
import { workflow } from "./fixtures";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A chain with an outside call: it posts to Telegram, which only a live run may do. */
const digest = (extra: Record<string, unknown> = {}) => workflow({
  id: "x-digest", name: "X digest", status: "published",
  nodes: [
    { id: "search", type: "action", action: "x.search", output: [{ name: "items", type: "array" }] },
    { id: "post", type: "action", action: "telegram.send", output: [{ name: "text", type: "string" }] },
  ],
  edges: [{ from: "start", to: "search" }, { from: "search", to: "post", with: { items: "search.items" } }, { from: "post", to: "end", with: { result: "post.text" } }],
  ...extra,
});

async function world(files: Record<string, unknown> = { "x-digest.json": digest() }) {
  const db = journalDb();
  const globalDir = await mkdtemp(join(tmpdir(), "lp-wf-ops-"));
  dirs.push(globalDir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(globalDir, name), JSON.stringify(content));
  const sent: string[] = [];
  const engine = engineOn(db, { "x.search": ok(() => ({ items: ["live"] })), "telegram.send": ok(() => { sent.push("live send"); return { text: "sent" }; }) }, { resolveWorkflow: () => null });
  const ctx = { db, log: () => undefined, host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
  const services = { workflowEngine: engine, docsPlaces: async () => [] } as unknown as Services;
  const library = createWorkflowLibrary(ctx, services, { globalDir });
  return { db, engine, sent, library, ops: createWorkflowOps(ctx, services, library) };
}

describe("run history", () => {
  it("pages the runs of one workflow, newest first", async () => {
    const { db, ops } = await world();
    const def = JSON.stringify(wf({ id: "demo" }));
    for (let at = 1; at <= 5; at += 1) {
      db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`r${at}`, at === 3 ? "other" : "demo", 1, "x", def, "p1", "succeeded", at * 10, at * 10);
    }
    const first = ops.runs({ id: "demo", limit: 2 });
    expect(first.runs.map((row) => row.id)).toEqual(["r5", "r4"]);
    expect(first.hasMore).toBe(true);
    const second = ops.runs({ id: "demo", limit: 2, before: first.runs.at(-1)!.createdAt });
    expect(second.runs.map((row) => row.id)).toEqual(["r2", "r1"]);
    expect(second.hasMore).toBe(false);
    expect(ops.runs({ id: "demo", limit: 5, projectId: "nobody" }).runs).toEqual([]);
  });
});

describe("re-running a node through the tab's action", () => {
  it("re-runs a node and refuses the per-task pipeline's runs and unknown runs", async () => {
    const { engine, ops } = await world();
    let calls = 0;
    const flaky = engineOn(journalDb(), { search: ok(() => ({ items: [], count: 0, kind: "fresh" })), write: ok(() => { calls += 1; if (calls === 1) throw new Error("down"); return { text: "ok" }; }) });
    const started = flaky.start({ workflow: wf(), inputs: { query: "q" } });
    await started.done;
    const flakyOps = createWorkflowOps({ db: flaky.journal.db, log: () => undefined } as unknown as ServerCore, { workflowEngine: flaky } as unknown as Services, { loadStore: async () => { throw new Error("unused"); } } as never);
    expect(await flakyOps.rerunNode({ runId: started.runId, nodeId: "write" })).toMatchObject({ ok: true, stepKey: "write#1" });
    await flaky.idle();
    expect(flaky.get(started.runId)?.status).toBe("succeeded");
    expect(await ops.rerunNode({ runId: "wfrun_missing", nodeId: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(engine.get("wfrun_missing")).toBeNull();
  });
});

describe("dry run and the tests of a workflow file", () => {
  it("runs the chain with every outside action stubbed, whatever its status", async () => {
    const { ops, sent, db } = await world();
    const dry = await ops.dryRun({ id: "x-digest", input: {} });
    expect(dry.found).toBe(true);
    expect(dry.result).toMatchObject({ status: "succeeded", path: ["search", "post"], failedNode: null });
    expect(dry.stubbed).toEqual(["search (action: x.search)", "post (action: telegram.send)"]);
    expect(sent).toEqual([]);
    // The dry run is journaled under its own id, so it does not count as a run of the workflow.
    const rows = db.prepare("SELECT DISTINCT workflow_id FROM lane_pilot_wf_run").all();
    expect(rows).toEqual([{ workflow_id: "draft-test.x-digest" }]);
    expect(await ops.dryRun({ id: "nope", input: {} })).toEqual({ found: false, result: null, stubbed: [] });
  });

  it("a file that says published is a draft until its tests have passed, and counts as published after", async () => {
    const { ops, library } = await world();
    const shown = async () => (await library.list({})).workflows.find((row) => row.id === "x-digest")!;
    expect(await shown()).toMatchObject({ status: "draft" });
    expect((await library.get({ id: "x-digest" })).workflow!.warningMessages.join(" ")).toContain("no green test run");
    const tested = await ops.runTests({ id: "x-digest" });
    expect(tested).toMatchObject({ found: true, green: true, status: "published" });
    expect(await shown()).toMatchObject({ status: "published" });
  });

  it("a red test keeps the file a draft, and editing the file afterwards drops the receipt", async () => {
    const red = digest({ test: { id: "main", sim: { expect_path: ["search"] } } });
    const { ops, library, db } = await world({ "x-digest.json": red });
    const result = await ops.runTests({ id: "x-digest" });
    expect(result.green).toBe(false);
    expect(result.cases[0]!.failures.join(" ")).toContain("path");
    expect((await library.list({})).workflows.find((row) => row.id === "x-digest")).toMatchObject({ status: "draft" });
    expect(db.prepare("SELECT green FROM lane_pilot_wf_test").all()).toEqual([{ green: 0 }]);
  });

  it("a tested workflow becomes published once a live run of its version succeeded", async () => {
    const { engine, library, db } = await world({ "x-digest.json": digest({ status: "tested" }) });
    createStatusResolver(db).recordTest("x-digest", (await library.get({ id: "x-digest" })).workflow!.sha256, true, []);
    const status = async () => (await library.list({})).workflows.find((row) => row.id === "x-digest")!.status;
    expect(await status()).toBe("tested");
    const workflowRow = (await library.loadStore()).store.get("x-digest")!.workflow;
    const started = engine.start({ workflow: workflowRow, inputs: { query: "q" } });
    expect((await started.done).status).toBe("succeeded");
    expect(await status()).toBe("published");
    // A newer version of the file is a new thing to prove.
    db.prepare("UPDATE lane_pilot_wf_run SET workflow_version=0").run();
    expect(await status()).toBe("tested");
  });
});
