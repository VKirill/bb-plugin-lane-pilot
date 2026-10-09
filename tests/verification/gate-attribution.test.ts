import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnAsync } from "@lane-pilot/kit";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { IntegrationGateRunner, type MergedTaskInfo } from "../../src/rooms/verification/server/integration-gate";
import { attributeFailures } from "../../src/rooms/verification/server/gate-attribution";
import { attributeGateOnHost } from "../../src/rooms/verification/integration-gate-host";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import * as hostHandlers from "../../src/rooms/host-worker/host-handlers";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";

/**
 * Live 2026-10-09 (SelfyStudio): the gate blamed tasks whose diff lay in other packages (scene-compile-route-log-child-sanitize
 * changed only packages/scene-compile, yet got the fix turn for admin and image-providers failures that already failed on the
 * base commit). A failing test is a task's only when its diff touches the test file or the test's workspace, and only when the
 * test passes on the base the batch started from.
 */

// A repo with three workspaces. A workspace's tests fail while any file in its src/ or tests/ says BROKEN, which the fake vitest
// (run from the workspace folder, as the host does) and the gate script both read.
const FAKE_VITEST = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const broken = ["src", "tests"].some((d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => fs.readFileSync(path.join(d, f), "utf8").includes("BROKEN")));
let code = 0;
for (const file of process.argv.slice(2).filter((arg) => arg !== "run")) { if (broken) { console.log(" FAIL  " + file + " > suite > case"); code = 1; } }
process.exit(code);
`;
const GATE_SCRIPT = `const fs = require("fs"), path = require("path");
let code = 0;
for (const [pkg, dir, test] of [["@acme/admin", "apps/admin", "admin"], ["@acme/web", "apps/web", "web"], ["@acme/lib-a", "packages/lib-a", "lib-a"]]) {
  const broken = ["src", "tests"].some((d) => fs.readdirSync(path.join(dir, d)).some((f) => fs.readFileSync(path.join(dir, d, f), "utf8").includes("BROKEN")));
  console.log(pkg + ":test:  " + (broken ? "FAIL" : "✓") + "  tests/" + test + ".test.ts" + (broken ? " > suite > case" : " (1 test)"));
  if (broken) code = 1;
}
process.exit(code);
`;

describe("which merged task a red gate is pinned on", () => {
  let repo: string;
  let db: ReturnType<typeof openDatabase>;
  let sent: Array<{ threadId: string; text: string }>;
  let core: ServerCore;

  const sh = async (file: string, args: string[]) => {
    const ran = await spawnAsync(file, args, { cwd: repo, timeout: 60_000 });
    if (ran.status !== 0) throw new Error(`${file} ${args.join(" ")}: ${ran.stderr}`);
    return ran.stdout.trim();
  };
  const write = (path: string, content: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    await sh("git", ["add", "-A"]);
    await sh("git", ["commit", "-q", "-m", message]);
    return await sh("git", ["rev-parse", "HEAD"]);
  };
  const task = (taskId: string, commitSha: string, produced: string[]): MergedTaskInfo => ({ taskId, commitSha, threadId: `thr-${taskId}`, attemptId: `att-${taskId}`, produced });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "lp-gate-attr-"));
    await sh("git", ["init", "-q", "-b", "main"]);
    await sh("git", ["config", "user.email", "t@t"]);
    await sh("git", ["config", "user.name", "t"]);
    write(".gitignore", "node_modules\n");
    write("node_modules/.bin/vitest", FAKE_VITEST);
    chmodSync(join(repo, "node_modules/.bin/vitest"), 0o755);
    // Base: the admin workspace is broken already.
    await commit("base", {
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
      "gate.js": GATE_SCRIPT,
      "apps/admin/package.json": JSON.stringify({ name: "@acme/admin", scripts: { test: "vitest run" } }),
      "apps/admin/src/x.ts": "export const admin = 'BROKEN';\n",
      "apps/admin/tests/admin.test.ts": "// admin\n",
      "apps/web/package.json": JSON.stringify({ name: "@acme/web", scripts: { test: "vitest run" } }),
      "apps/web/src/x.ts": "export const web = 1;\n",
      "apps/web/tests/web.test.ts": "// web\n",
      "packages/lib-a/package.json": JSON.stringify({ name: "@acme/lib-a", scripts: { test: "vitest run" } }),
      "packages/lib-a/src/a.ts": "export const a = 1;\n",
      "packages/lib-a/tests/lib-a.test.ts": "// lib\n",
    });
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    db = openDatabase(bb);
    db.prepare(`INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES ('run-1', 'proj-1', 'pm-1', 'running', 0, 0)`).run();
    saveProjectSetting(db, "proj-1", "integration.gate_command", "node gate.js");
    sent = [];
    core = {
      db,
      bb: { sdk: { threads: { send: async (input: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" }); } }, files: { write: async () => ({ ok: true }) } }, storage: { kv: { get: async () => null, set: async () => null } } },
      log: () => {},
      host: { call: async (method: string, input: unknown) => (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input) },
    } as unknown as ServerCore;
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  const run = (runner: IntegrationGateRunner) => runner.maybeRunGate({ runId: "run-1", projectId: "proj-1", pmThreadId: "pm-1", basePath: repo, configHostId: "host-1", trigger: "drain" });
  const toWriters = () => sent.filter((m) => m.threadId.startsWith("thr-"));
  const toPm = () => sent.filter((m) => m.threadId === "pm-1");

  it("does not blame the only merged task when it changed another package and the failures were there before", async () => {
    const lib = await commit("lib task", { "packages/lib-a/src/a.ts": "export const a = 2;\n" });
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(task("scene-compile-like", lib, ["packages/lib-a/src/a.ts"]));

    const res = await run(runner);

    expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: null });
    expect(toWriters()).toEqual([]);
    expect(toPm()[0]!.text).toContain("pre-existing");
    expect(toPm()[0]!.text).toContain("@acme/admin: tests/admin.test.ts");
  });

  it("pins the failure the batch broke on the task that touched that workspace, and calls the old failure pre-existing", async () => {
    const lib = await commit("lib task", { "packages/lib-a/src/a.ts": "export const a = 2;\n" });
    const web = await commit("web task", { "apps/web/src/x.ts": "export const web = 'BROKEN';\n" });
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(task("lib", lib, ["packages/lib-a/src/a.ts"]));
    runner.noteMergedTask(task("web", web, ["apps/web/src/x.ts"]));

    const res = await run(runner);

    expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: "web" });
    expect(toWriters().map((m) => m.threadId)).toEqual(["thr-web"]);
    expect(toWriters()[0]!.text).toContain("@acme/web: tests/web.test.ts");
    expect(toWriters()[0]!.text).toContain("fail without your change too (not yours, leave them): @acme/admin: tests/admin.test.ts");
    expect(toPm()[0]!.text).toContain("Pre-existing");
    expect(toPm()[0]!.text).toContain("@acme/admin: tests/admin.test.ts");
  });

  it("does not bisect to a task whose diff misses the failing workspace", async () => {
    const lib = await commit("lib task", { "packages/lib-a/src/a.ts": "export const a = 2;\n" });
    const web1 = await commit("web task one", { "apps/web/src/x.ts": "export const web = 2;\n" });
    const web2 = await commit("web task two", { "apps/web/src/y.ts": "export const web2 = 'BROKEN';\n" });
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(task("lib", lib, ["packages/lib-a/src/a.ts"]));
    runner.noteMergedTask(task("web-one", web1, ["apps/web/src/x.ts"]));
    runner.noteMergedTask(task("web-two", web2, ["apps/web/src/y.ts"]));

    const res = await run(runner);

    // Two tasks touched apps/web, nothing says which: no culprit, and certainly no fix turn to the lib task.
    expect(res.culpritTaskId).not.toBe("lib");
    expect(toWriters().map((m) => m.threadId)).not.toContain("thr-lib");
  });
});

describe("attributeGateOnHost", () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "lp-gate-host-attr-")); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });
  const sh = async (args: string[]) => {
    const ran = await spawnAsync("git", args, { cwd: repo, timeout: 60_000 });
    if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
    return ran.stdout.trim();
  };

  it("reports a commit's changed paths and their workspaces, places a failing test by its turbo package, and skips the base run without a base", async () => {
    await sh(["init", "-q", "-b", "main"]);
    await sh(["config", "user.email", "t@t"]);
    await sh(["config", "user.name", "t"]);
    for (const [path, content] of Object.entries({
      "package.json": JSON.stringify({ name: "root" }),
      "apps/web/package.json": JSON.stringify({ name: "@acme/web" }),
      "apps/web/tests/a.test.ts": "x",
      "packages/lib/package.json": JSON.stringify({ name: "@acme/lib" }),
      "packages/lib/src/i.ts": "x",
    })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
    await sh(["add", "-A"]); await sh(["commit", "-q", "-m", "one"]);
    writeFileSync(join(repo, "packages/lib/src/i.ts"), "y");
    await sh(["add", "-A"]); await sh(["commit", "-q", "-m", "two"]);
    const head = await sh(["rev-parse", "HEAD"]);

    const answer = await attributeGateOnHost({ basePath: repo, baseSha: null, commits: [head], failing: [{ file: "tests/a.test.ts", workspacePackage: "@acme/web" }, { file: "tests/missing.test.ts", workspacePackage: null }], timeoutSec: 60 });

    expect(answer.commits[head]).toEqual({ paths: ["packages/lib/src/i.ts"], workspaces: ["packages/lib"] });
    expect(answer.failing[0]).toEqual({ workspaceDir: "apps/web", path: "apps/web/tests/a.test.ts", preexisting: null });
    expect(answer.failing[1]).toEqual({ workspaceDir: null, path: null, preexisting: null });
    expect(answer.baseline.status).toBe("skipped");
  });
});

describe("attributeFailures without the host's answer", () => {
  it("keeps every task a candidate, so the older file search decides", () => {
    const tasks = [task0("a"), task0("b")];
    expect(attributeFailures([{ file: "tests/x.test.ts", workspacePackage: null }], tasks, null)).toMatchObject({ strict: false, candidates: tasks, preexisting: [] });
  });
});

function task0(taskId: string): MergedTaskInfo {
  return { taskId, commitSha: "", threadId: null, attemptId: null, produced: [] };
}
