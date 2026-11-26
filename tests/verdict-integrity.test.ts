import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeCritiquePrompt, buildCandidateEvidence } from "../src/rooms/critique";
import { runCodeCritique } from "../src/rooms/critique/server";
import { createDeferrals } from "../src/rooms/deferral/server";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting } from "../src/rooms/plugin-db";
import { mapScriptOutputToDeclaredFields } from "../src/rooms/specialist/server";
import { buildRunPolicy, contractCheckFiles } from "../src/rooms/tasks";
import { validateDeliverable } from "../src/rooms/validators";
import {
  buildPreliminaryReceipt,
  contractHashOf,
  detectFalseDone,
  finalizeVerdictReceipt,
} from "../src/rooms/verification";
import {
  prepareWorktree,
  integrateWorktree,
} from "../src/rooms/worktree";
import {
  beginVerdictReceipt,
  finishVerdictReceipt,
  hostGit,
  proofCurrency,
  verifyAcceptanceReceiptIntegrity,
} from "../src/rooms/verification/server";
import { createWriterVerify } from "../src/rooms/writer/server/services/verify";
import { stageHelperSettings } from "../src/rooms/settings/server/services/stage-settings";
import { world as baselineWorld } from "./baseline/world";

const tempDirs: string[] = [];

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-verdict-integrity-"));
  tempDirs.push(dir);
  const run = (args: string[]) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout.trim();
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Tester"]);
  run(["config", "user.email", "tester@example.com"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), "export const v = 1;\n");
  writeFileSync(join(dir, "docs/readme.md"), "hello\n");
  writeFileSync(join(dir, "scripts/check.sh"), "#!/bin/sh\nexit 0\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "initial"]);
  return dir;
}

function localGit(cwd: string) {
  return hostGit(async (command) => {
    const res = spawnSync("sh", ["-lc", command], { cwd, encoding: "utf8" });
    return { exitCode: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  });
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Task 28 verdict integrity", () => {
  it("refuses acceptance when git tree or contract hash changes after the receipt was written", async () => {
    const repo = makeTempGitRepo();
    const logs: string[] = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const host = {
      call: async (method: string, input: { command?: string; cwd?: string }) => {
        if (method === "runCommand" || method === "runSandboxedCommand") {
          const res = spawnSync("sh", ["-lc", input.command!], { cwd: input.cwd ?? repo, encoding: "utf8" });
          return { hostId: "h1", exitCode: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", backend: null, policySha256: null, workspacePath: repo };
        }
        throw new Error(`unexpected host call ${method}`);
      },
    } as never;
    const ctx = { bb, host, log: (line: string) => logs.push(line) };
    const task = {
      schema_version: 2,
      id: "t-hash",
      title: "Hash check",
      kind: "feature",
      risk: "low",
      lane: "writer",
      project_cwd: repo,
      owns_paths: ["src/app.ts"],
      never_touch: [],
      expected_outputs: ["src/app.ts"],
      depends_on: [],
      objective: "Update app",
      acceptance: ["v is 2"],
      verify: "tests",
      verification: [{ command: "sh scripts/check.sh", cwd: repo }],
    };

    const { preliminary } = await beginVerdictReceipt(ctx, {
      hostId: "h1", projectCwd: repo, basePath: repo, runId: "r1", taskId: task.id, attemptId: "att1", task,
    });
    expect(preliminary.verdict).toBe("not_run");
    expect(preliminary.criteria).toEqual([{ command: "sh scripts/check.sh", exitCode: null }]);
    expect(preliminary.contractHash).toBe(contractHashOf(task));

    const finalized = await finishVerdictReceipt(ctx, {
      preliminary, hostId: "h1", projectCwd: repo, basePath: repo, runId: "r1", taskId: task.id, attemptId: "att1",
      verifies: [{ command: "sh scripts/check.sh", exitCode: 0 }],
    });
    expect(finalized.verdict).toBe("pass");
    expect(logs.some((l) => l.includes("INFO receipt written") && l.includes("verdict=not_run"))).toBe(true);
    expect(logs.some((l) => l.includes("INFO receipt written") && l.includes("verdict=pass"))).toBe(true);

    // Untampered tree passes acceptance check
    const cleanCheck = await verifyAcceptanceReceiptIntegrity(ctx, {
      hostId: "h1", projectCwd: repo, basePath: repo, runId: "r1", taskId: task.id, attemptId: "att1", task, produced: ["src/app.ts"],
    });
    expect(cleanCheck.ok).toBe(true);

    // Mutate the working tree after the receipt -> acceptance must refuse
    writeFileSync(join(repo, "src/app.ts"), "export const v = 999;\n");
    const dirtyCheck = await verifyAcceptanceReceiptIntegrity(ctx, {
      hostId: "h1", projectCwd: repo, basePath: repo, runId: "r1", taskId: task.id, attemptId: "att1", task, produced: ["src/app.ts"],
    });
    expect(dirtyCheck).toMatchObject({ ok: false, kind: "hash_mismatch" });
    expect(logs.some((l) => l.includes("WARN hash mismatch at acceptance (receipt refused)"))).toBe(true);
  });

  it("evaluates proofCurrency() across covered/uncovered changes, non-ancestor commits, and unreadable repos", async () => {
    const repo = makeTempGitRepo();
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
    const logs: string[] = [];
    const c1 = git(["rev-parse", "HEAD"]);

    // Uncovered path edited and committed -> current
    writeFileSync(join(repo, "docs/readme.md"), "updated docs\n");
    git(["add", "docs/readme.md"]);
    git(["commit", "-qm", "docs update"]);
    const currentRes = await proofCurrency({ commit: c1, paths: ["src/app.ts"], git: localGit(repo), receiptId: "rcpt-1", log: (l) => logs.push(l) });
    expect(currentRes).toMatchObject({ verdict: "current", changedPaths: [] });

    // Covered path edited -> stale naming that path
    writeFileSync(join(repo, "src/app.ts"), "export const v = 2;\n");
    git(["add", "src/app.ts"]);
    git(["commit", "-qm", "src update"]);
    const staleRes = await proofCurrency({ commit: c1, paths: ["src/app.ts"], git: localGit(repo), receiptId: "rcpt-1", log: (l) => logs.push(l) });
    expect(staleRes).toMatchObject({ verdict: "stale", changedPaths: ["src/app.ts"] });

    // Commit on another branch not an ancestor of HEAD -> not_on_history
    git(["checkout", "-qb", "side", c1]);
    writeFileSync(join(repo, "src/other.ts"), "export const x = 1;\n");
    git(["add", "src/other.ts"]);
    git(["commit", "-qm", "side commit"]);
    const sideSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "main"]);
    const notOnHistory = await proofCurrency({ commit: sideSha, paths: ["src/app.ts"], git: localGit(repo), receiptId: "rcpt-1", log: (l) => logs.push(l) });
    expect(notOnHistory.verdict).toBe("not_on_history");

    // Unreadable repo -> unknown
    const brokenGit = async () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    const unknownRes = await proofCurrency({ commit: c1, paths: ["src/app.ts"], git: brokenGit, receiptId: "rcpt-1", log: (l) => logs.push(l) });
    expect(unknownRes.verdict).toBe("unknown");
    expect(logs.some((l) => l.includes("INFO proof.currency receipt=rcpt-1 verdict=current paths=0"))).toBe(true);
    expect(logs.some((l) => l.includes("INFO proof.currency receipt=rcpt-1 verdict=stale paths=1"))).toBe(true);
  });

  it("holds unfailable checks on feature admission, enforces passing checks on refactor, and keeps check files read-only", async () => {
    const w = await baselineWorld();
    const featureAllGreen = w.pendingTask("feat-vacuous", ["test -f keep.txt"]);
    (featureAllGreen.task as unknown as { kind: string }).kind = "feature";
    const blockedFeature = await w.services.baseline.preflight(featureAllGreen);
    expect(blockedFeature.stop).toMatch(/verdict_block: no_red_on_base/);
    expect(w.logs.some((l) => l.includes("WARN check that cannot fail (task held with reason)"))).toBe(true);

    const trivialFeature = w.pendingTask("feat-trivial", ["true"]);
    (trivialFeature.task as unknown as { kind: string }).kind = "feature";
    const blockedTrivial = await w.services.baseline.preflight(trivialFeature);
    expect(blockedTrivial.stop).toMatch(/verdict_block: no_red_on_base/);

    // Refactor with a failing check on base is also not admitted
    const redRefactor = w.pendingTask("ref-red", ["test -f missing-file.txt"]);
    (redRefactor.task as unknown as { kind: string }).kind = "refactor";
    const blockedRefactor = await w.services.baseline.preflight(redRefactor);
    expect(blockedRefactor.stop).toMatch(/verdict_block: refactor_red_on_base/);

    // Check files in the contract stay read-only in the worktree even when owns_paths covers the repo
    const checkFiles = contractCheckFiles(["sh scripts/check.sh", "npx vitest run tests/app.test.ts"]);
    expect(checkFiles).toEqual(expect.arrayContaining(["scripts/check.sh", "tests/app.test.ts"]));
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests/app.test.ts"), "import { test } from 'vitest';\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "add test"], { cwd: repo });
    const wt = mkdtempSync(join(tmpdir(), "lp-ro-wt-"));
    tempDirs.push(wt);
    spawnSync("git", ["worktree", "add", "-q", "-b", "feat/ro-check", wt, "HEAD"], { cwd: repo });
    try {
      await prepareWorktree({ basePath: repo, worktreePath: wt, ownsBarrier: true, ownsPaths: ["**"], neverTouch: [], readOnlyPaths: checkFiles });
      expect(statSync(join(wt, "scripts/check.sh")).mode & 0o222).toBe(0);
      expect(statSync(join(wt, "tests/app.test.ts")).mode & 0o222).toBe(0);
      expect(statSync(join(wt, "src/app.ts")).mode & 0o200).toBe(0o200);
    } finally {
      chmodSync(join(wt, "scripts/check.sh"), 0o644);
      chmodSync(join(wt, "tests/app.test.ts"), 0o644);
    }
    await w.dispose();
  });

  it("detects non-LLM false-done claims when a claimed test did not run or a claimed file was untouched", () => {
    const prelim = buildPreliminaryReceipt({
      task: { id: "t1" },
      treeHash: "a".repeat(64),
      targetCommit: "b".repeat(40),
      commands: ["npx vitest run tests/a.test.ts"],
    });
    const fakePass = detectFalseDone({
      writerOutput: "Updated `src/a.ts` and ran `npx vitest run tests/a.test.ts` — all tests passed.",
      diffPaths: ["src/a.ts"],
      receipt: prelim,
    });
    expect(fakePass.verdict).toBe("fail");
    expect(fakePass.findings.some((f) => f.kind === "claimed_test_not_run")).toBe(true);

    const finalized = finalizeVerdictReceipt(prelim, [{ command: "npx vitest run tests/a.test.ts", exitCode: 0 }]);
    const untouchedFile = detectFalseDone({
      writerOutput: "Modified `src/missing.ts` and ran `npx vitest run tests/a.test.ts` — passed.",
      diffPaths: ["src/a.ts"],
      receipt: finalized,
    });
    expect(untouchedFile.verdict).toBe("fail");
    expect(untouchedFile.findings.some((f) => f.kind === "claimed_file_untouched" && f.claim === "src/missing.ts")).toBe(true);
  });

  it("keeps critic prompts free of writer report and dispute text, and refuses not_run as pass", async () => {
    const writerStory = "I fixed everything carefully, please accept.";
    const evidence = buildCandidateEvidence({
      produced: ["src/a.ts"],
      hashes: { "src/a.ts": "a".repeat(64) },
      verification: [{ command: "npm test", exitCode: 0, stdout: "1 passed", stderr: "" }],
      files: [{ path: "src/a.ts", content: "export const ok = true;" }],
      output: writerStory,
      ownsPaths: ["src/**"],
      neverTouch: [],
      dirtOk: true,
    });
    const prompt = codeCritiquePrompt({
      evidence,
      task: { id: "t1", title: "Task", acceptance: ["ok works"], owns_paths: ["src/**"], verification: [{ command: "npm test", cwd: "/repo" }] },
    });
    expect(prompt).not.toContain(writerStory);
    expect(prompt).not.toContain("WRITER DISPUTES");
    expect(prompt).toContain("read-only profile");

    // Truncated packet is not allowed as pass
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }],
          models: async () => ({ models: [{ id: "test-model", model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }),
        },
      },
    });
    const db = openDatabase(bb);
    createRun(db, "r", "P", "cli", "/tmp");
    const task = { id: "t1", title: "T", risk: "medium", owns_paths: ["src/**"], verification: [], acceptance: ["x"], project_cwd: "/tmp" };
    createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
    saveProjectSetting(db, "P", "code_critique.enabled", true);
    const blocked = await runCodeCritique({
      stageHelperSettings,
      bb,
      db,
      projectId: "P",
      runId: "r",
      taskId: "t1",
      config: { projectId: "P", hostId: "h", pmWorkspacePath: "/tmp", writerWorkspacePath: "/tmp", pmProviderId: "codex", pmModel: "test-model", writerProviderId: "codex", writerModel: "test-model" } as never,
      task: task as never,
      evidence: { ...evidence, truncated: true, truncateReason: "packet_truncated" },
    });
    expect(blocked.allowed).toBe(false);

    // Deliverable & sp-script-aliases never return pass on not_run/unavailable
    const noDom = await validateDeliverable("page", "http://127.0.0.1:9", {
      host: {
        run: async (_h, _c, cmd) =>
          cmd.includes("curl") ? { exitCode: 0, stdout: "200", stderr: "" } : { exitCode: 3, stdout: "", stderr: "" },
      },
      hostId: "h1",
      brief: { design: true, objective: "hero" },
      review: async () => null,
    });
    expect(noDom.ok).toBe(false);

    const aliasOut = mapScriptOutputToDeclaredFields(
      "pulse_rules.py",
      {},
      [{ name: "status", type: "enum", values: ["pass", "block", "not_run"] }, { name: "pulse_verdict", type: "string" }] as never,
      "report.json",
    );
    expect(aliasOut.status).toBe("not_run");
    expect(aliasOut.pulse_verdict).toBe("not_run");
  });

  it("refuses agent calls that set a deferral date and fails baseline when an overdue deferral exists", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const deferrals = createDeferrals({
      db,
      port: { getThread: async () => null, listEvents: async () => [] },
    });
    await expect(
      deferrals.defer({ what: "skip integration check", kind: "gate", reason: "waiting for CI", due: "2026-12-31" }),
    ).rejects.toThrow(/agent does not set a term/);

    // Overdue deferral fails baseline by itself
    const w = await baselineWorld();
    const past = Date.now() - 86_400_000;
    const ownerRef = JSON.stringify({ threadId: "thr_owner", seq: 1, index: 0, sha256: "a".repeat(64), at: past });
    w.db.prepare(
      "INSERT INTO lane_pilot_deferral(id,project_id,what,kind,area,due_at,due_source,owner_ref,owner_quote,state,history_json,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("dfr_late1", "projA", "expired gate check", "gate", "", past, "explicit", ownerRef, "owner: yesterday", "open", "[]", "cli", past, past);
    const held = await w.services.baseline.preflight(w.pendingTask("t-overdue", ["test -f missing.txt"]));
    expect(held.stop).toMatch(/overdue_deferral/);
    await w.dispose();
  });

  it("runs merge with CAS ref update and passes protectedRoots in default writer terminal verification", async () => {
    const repo = makeTempGitRepo();
    const wtBase = mkdtempSync(join(tmpdir(), "lp-cas-wt-"));
    tempDirs.push(wtBase);
    spawnSync("git", ["worktree", "add", "-q", "-b", "feat/cas", wtBase, "HEAD"], { cwd: repo });
    writeFileSync(join(wtBase, "src/app.ts"), "export const v = 3;\n");
    const integrated = await integrateWorktree({ basePath: repo, worktreePath: wtBase, message: "cas merge test", removeWorktree: false });
    expect(integrated.status).toBe("merged");
    expect(integrated.commit).toMatch(/^[0-9a-f]{40}$/);

    // Writer terminal check passes protectedRoots: true by default
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        terminals: {
          create: async () => ({ id: "term-1", status: "exited", exitCode: 0 }),
          get: async () => ({ id: "term-1", status: "exited", exitCode: 0 }),
          output: async () => ({ chunks: [{ dataBase64: Buffer.from("1 passed\n").toString("base64") }] }),
          close: async () => ({}),
        },
        projects: {
          machineEnvironment: async () => ({ variables: [] }),
        },
      },
    });
    const db = openDatabase(bb);
    createRun(db, "r-term", "P", "cli", repo);
    const verifyApi = createWriterVerify(
      {
        bb,
        db,
        log: () => {},
        runPolicyFor: () => buildRunPolicy({}),
        host: {
          call: async (method: string, input: Record<string, unknown>) => {
            calls.push({ method, input });
            if (method === "sandboxCommandLine") {
              return { hostId: "h1", backend: "macos-seatbelt", workspacePath: repo, cwd: repo, policySha256: "p", commandLine: "echo hi", cleanup: { tempPath: "/tmp/lane-pilot-sandbox-x", created: [] }, rootsBefore: { sha256: "abc", entries: 1, partial: false, git: "covered" } };
            }
            if (method === "sandboxRelease") {
              return { hostId: "h1", released: true, rootsManifest: { before: "abc", after: "abc", changed: false, partial: false, git: "covered" } };
            }
            return { hostId: "h1", exitCode: 0, stdout: "", stderr: "" };
          },
        },
      } as never,
      {
        runWriterPool: { acquire: async () => () => {} },
        workspaceDirt: async () => ({ ok: true, snapshots: [] }),
      } as never,
    );
    const res = await verifyApi.runVerification(
      { projectId: "P", hostId: "h1", writerWorkspacePath: repo } as never,
      { id: "t-term", project_cwd: repo, verification: [{ command: "npx vitest run a.test.ts", cwd: repo }] } as never,
      "r-term",
      "thr-w",
    );
    expect(res).toHaveLength(1);
    const prepCall = calls.find((c) => c.method === "sandboxCommandLine");
    expect(prepCall?.input.protectedRoots).toBe(true);
    const relCall = calls.find((c) => c.method === "sandboxRelease");
    expect(relCall?.input.rootsBefore).toBeDefined();
    expect(res[0]).toMatchObject({ rootsChanged: false });
    void createAttempt;
    void createTask;
    void vi;
  });
});
