import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPureActions, type NodeExecutor } from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { registerCheckoutActions } from "../../src/rooms/workflow/server/services/workflow-checkout-actions";
import { engineOn, journalDb } from "./engine-helpers";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function setup(options: { failNode?: boolean; fix?: boolean; noFramework?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lp-inventory-engine-"));
  git(dir, "init", "-q"); git(dir, "config", "user.email", "test@example.test"); git(dir, "config", "user.name", "Test");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }));
  writeFileSync(join(dir, "test/base.test.js"), "const {test}=require('node:test'); test('base',()=>{});");
  git(dir, "add", "."); git(dir, "commit", "-qm", "baseline");
  const initialHead = git(dir, "rev-parse", "HEAD"), db = journalDb();
  db.exec("CREATE TABLE lane_pilot_run (id TEXT PRIMARY KEY, project_id TEXT, pm_thread_id TEXT, state TEXT, kind TEXT, closed_at INTEGER, writer_workspace_path TEXT, writer_environment_id TEXT, run_gate TEXT, run_policy_json TEXT, created_at INTEGER, writer_host_id TEXT)");
  db.prepare("INSERT INTO lane_pilot_run (id, project_id, writer_workspace_path, writer_host_id) VALUES (?, ?, ?, ?)").run("lp-run", "project", dir, "local");
  const host = { async call(_method: string, input: { command: string; cwd: string; requestedHostId: string }) {
    const p = spawnSync("bash", ["-c", input.command], { cwd: input.cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return { hostId: input.requestedHostId, exitCode: p.status ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
  } };
  const ctx = { db, host, bb: { sdk: { threads: { get: async () => ({ environmentId: "env" }) }, environments: { get: async () => ({ hostId: "local", path: dir }) } } } };
  const runtime = { ctx, runId: "lp-run", projectId: "project", pmThreadId: "pm" };
  const engine = engineOn(db, {}, { resolveWorkflow: id => builtinWorkflow(id) ?? null });
  registerPureActions(engine);
  registerCheckoutActions(engine, ctx as never, { action: (key, run) => engine.register(key, { reentrant: true, run: async c => ({ output: await run(c as never, runtime as never) }) }), planHome: async () => null, flagOf: () => false });
  let checks = 0, writes = 0;
  engine.register("lp-task", { reentrant: true, run: async c => {
    writes++;
    if (c.nodeId === "write_tests") writeFileSync(join(dir, "test/new.test.js"), `const {test}=require('node:test'); test('one',()=>{${options.failNode ? "throw Error('failure')" : ""}});`);
    else writeFileSync(join(dir, "test/new.test.js"), "const {test}=require('node:test'); test('one',()=>{}); test('two',()=>{});");
    git(dir, "add", "."); git(dir, "commit", "-qm", c.nodeId);
    return { output: { state: "accepted", files: ["test/new.test.js"], merge_commit: git(dir, "rev-parse", "HEAD") } };
  } });
  engine.register("lp.project_checks", { reentrant: true, run: async () => ({ output: { ok: !options.fix || checks++ > 0, no_framework: false, tests_passed: 1, tests_failed: 0, pass_rate: 100, failures: [] } }) });
  engine.register("agent", { reentrant: true, run: async c => ({ output: c.nodeId === "coverage" ? { gaps: [{ file: "src/a.js", layer: "L1", priority: "high" }], gap_count: 1, framework_found: !options.noFramework, handoff: "fixture" } : { test_defects: [{ id: "one" }], code_defects: [], env_issues: [], test_defect_count: 1, converged: false, handoff: "fixture" } }) });
  engine.register("quality-loop.classify", { reentrant: true, run: async () => ({ output: { failures: [], code_defects: [], test_defects: 0, env_issues: [], code_defect_count: 0, handoff: "fixture" } }) });
  const sub = engine.executors.get("builtin:subworkflow")! as NodeExecutor;
  engine.register("builtin:subworkflow", { ...sub, run: async c => c.nodeId === "review" ? { output: { status: "pass", findings: [], summary: "fixture" } } : sub.run(c) });
  const workflow = builtinWorkflow("test-gen")!;
  const start = () => engine.start({ workflow, inputs: { scope: "src", gaps: [{ file: "src/a.js" }] }, runtime });
  const startQuality = () => engine.start({ workflow: builtinWorkflow("quality-loop")!, inputs: { scope: "src" }, runtime });
  const close = () => { engine.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, db, engine, start, startQuality, close, initialHead, get writes() { return writes; } };
}

describe("inventory with real engine journal", () => {
  for (const node of ["baseline", "confirm"]) it(`refuses a new baseline after rerunning ${node}`, async () => {
    const f = setup();
    try {
      const run = f.start();
      expect((await run.done).output).toMatchObject({ status: "done", tests_added: 1 });
      expect(await f.engine.rerunNode(run.runId, node)).toMatchObject({ ok: true });
      await f.engine.idle();
      expect(f.engine.get(run.runId)?.output).toMatchObject({ status: "blocked", measurement_reason: expect.stringContaining("original baseline") });
      expect(f.engine.get(run.runId)?.output).not.toHaveProperty("tests_added");
      expect(f.writes).toBe(1);
    } finally { f.close(); }
  });
  it("uses the original baseline after an accepted fix and an inventory rerun", async () => {
    const f = setup({ fix: true });
    try {
      const run = f.start(); expect((await run.done).output).toMatchObject({ status: "done", tests_added: 2 });
      const row = f.db.prepare("SELECT output_json, receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='baseline' AND state='succeeded'").get(run.runId) as { output_json: string; receipt_json: string };
      expect(JSON.parse(row.receipt_json).executor).toBe("lp.test_inventory_baseline");
      expect(JSON.parse(row.output_json).receipt.before.head).toBe(f.initialHead);
      expect(await f.engine.rerunNode(run.runId, "inventory")).toMatchObject({ ok: true });
      await f.engine.idle(); expect(f.engine.get(run.runId)?.output).toMatchObject({ status: "done", tests_added: 2 });
    } finally { f.close(); }
  });
  for (const tamper of ["hash", "missing"]) it(`rejects ${tamper} baseline journal evidence on inventory rerun`, async () => {
    const f = setup();
    try {
      const run = f.start(); expect((await run.done).output).toMatchObject({ status: "done", tests_added: 1 });
      if (tamper === "hash") f.db.prepare("UPDATE lane_pilot_wf_step SET output_json=output_json || ' ' WHERE run_id=? AND node_id='baseline'").run(run.runId);
      else f.db.prepare("UPDATE lane_pilot_wf_step SET receipt_json=NULL WHERE run_id=? AND node_id='baseline'").run(run.runId);
      expect(await f.engine.rerunNode(run.runId, "inventory")).toMatchObject({ ok: true });
      await f.engine.idle();
      expect(f.engine.get(run.runId)?.output).toMatchObject({ status: "blocked" });
      expect(f.engine.get(run.runId)?.output).not.toHaveProperty("tests_added");
    } finally { f.close(); }
  });
  it("blocks a recreated test-gen child after its parent ancestor is rerun", async () => {
    const f = setup();
    try {
      const run = f.startQuality();
      expect((await run.done).output).toMatchObject({ status: "done", tests_added: 1 });
      expect(await f.engine.rerunNode(run.runId, "coverage")).toMatchObject({ ok: true });
      await f.engine.idle();
      expect(f.engine.get(run.runId)?.output).toMatchObject({ status: "blocked", measurement_reason: expect.stringContaining("original baseline") });
      expect(f.engine.get(run.runId)?.output).not.toHaveProperty("tests_added");
      expect(f.writes).toBe(1);
    } finally { f.close(); }
  });
  it("propagates a real blocked child and retains zero on the skipped child branch", async () => {
    const blocked = setup({ failNode: true }), skipped = setup({ noFramework: true });
    try {
      const a = await blocked.startQuality().done;
      expect(a.output).toMatchObject({ status: "blocked", measurement_reason: "node test runner reported failures" });
      expect(a.output).not.toHaveProperty("tests_added");
      expect((await skipped.startQuality().done).output).toMatchObject({ status: "done", tests_added: 0 });
      expect(skipped.writes).toBe(0);
    } finally { blocked.close(); skipped.close(); }
  });
  it("blocks when real Node fails but the check fixture says green", async () => {
    const f = setup({ failNode: true });
    try { const result = await f.start().done; expect(result.output).toMatchObject({ status: "blocked", measurement_reason: "node test runner reported failures" }); expect(result.output).not.toHaveProperty("tests_added"); }
    finally { f.close(); }
  });
});
