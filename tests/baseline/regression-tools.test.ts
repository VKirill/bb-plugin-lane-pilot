import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { ownsPathsOverlap } from "@lane-pilot/kit";
import { mountRegressionTools } from "../../src/rooms/baseline/server/regression-tools";
import { commandPathLiterals, quarantineFileSet } from "../../src/rooms/baseline/regress-files";
import { insertRegression, type RegressionRecord } from "../../src/rooms/baseline/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import type { Services } from "../../src/rooms/platform/server";
import { world } from "./world";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "/project";

type Mounted = { tools: Map<string, { name: string; parameters?: { safeParse: (v: unknown) => { success: boolean } }; execute: (input: unknown, context: unknown) => Promise<unknown> }> };

/** The two lane_pilot_regression members on a stub agents registry; execute is what the family calls. */
function mount(db: ReturnType<typeof openDatabase>, services: unknown) {
  const mounted: Mounted = { tools: new Map() };
  const ctx = { bb: { agents: { registerTool: (tool: Mounted["tools"] extends Map<string, infer T> ? T & { name: string } : never) => mounted.tools.set(tool.name, tool as never) },
    sdk: { threads: { getPluginMetadata: async () => null } } }, db };
  mountRegressionTools(ctx as never, services as Services);
  return {
    tools: mounted.tools,
    call: (name: string, input: unknown, context: Record<string, unknown>) => {
      const tool = mounted.tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.execute(input, { threadId: "thr_pm", projectId: "projA", signal: new AbortController().signal, ...context });
    },
  };
}

const pm = { experimental_vkPluginMetadata: { role: "pm" } };

function seed() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "runA", "projA", "bb", BASE, "none", undefined, "host-1");
  createRun(db, "runB", "projB", "bb", BASE, "none", undefined, "host-1");
  const contract = (owns: string[]) => ({ project_cwd: BASE, owns_paths: owns });
  createTask(db, { id: "cab-editor-friendly", runId: "runA", kind: "bb", contract: contract([".agents/prototypes/site/home-v2/visual/editor.html"]) });
  createTask(db, { id: "cab-editor-real.2", runId: "runA", kind: "bb", contract: contract([".agents/prototypes/site/home-v2/visual/editor.html"]) });
  createTask(db, { id: "cab-editor-fix", runId: "runA", kind: "bb", contract: contract([".agents/prototypes/site/home-v2/visual/editor.html"]) });
  createTask(db, { id: "cab-core-brace", runId: "runA", kind: "bb", contract: contract([".agents/prototypes/site/home-v2/visual/css/cab-core.css"]) });
  createAttempt(db, { id: "att_brace", runId: "runA", taskId: "cab-core-brace" });
  createAttempt(db, { id: "att_fix", runId: "runA", taskId: "cab-editor-fix" });
  return db;
}

/** The row of the incident: the editor-hints check on the two editor.html files. */
function openRow(db: ReturnType<typeof openDatabase>, projectId = "projA"): number {
  return insertRegression(db, {
    projectId, runId: "runA", taskId: "cab-editor-friendly", attemptId: null,
    command: `for p in editor.html; do grep -q 'Мои правки' '.agents/prototypes/'+p; done`,
    kind: "regression", greenAt: null, redAt: "headsha", bisectStatus: "found",
    culpritCommit: "c0ffee", culpritTask: "cab-editor-real.2", culpritSubject: "remove the hints", note: "the culprit task changed the same file(s)",
    evidence: { output: "grep: no match", sharedFiles: [".agents/prototypes/site/home-v2/visual/editor.html"] },
  });
}

describe("the files a regression quarantines (narrowed, B)", () => {
  const row = { command: "", culpritTask: "culprit", taskId: "broken", evidence: { sharedFiles: ["editor.html"] } } as unknown as RegressionRecord;

  it("reads path literals of a check command, quoted or bare, and joins literal+literal", () => {
    expect(commandPathLiterals(`grep -q 'Мои правки' .agents/prototypes/site/home-v2/visual/editor.html`)).toEqual([".agents/prototypes/site/home-v2/visual/editor.html"]);
    expect(commandPathLiterals(`grep -q '"version"' package.json && npm test`)).toEqual(["package.json"]);
    // a prefix literal joined to a variable names no file; joined to a literal it counts
    expect(commandPathLiterals(`for p in editor.html; do grep -q x '.agents/prototypes/'+p; done`)).toEqual(["editor.html"]);
    expect(commandPathLiterals(`grep -q x '.agents/prototypes/'+'site/home-v2/visual/editor.html'`)).toContain(".agents/prototypes/site/home-v2/visual/editor.html");
  });

  it("keeps a task that owns none of the check's files out of the quarantine — the incident's brace task", () => {
    const files = quarantineFileSet({ ...row, command: `grep -q x '.agents/prototypes/'+p` }, () => ["editor.html", "cab-core.css"]);
    // sharedFiles + literals: only editor.html; the changed-files union (which would have held the brace task) is not used
    expect(files).toEqual(["editor.html"]);
    expect(ownsPathsOverlap([".agents/prototypes/site/home-v2/visual/css/cab-core.css"], files)).toBe(false);
    expect(ownsPathsOverlap(["editor.html"], files)).toBe(true);
    expect(ownsPathsOverlap([".agents/prototypes/site/home-v2/visual/editor.html"], ["editor.html", ".agents/prototypes/site/home-v2/visual/editor.html"])).toBe(true);
  });

  it("falls back to the changed-files union only when nothing is known about the check", () => {
    expect(quarantineFileSet({ ...row, command: "npm run secret-check", evidence: {} } as RegressionRecord, (id) => (id === "culprit" ? ["a.ts"] : ["b.ts"]))).toEqual(["a.ts", "b.ts"]);
  });
});

describe("lane_pilot_regression list / settle (A)", () => {
  it("lists the open rows of the caller's project with the tasks that wait on each", async () => {
    const db = seed();
    const services = { rollback: { status: () => ({ attempts: [] }) } };
    openRow(db);
    const { call } = mount(db, services);
    const out = JSON.parse(String(await call("lane_pilot_regression_list", {}, {}))) as { open: Array<Record<string, unknown>> };
    expect(out.open).toHaveLength(1);
    expect(out.open[0]).toMatchObject({
      task: "cab-editor-friendly", culprit_task: "cab-editor-real.2",
      shared_files: [".agents/prototypes/site/home-v2/visual/editor.html"],
      // the narrowed files hold the task owning editor.html, not the brace task that only owns cab-core.css
      waiting: ["cab-editor-fix"],
    });
    expect(String(out.open[0]!.check)).toContain("editor.html");
  });

  it("settles an open row of the project through RegressionApi.close, storing the PM's reason", async () => {
    const db = seed();
    const closed: Array<{ id: number; reason: string }> = [];
    const services = { rollback: { status: () => ({ attempts: [] }) }, regression: { close: (id: number, reason: string) => (closed.push({ id, reason }), { ok: true, reason }) } };
    const id = openRow(db);
    const { call } = mount(db, services);
    const out = JSON.parse(String(await call("lane_pilot_regression_settle", { id, reason: "the hints were removed on purpose" }, pm))) as { ok: boolean; closed_reason: string };
    expect(out.ok).toBe(true);
    expect(out.closed_reason).toBe("settled by PM thr_pm: the hints were removed on purpose");
    expect(closed).toEqual([{ id, reason: "settled by PM thr_pm: the hints were removed on purpose" }]);
  });

  it("refuses a non-PM caller, a missing row, a closed row and a row of another project; the schema refuses a short reason", async () => {
    const db = seed();
    const services = { rollback: { status: () => ({ attempts: [] }) }, regression: { close: () => ({ ok: false, reason: "closed" }) } };
    const id = openRow(db);
    const other = insertRegression(db, { projectId: "projB", runId: "runB", taskId: "other-task", attemptId: null, command: "npm test", kind: "regression",
      greenAt: null, redAt: "head", bisectStatus: "found", culpritCommit: null, culpritTask: "other-culprit", culpritSubject: null, note: null, evidence: {} });
    const { call, tools } = mount(db, services);
    const text = async (...args: Parameters<typeof call>) => String(await call(...args));
    expect(await text("lane_pilot_regression_settle", { id, reason: "the hints were removed on purpose" }, {})).toContain("not a Lane Pilot PM thread");
    expect(await text("lane_pilot_regression_settle", { id: 99999, reason: "the hints were removed on purpose" }, pm)).toContain("lane_pilot_regression {action:");
    expect(await text("lane_pilot_regression_settle", { id: other, reason: "the hints were removed on purpose" }, pm)).toContain("another project");
    db.prepare("UPDATE lane_pilot_regression SET state='closed', closed_reason='done' WHERE id=?").run(id);
    expect(await text("lane_pilot_regression_settle", { id, reason: "the hints were removed on purpose" }, pm)).toContain("closed already");
    expect(tools.get("lane_pilot_regression_settle")!.parameters!.safeParse({ id, reason: "short" }).success).toBe(false);
  });
});

describe("a meant change settles itself (C)", () => {
  it("closes the row at Jev p ≥ 0.9, notes the p and asks once per culprit below the threshold, never guesses with Jev down", async () => {
    const { setJevForTests } = await import("@lane-pilot/jev");
    const w = await world();
    try {
      await w.acceptedTask("A", async (dir) => { await writeFile(join(dir, "a.txt"), "a\n"); }, ["test -f a.txt"]);
      await w.acceptedTask("B", async (dir) => { await rm(join(dir, "a.txt")); }, ["test -f b.txt"]);
      const put = () => insertRegression(w.db, { projectId: "projA", runId: "run1", taskId: "A", attemptId: "att_A", command: "test -f a.txt", kind: "regression",
        greenAt: null, redAt: "head", bisectStatus: "found", culpritCommit: "c0ffee", culpritTask: "B", culpritSubject: null, note: null, evidence: { output: "missing" } });

      // Jev down (not installed): the row stays open, nothing is marked.
      setJevForTests(null);
      const down = put();
      await w.services.regression.run({ projectId: "projA", force: true });
      expect((w.db.prepare("SELECT state FROM lane_pilot_regression WHERE id=?").get(down) as { state: string }).state).toBe("open");

      // p = 0.95: the row closes itself with the culprit's contract phrase in the reason.
      let calls = 0;
      setJevForTests({ enabled: () => true, judge: async () => (calls += 1, { by: "jev", decision: { meant: true, p: 0.95 }, receiptId: 1, answers: {} }) } as never);
      await w.services.regression.run({ projectId: "projA", force: true });
      const closedRow = w.db.prepare("SELECT state, closed_reason FROM lane_pilot_regression WHERE id=?").get(down) as { state: string; closed_reason: string };
      expect(closedRow.state).toBe("closed");
      expect(closedRow.closed_reason).toContain("meant by B (Jev p=0.95):");
      expect(calls).toBeGreaterThanOrEqual(1);

      // p = 0.6: stays open, the probability lands in the note and in evidence.meant, and the next pass does not ask again.
      calls = 0;
      setJevForTests({ enabled: () => true, judge: async () => (calls += 1, { by: "jev", decision: { meant: false, p: 0.6 }, receiptId: 1, answers: {} }) } as never);
      const low = put();
      await w.services.regression.run({ projectId: "projA", force: true });
      const lowRow = w.db.prepare("SELECT state, note, evidence_json FROM lane_pilot_regression WHERE id=?").get(low) as { state: string; note: string; evidence_json: string };
      expect(lowRow.state).toBe("open");
      expect(lowRow.note).toContain("Jev p=0.60");
      expect(lowRow.note).toContain("B did not mean it");
      const afterFirst = calls;
      await w.services.regression.run({ projectId: "projA", force: true });
      expect(calls).toBe(afterFirst);
    } finally {
      const { setJevForTests } = await import("@lane-pilot/jev");
      setJevForTests(null);
      await w.dispose();
    }
  });
});
