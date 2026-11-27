import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerCheckoutActions } from "../../src/rooms/workflow/server/services/workflow-checkout-actions";
import { execFileSync, spawnSync } from "node:child_process";
import { measureTestInventory, diffTestInventory, parseInventory, RUNNER_NODE_MAJORS } from "../../src/rooms/workflow/server/services/test-inventory";
import type { ServerCore } from "../../src/rooms/contracts/server";

const host = { async call(_method: string, input: { command: string; cwd: string; requestedHostId: string }) {
  const p = spawnSync("bash", ["-c", input.command], { cwd: input.cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return { hostId: input.requestedHostId, exitCode: p.status ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
} } as unknown as ServerCore["host"];
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lp-inventory-test-"));
  git(dir, "init", "-q"); git(dir, "config", "user.email", "test@example.test"); git(dir, "config", "user.name", "Test");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }));
  writeFileSync(join(dir, "test/a.test.js"), "const {test}=require('node:test');\ntest('one',()=>{});\ntest('two',()=>{});\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "base"); return dir;
}
function commit(dir: string) { git(dir, "add", "."); git(dir, "commit", "-qm", "change"); return git(dir, "rev-parse", "HEAD"); }
describe("node runner inventory", () => {
  it("measures executed new cases in existing files without counting line moves", async () => {
    const dir = fixture();
    try {
      const baseline = await measureTestInventory(host, "local", dir);
      expect(baseline).toMatchObject({ status: "measured" });
      if (baseline.status !== "measured") throw Error(baseline.reason);
      writeFileSync(join(dir, "test/a.test.js"), "const {test}=require('node:test');\n\ntest('one',()=>{});\ntest('two',()=>{});\ntest('three',()=>{});\ntest('four',()=>{});\ntest('five',()=>{});\ntest('xfail',{expectFailure:true},()=>{throw Error('expected')});\ntest.skip('skip',()=>{});\ntest.todo('todo');\n");
      const merge = commit(dir), after = await measureTestInventory(host, "local", dir);
      expect(after).toMatchObject({ status: "measured" });
      if (after.status !== "measured") throw Error(after.reason);
      // Node 22 has no expectFailure option: there the xfail case is an ordinary failing test.
      const xfail = spawnSync("node", ["-e", "require('node:test').test('x',{expectFailure:true},()=>{throw Error('x')})"], { cwd: dir }).status === 0;
      expect(await diffTestInventory(host, baseline.receipt, after.receipt, merge, ["test/a.test.js"])).toMatchObject({ status: "measured", testsAdded: xfail ? 3 : 4, expectedFailureAdded: xfail ? 1 : 0 });
      expect(() => parseInventory(after.receipt.raw.replace(/\{"type":"lp:end"\}\n/, ""), after.receipt.nonce)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("measures on every Node major the plugin's engines field supports", () => {
    const engines = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")).engines.node as string;
    expect([...RUNNER_NODE_MAJORS]).toEqual([...engines.matchAll(/\^(\d+)\./g)].map((m) => m[1]));
  });
  it("refuses unsupported scripts, duplicates, and file load failures", async () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } })); commit(dir);
      expect((await measureTestInventory(host, "local", dir)).status).toBe("unsupported");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js test/missing*.js" } })); commit(dir);
      expect((await measureTestInventory(host, "local", dir)).status).toBe("unavailable");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test test/a.test.js test/missing.test.js" } })); commit(dir);
      expect((await measureTestInventory(host, "local", dir)).status).toBe("unavailable");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js test/a.test.js" } })); commit(dir);
      const overlap = await measureTestInventory(host, "local", dir);
      expect(overlap.status).toBe("measured");
      if (overlap.status === "measured") expect(overlap.receipt.cases).toHaveLength(2);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }));
      writeFileSync(join(dir, "test/a.test.js"), "const {test}=require('node:test'); test('same',()=>{}); test('same',()=>{});"); commit(dir);
      expect((await measureTestInventory(host, "local", dir)).status).toBe("unavailable");
      writeFileSync(join(dir, "test/a.test.js"), "throw Error('load failed');"); commit(dir);
      expect((await measureTestInventory(host, "local", dir)).status).toBe("unavailable");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("measures a new file and rejects stale or unbound revisions", async () => {
    const dir = fixture();
    try {
      const base = await measureTestInventory(host, "local", dir);
      if (base.status !== "measured") throw Error(base.reason);
      writeFileSync(join(dir, "test/b.test.js"), "const {test}=require('node:test'); test('new',()=>{}); test('fails',()=>{throw Error('expected test failure')}); test('parent',async t=>{await t.test('child',()=>{})});");
      const merge = commit(dir), after = await measureTestInventory(host, "local", dir);
      if (after.status !== "measured") throw Error(after.reason);
      expect(after.receipt.parentTests).toBe(1);
      expect(await diffTestInventory(host, base.receipt, after.receipt, merge, ["test/b.test.js"])).toMatchObject({ status: "measured", testsAdded: 3 });
      expect((await diffTestInventory(host, base.receipt, after.receipt, merge, ["test/a.test.js"])).status).toBe("unavailable");
      let called = false;
      const unsafeHost = { ...host, async call() { called = true; throw Error("unexpected host call"); } } as unknown as ServerCore["host"];
      const malicious = { ...base.receipt, after: { ...base.receipt.after, head: "'; touch injected; echo '" } };
      expect((await diffTestInventory(unsafeHost, malicious, after.receipt, merge, ["test/b.test.js"])).status).toBe("unavailable");
      expect(called).toBe(false);
      const maliciousAfter = { ...after.receipt, after: { ...after.receipt.after, head: "'; touch injected; echo '" } };
      expect((await diffTestInventory(unsafeHost, base.receipt, maliciousAfter, merge, ["test/b.test.js"])).status).toBe("unavailable");
      expect(called).toBe(false);
      writeFileSync(join(dir, "test/b.test.js"), "// dirty after receipt");
      expect((await diffTestInventory(host, base.receipt, after.receipt, merge, ["test/b.test.js"])).status).toBe("unavailable");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("registered actions retain the original journal baseline and block a failed fix", async () => {
    const dir = fixture();
    try {
      type Saved = { rowid: number; node_id: string; output_json: string; receipt_json: string };
      const rows: Saved[] = [];
      let claimed = false;
      const db = { transaction: (fn: () => unknown) => fn, prepare(sql: string) { return {
        get() { if (sql.includes("FROM lane_pilot_wf_run")) return { parent_run_id: null, parent_step_key: null }; if (sql.includes("inventory_baseline_claim")) return claimed ? { found: 1 } : undefined; if (sql.includes("writer_host_id")) return { writer_host_id: "local" }; if (sql.includes("lane_pilot_run")) return { id: "lp-run", project_id: "project", writer_workspace_path: dir }; return undefined; },
        all() { return rows; },
      }; } };
      const ctx = { db, host, bb: { sdk: { threads: { get: async () => ({ environmentId: "env" }) }, environments: { get: async () => ({ hostId: "local", path: dir }) } } } };
      const rt = { ctx, runId: "lp-run", projectId: "project", pmThreadId: "pm" };
      const actions = new Map<string, (c: never, rt: never) => Promise<Record<string, unknown>>>();
      registerCheckoutActions({ journal: { event: () => { claimed = true; } } } as never, ctx as never, { action: (key, fn) => { actions.set(key, fn as never); }, planHome: async () => null, flagOf: () => false });
      const step = { runId: "graph-run", nodeId: "baseline", stepKey: "baseline#1", workflow: { id: "test-gen" } } as never;
      const save = (node_id: string, executor: string, output: Record<string, unknown>) => {
        const output_json = JSON.stringify(output), outputSha256 = createHash("sha256").update(output_json).digest("hex");
        rows.push({ rowid: rows.length + 1, node_id, output_json, receipt_json: JSON.stringify({ executor, outputSha256 }) });
      };
      const baseline = await actions.get("lp.test_inventory_baseline")!(step, rt as never);
      expect(baseline.status).toBe("measured"); save("baseline", "lp.test_inventory_baseline", baseline);
      writeFileSync(join(dir, "test/b.test.js"), "const {test}=require('node:test'); test('one new case',()=>{});");
      const merge = commit(dir);
      save("write_tests", "lp-task", { state: "accepted", files: ["test/b.test.js"], merge_commit: merge });
      expect(await actions.get("lp.test_inventory_after")!(step, rt as never)).toMatchObject({ status: "measured", tests_added: 1 });
      expect(await actions.get("lp.test_inventory_baseline")!(step, rt as never)).toMatchObject({ status: "unavailable" });
      writeFileSync(join(dir, "test/b.test.js"), "const {test}=require('node:test'); test('one new case',()=>{}); test('second new case',()=>{});");
      const fixMerge = commit(dir);
      save("fix_tests", "lp-task", { state: "accepted", merge_commit: fixMerge });
      expect(await actions.get("lp.test_inventory_after")!(step, rt as never)).toMatchObject({ status: "measured", tests_added: 2 });
      save("fix_tests", "lp-task", { state: "blocked", merge_commit: "" });
      expect(await actions.get("lp.test_inventory_after")!(step, rt as never)).toMatchObject({ status: "unavailable" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
