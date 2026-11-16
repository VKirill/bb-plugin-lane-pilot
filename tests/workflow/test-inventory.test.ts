import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { measureTestInventory, diffTestInventory, parseInventory } from "../../src/rooms/workflow/server/test-inventory";
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
      expect(await diffTestInventory(host, baseline.receipt, after.receipt, merge, ["test/a.test.js"])).toMatchObject({ status: "measured", testsAdded: 3, expectedFailureAdded: 1 });
      expect(() => parseInventory(after.receipt.raw.replace(/\{"type":"lp:end"\}\n/, ""), after.receipt.nonce)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses unsupported scripts, duplicates, and file load failures", async () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } })); commit(dir);
      expect((await measureTestInventory(host, "local", dir)).status).toBe("unsupported");
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
      writeFileSync(join(dir, "test/b.test.js"), "// dirty after receipt");
      expect((await diffTestInventory(host, base.receipt, after.receipt, merge, ["test/b.test.js"])).status).toBe("unavailable");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
