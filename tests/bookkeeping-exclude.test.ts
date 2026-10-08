import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { BOOKKEEPING_EXCLUDE_LINES, isBookkeepingPath } from "@lane-pilot/settings-catalog";
import { TARGET_SHA } from "../src/constants";
import { openDatabase, saveProjectSetting, savePrototypeConfig } from "../src/database";
import { excludeBookkeeping } from "../src/rooms/verification/server/bookkeeping-exclude";
import { ensureExcludeLinesCommand } from "../src/rooms/verification/git-integrate";

const sh = (cwd:string, command:string) => execFileSync("sh", ["-c", command], { cwd, encoding: "utf8" });
const git = (cwd:string, ...args:string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const repo = () => { const dir = mkdtempSync(join(tmpdir(), "lp-bk-exclude-")); git(dir, "init", "-q"); return dir; };
const runner = (hostId = "h1") => async (input:{ requestedHostId:string; cwd:string; command:string }) => {
  expect(input.requestedHostId).toBe(hostId);
  try { return { exitCode: 0, stdout: sh(input.cwd, input.command), stderr: "" }; }
  catch (cause) { return { exitCode: 1, stdout: "", stderr: String(cause) }; }
};
const excludeFile = (dir:string) => join(dir, ".git", "info", "exclude");

describe("bookkeeping exclude lines", () => {
  it("name only bookkeeping folders of the module's list", () => {
    expect(BOOKKEEPING_EXCLUDE_LINES).toEqual(["**/.agents/runs/", "**/.agents/reports/", "**/.bb/chats/", "**/notes/lock/"]);
    for (const line of BOOKKEEPING_EXCLUDE_LINES) expect(isBookkeepingPath(`${line.replace("**/", "")}x/y.md`)).toBe(true);
  });

  it("are added once to the repository's info/exclude, never to .gitignore, and git then ignores the folders", async () => {
    const dir = repo();
    const log:string[] = [];
    expect(await excludeBookkeeping(runner(), "h1", dir, (m) => log.push(m))).toEqual(BOOKKEEPING_EXCLUDE_LINES);
    expect(readFileSync(excludeFile(dir), "utf8")).toContain(BOOKKEEPING_EXCLUDE_LINES.join("\n"));
    expect(log[0]).toContain("**/.agents/runs/");
    mkdirSync(join(dir, ".agents", "runs", "lprun_1"), { recursive: true });
    writeFileSync(join(dir, ".agents", "runs", "lprun_1", "a.json"), "{}");
    mkdirSync(join(dir, ".bb", "chats", "thr"), { recursive: true });
    writeFileSync(join(dir, ".bb", "chats", "thr", "n.md"), "x");
    writeFileSync(join(dir, "real.ts"), "x");
    expect(git(dir, "status", "--porcelain").trim()).toBe("?? real.ts");
    expect(() => readFileSync(join(dir, ".gitignore"))).toThrow();
    // Second activation: nothing is missing, nothing is added, the file is unchanged.
    const before = readFileSync(excludeFile(dir), "utf8");
    expect(await excludeBookkeeping(runner(), "h1", dir, () => {})).toEqual([]);
    expect(readFileSync(excludeFile(dir), "utf8")).toBe(before);
  });

  it("adds only the missing lines and keeps the owner's own, also after a last line without a newline", async () => {
    const dir = repo();
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(excludeFile(dir), `*.log\n${BOOKKEEPING_EXCLUDE_LINES[1]}\nmine`);
    expect(await excludeBookkeeping(runner(), "h1", dir, () => {})).toEqual([0, 2, 3].map((i) => BOOKKEEPING_EXCLUDE_LINES[i]));
    expect(readFileSync(excludeFile(dir), "utf8").split("\n")).toEqual(["*.log", BOOKKEEPING_EXCLUDE_LINES[1], "mine", BOOKKEEPING_EXCLUDE_LINES[0], BOOKKEEPING_EXCLUDE_LINES[2], BOOKKEEPING_EXCLUDE_LINES[3], ""]);
  });

  it("reaches the repository's exclude from a subfolder workspace and from a linked worktree", async () => {
    const dir = repo();
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(await excludeBookkeeping(runner(), "h1", sub, () => {})).toEqual(BOOKKEEPING_EXCLUDE_LINES);
    mkdirSync(join(sub, ".agents", "runs"), { recursive: true });
    writeFileSync(join(sub, ".agents", "runs", "x"), "x");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
    const wt = join(mkdtempSync(join(tmpdir(), "lp-bk-wt-")), "wt");
    git(dir, "worktree", "add", "-q", wt);
    expect(await excludeBookkeeping(runner(), "h1", wt, () => {})).toEqual([]);
    expect(readFileSync(excludeFile(dir), "utf8").split("\n").filter((line) => line === BOOKKEEPING_EXCLUDE_LINES[0])).toHaveLength(1);
  });

  it("does nothing outside a git repository, and never throws when the machine fails", async () => {
    const plain = mkdtempSync(join(tmpdir(), "lp-bk-plain-"));
    expect(sh(plain, ensureExcludeLinesCommand(BOOKKEEPING_EXCLUDE_LINES))).toContain("lp:not-git");
    expect(await excludeBookkeeping(runner(), "h1", plain, () => {})).toEqual([]);
    const log:string[] = [];
    const failing = async () => { throw new Error("host went away"); };
    expect(await excludeBookkeeping(failing, "h1", plain, (m) => log.push(m))).toEqual([]);
    expect(log[0]).toContain("host went away");
  });
});

describe("activation reports the excluded paths", () => {
  const projectId = "proj_bk_exclude";
  const config = { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer",
    pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" };

  async function activate(runCommand:(input:{ requestedHostId:string; cwd:string; command:string }) => unknown) {
    const calls:Array<{ requestedHostId:string; cwd:string; command:string }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { getPluginMetadata: async () => ({ role: "user" }), get: async () => ({ status: "idle" }) as never, listRunning: async () => [],
        stop: async () => undefined, spawn: async () => ({ id: "pm-bk" }) as never } },
      experimental_callHostRpc: ((call:{ method:string; input:never }) => {
        if (call.method === "detect") return { hostId: "host-test", laneStack: { present: true, version: "1.39.0", sourceSha: "x" }, openCode: { present: false, version: null }, workspace: { path: "/tmp/pm", present: true }, targetSha: TARGET_SHA, matchesTarget: false, scenario: "S2" };
        if (call.method === "coexistenceInventory") return { schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA, managers: [{ manager: "agents-marker", path: "/p", installed: true, configured: true, loaded: null, compatible: true, modified: null, version: "c", sourceSha: "x", sha256: "a".repeat(64), owner: "user", decision: "reuse", capabilities: [], missingCapabilities: [], evidence: [] }] };
        if (call.method === "importConfig") return { schemaVersion: 1, action: "import-config", scenario: "S7", status: "ok", filesChanged: [], externalOpsBefore: {}, externalOpsAfter: {}, skippedExternalOps: [], warning: null, exitCode: 0, receiptPath: null, snapshotPath: null, sourceSha: null, notes: [], imported: { routingProfile: null, nightShift: null } };
        if (call.method === "runCommand") { calls.push(call.input); return runCommand(call.input); }
        throw new Error(`unexpected ${call.method}`);
      }) as never,
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "adoc.040", "in_place");
    await plugin(bb);
    const result = await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: "source-thread" }) as Record<string, unknown>;
    await harness.lifecycle.dispose();
    return { result, calls };
  }

  it("returns the lines the machine added, asking the project's checkout", async () => {
    const stdout = BOOKKEEPING_EXCLUDE_LINES.map((line) => `lp:added ${line}`).join("\n") + "\n";
    const { result, calls } = await activate(() => ({ hostId: "host-test", exitCode: 0, stdout, stderr: "" }));
    expect(result).toMatchObject({ threadId: "pm-bk", bookkeepingExcluded: BOOKKEEPING_EXCLUDE_LINES });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ requestedHostId: "host-test", cwd: "/tmp/writer" });
    expect(calls[0]!.command).toContain("info/exclude");
    expect(calls[0]!.command).not.toContain(".gitignore");
  });

  it("says nothing when every line is already there, and activates anyway when the machine call fails", async () => {
    const quiet = await activate(() => ({ hostId: "host-test", exitCode: 0, stdout: "", stderr: "" }));
    expect(quiet.result).toEqual({ threadId: "pm-bk", runId: expect.any(String) });
    const failed = await activate(() => { throw new Error("host went away"); });
    expect(failed.result).toEqual({ threadId: "pm-bk", runId: expect.any(String) });
  });
});
