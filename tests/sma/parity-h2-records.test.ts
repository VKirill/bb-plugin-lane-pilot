import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets, sha256Hex } from "@lane-pilot/kit";
import { describe, expect, it } from "vitest";
import {
  createAttempt, createRun, createTask, getAttempt, getReasoningTrace, inspectAttempt, noteAttemptStream, onAttemptChanged,
  openDatabase, parkAttemptWake, saveReasoningTrace, transitionAttempt, TRANSITION_KEY,
} from "../../src/rooms/plugin-db";
import { attemptSessionLayers, permissionEntries, terminalParity, terminalSessionLayers } from "../../src/rooms/native-agent/terminal-parity";
import { buildBubblewrapArgs, buildSeatbeltProfile, credentialMaskPaths, protectedRootsManifest, runSandboxedCommandOnHost } from "../../src/rooms/verification/sandbox";
import { checkMeasureOf } from "../../src/rooms/tasks/server/conversation-tools";
import { claimLandingSuite, getAttemptChange, listLandingSuitePending, noteLandingSuite, upsertAttemptChange, type LandingSuite } from "../../src/rooms/rollback/store";
import { createRollback } from "../../src/rooms/rollback/server";

function db0() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, db: openDatabase(bb) };
}

const worldSeq = (db: ReturnType<typeof db0>["db"], id: string): number | null =>
  (db.prepare("SELECT world_seq FROM lane_pilot_attempt WHERE id=?").get(id) as { world_seq: number | null }).world_seq;

describe("[sma:m_wrappers] every attempt write is one transaction with the world counter", () => {
  it("the state, its journal row, the wake, the cancel code and the counter land together; listeners fire after the commit", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    createAttempt(db, { id: "a2", runId: "run_p", taskId: "t1" });
    const seen: Array<{ state: string; wakeAt: number | null; seq: number | null }> = [];
    onAttemptChanged(db, (attemptId, state) => {
      if (attemptId !== "a1") return;
      const row = db.prepare("SELECT wake_at, world_seq FROM lane_pilot_attempt WHERE id=?").get("a1") as { wake_at: number | null; world_seq: number | null };
      seen.push({ state: String(state), wakeAt: row.wake_at, seq: row.world_seq });
    });
    transitionAttempt(db, "a1", "spawn_requested", { reason: "work" });
    // The listener saw the commit, not a half-write.
    expect(worldSeq(db, "a1")).not.toBeNull();
    expect(seen.at(-1)).toMatchObject({ state: "spawn_requested", seq: worldSeq(db, "a1") });
    // A park is one atomic write: the queued state, its journal row and wake_at commit together.
    const wakeAt = Date.now() + 60_000;
    parkAttemptWake(db, "a2", "hold for the night", wakeAt);
    expect((db.prepare("SELECT wake_at FROM lane_pilot_attempt WHERE id='a2'").get() as { wake_at: number | null }).wake_at).toBe(wakeAt);
    const journal = db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition WHERE attempt_id='a2'").get() as { n: number };
    expect(journal.n).toBeGreaterThan(0);
    transitionAttempt(db, "a2", "spawn_requested", { reason: "work" });
    // The counter climbs globally: a2's later commit is a higher world change than a1's; leaving queued clears the wake.
    expect(worldSeq(db, "a2")).toBeGreaterThan(worldSeq(db, "a1")!);
    expect((db.prepare("SELECT wake_at FROM lane_pilot_attempt WHERE id='a2'").get() as { wake_at: number | null }).wake_at).toBeNull();
    // A cancel code lands in the transition's write, not a second one.
    transitionAttempt(db, "a1", "running", {});
    transitionAttempt(db, "a1", "cancel_requested", { cancelCode: "stuck" });
    expect((db.prepare("SELECT cancel_code FROM lane_pilot_attempt WHERE id='a1'").get() as { cancel_code: string | null }).cancel_code).toBe("stuck");
    expect(worldSeq(db, "a1")).toBeGreaterThan(worldSeq(db, "a2")!);
  });
});

describe("[sma:ar_stamp] the reasoning stamp names the automaton and the run policy", () => {
  it("a trace keeps transition key and policy sha next to the state-machine and harness versions", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    const base = { runId: "run_p", attemptId: "a1", threadId: null, planSha256: "p", sentPlanSha256: "p", sourceLength: 1, sentLength: 1,
      jevStatus: "ok" as const, jevDecision: null, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
      providerId: "claude-code", model: "m", serviceTier: null, requestedServiceTier: "default" as const };
    saveReasoningTrace(db, { ...base, stamp: { stateMachineVersion: 1, harnessVersion: "h", transitionKey: TRANSITION_KEY, policySha256: "0".repeat(64) } });
    const stamp = getReasoningTrace(db, "a1")!.stamp!;
    expect(stamp.transitionKey).toBe(TRANSITION_KEY);
    expect(stamp.policySha256).toBe("0".repeat(64));
    // The key names the automaton's rule set, not a guess: it is a stable digest stamped by spawn.
    expect(stamp.transitionKey).toMatch(/^[a-f0-9]{64}$/);
    const dossier = inspectAttempt(db, "proj_p", "a1")!.dossier as { reasoningTrace: { stamp: { transitionKey?: string; policySha256?: string } } };
    expect(dossier.reasoningTrace.stamp.transitionKey).toBe(TRANSITION_KEY);
    expect(dossier.reasoningTrace.stamp.policySha256).toBe("0".repeat(64));
    // A trace written before the stamp grew stays readable.
    saveReasoningTrace(db, { ...base, stamp: { stateMachineVersion: 1, harnessVersion: "h" } });
    expect(getReasoningTrace(db, "a1")!.stamp!.transitionKey).toBeUndefined();
  });
});

describe("[sma:ar_run_dir] the dossier carries the run stream and the verifier's input, bounded", () => {
  it("stream text is hashed and excerpted; verification commands are listed with a sha", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: { verification: [{ command: "npm test", expectExit: 0 }] } });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    saveReasoningTrace(db, { runId: "run_p", attemptId: "a1", threadId: null, planSha256: "p", sentPlanSha256: "p", sourceLength: 1, sentLength: 1,
      jevStatus: "ok" as const, jevDecision: null, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
      providerId: "claude-code", model: "m", serviceTier: null, requestedServiceTier: "default" as const });
    noteAttemptStream(db, "a1", "x".repeat(9000));
    const dossier = inspectAttempt(db, "proj_p", "a1")!.dossier as {
      stream: { sha256: string; chars: number; excerpt: string };
      verifierInput: { commands: string[]; sha256: string | null };
    };
    expect(dossier.stream.chars).toBe(9000);
    expect(dossier.stream.excerpt.length).toBeLessThanOrEqual(4000);
    expect(dossier.stream.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dossier.verifierInput.commands).toEqual(["npm test"]);
    expect(dossier.verifierInput.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("[sma:m_tl_terminal_parity] permissions are a compared layer, never a fake same", () => {
  it("the attempt's recorded permissions compare against the terminal's; a missing side is not compared", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    const entries = permissionEntries({ policy: null, disallowedTools: "Workflow,Bash(git push:*)" });
    saveReasoningTrace(db, { runId: "run_p", attemptId: "a1", threadId: null, planSha256: "p", sentPlanSha256: "p", sourceLength: 1, sentLength: 1,
      jevStatus: "ok" as const, jevDecision: null, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
      providerId: "claude-code", model: "m", serviceTier: null, requestedServiceTier: "default" as const,
      dispatchContext: { memoryText: "", executionPacket: "", executionPacketSha256: "", pmReadContext: "", agent: "w", helperMode: "inherit", helperRequired: false, permissions: entries } });
    const session = attemptSessionLayers(db, "a1")!;
    expect(session.permissions).toEqual(entries);
    const terminal = terminalSessionLayers({ db, projectId: "proj_p", skills: [], model: "claude-code/m" });
    expect(terminal.permissions).not.toBeNull();
    const line = terminalParity(session, terminal).find((row) => row.layer === "permissions")!;
    // The writer's disallow list names git push: the terminal's does not, so the layer diffs and says how.
    expect(line.same).toBe(false);
    expect(line.detail).toContain("Bash(git push:*)");
    // An attempt without a recorded permission list is not compared, never reported same.
    saveReasoningTrace(db, { ...getReasoningTrace(db, "a1")!, dispatchContext: { memoryText: "", executionPacket: "", executionPacketSha256: "", pmReadContext: "", agent: "w", helperMode: "inherit", helperRequired: false } });
    const missing = terminalParity(attemptSessionLayers(db, "a1")!, terminal).find((row) => row.layer === "permissions")!;
    expect(missing.same).toBeNull();
    expect(terminalParity(session, terminal)).toHaveLength(6);
  });
});

describe("[sma:m_ck_isolated] a sandboxed check proves .git, .agents and .cls untouched", () => {
  it("the manifest is deterministic and a change inside a protected root changes it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lp-h2-"));
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
    const before = await protectedRootsManifest(ws);
    expect(before.entries).toBe(1);
    expect(before).toMatchObject({ git: "covered", partial: false });
    expect((await protectedRootsManifest(ws)).sha256).toBe(before.sha256);
    writeFileSync(join(ws, ".git", "config"), "[core]");
    const after = await protectedRootsManifest(ws);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.entries).toBe(2);
  });

  it("skips .agents/runs, follows a linked worktree's .git file to its gitdir, and records git:uncovered when it cannot", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lp-h2wt-"));
    mkdirSync(join(ws, ".agents", "runs"), { recursive: true });
    writeFileSync(join(ws, ".agents", "keep.md"), "x");
    writeFileSync(join(ws, ".agents", "runs", "noise.json"), "1");
    const quiet = await protectedRootsManifest(ws);
    writeFileSync(join(ws, ".agents", "runs", "noise.json"), "22222");
    expect((await protectedRootsManifest(ws)).sha256).toBe(quiet.sha256);
    expect(quiet.entries).toBe(1);
    // A linked worktree: .git is a file naming the real directory.
    const gitdir = mkdtempSync(join(tmpdir(), "lp-h2gitdir-"));
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/x\n");
    writeFileSync(join(ws, ".git"), `gitdir: ${gitdir}\n`);
    const linked = await protectedRootsManifest(ws);
    expect(linked).toMatchObject({ git: "worktree-gitdir", entries: 2 });
    writeFileSync(join(gitdir, "index"), "i");
    expect((await protectedRootsManifest(ws)).sha256).not.toBe(linked.sha256);
    // A pointer to nowhere is not silently nothing.
    writeFileSync(join(ws, ".git"), "gitdir: /nonexistent/gitdir\n");
    expect(await protectedRootsManifest(ws)).toMatchObject({ git: "uncovered" });
  });

  it("past its wall-time budget a manifest is partial, and a partial manifest never counts as changed", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lp-h2slow-"));
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "HEAD"), "x");
    const partial = await protectedRootsManifest(ws, { budgetMs: -1 });
    expect(partial.partial).toBe(true);
    const capped = await protectedRootsManifest(ws, { cap: 0 });
    expect(capped).toMatchObject({ partial: true, truncated: true });
    const measure = checkMeasureOf({ command: "c", cwd: "/w", expectExit: 0, timeoutSec: 5, throwaway: true,
      result: { exitCode: 0, stdout: "", stderr: "", rootsManifest: { before: "a", after: "b", changed: false, partial: true } } });
    expect(measure).toMatchObject({ passed: true, rootsChanged: false, rootsPartial: true });
  });

  it("a real sandboxed run returns before/after manifests only when asked, and masks the credential stores", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lp-h2run-"));
    const plain = await runSandboxedCommandOnHost({ requestedHostId: "h", workspacePath: ws, cwd: ws, command: "echo ok", backend: "linux-bubblewrap" });
    expect(plain.exitCode).toBe(0);
    expect(plain.rootsManifest).toBeUndefined();
    const result = await runSandboxedCommandOnHost({ requestedHostId: "h", workspacePath: ws, cwd: ws, command: "echo ok", backend: "linux-bubblewrap", protectedRoots: true });
    expect(result.exitCode).toBe(0);
    expect(result.rootsManifest!.changed).toBe(false);
    expect(result.rootsManifest!.before).toMatch(/^[a-f0-9]{64}$/);
    const args = buildBubblewrapArgs({ workspacePath: ws, cwd: ws, tempPath: join(ws, "t"), guardPaths: [],
      credentialMask: { dirs: ["/home/u/.ssh"], files: ["/home/u/.netrc"] } });
    expect(args).toContain("--tmpfs");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/home/u/.ssh");
    const devnull = args.indexOf("/dev/null");
    expect(args[devnull - 1]).toBe("--ro-bind");
    expect(args[devnull + 1]).toBe("/home/u/.netrc");
    const profile = buildSeatbeltProfile(ws, join(ws, "t"), { dirs: ["/home/u/.ssh"], files: ["/home/u/.netrc"] });
    expect(profile).toContain('(deny file-read* (subpath "/home/u/.ssh"))');
    expect(profile).toContain('(deny file-read* (literal "/home/u/.netrc"))');
    expect(credentialMaskPaths("/nonexistent-home")).toEqual({ dirs: [], files: [] });
  });
});

describe("[sma:m_ck_required] a measure carries the five required facts", () => {
  it("command record plus sandbox backend, cleared env, closed publication and the roots manifest; a roots change fails it only in a throwaway copy", () => {
    const measure = checkMeasureOf({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60,
      result: { exitCode: 0, stdout: "ok", stderr: "", backend: "linux-bubblewrap", policySha256: "a".repeat(64),
        rootsManifest: { before: "b".repeat(64), after: "b".repeat(64), changed: false } } });
    expect(measure).toMatchObject({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60, exitCode: 0, passed: true,
      backend: "linux-bubblewrap", policySha256: "a".repeat(64), env: "cleared", publication: "closed", rootsSha256: "b".repeat(64), rootsChanged: false });
    const result = { exitCode: 0, stdout: "ok", stderr: "", backend: "linux-bubblewrap", rootsManifest: { before: "b".repeat(64), after: "c".repeat(64), changed: true } };
    const touched = checkMeasureOf({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: true, result });
    expect(touched.passed).toBe(false);
    expect(touched.evidence).toContain("protected roots");
    // The same change in a live checkout (the writer workspace, the PM checkout) is recorded, with a note, and never fails.
    for (const live of [{ throwaway: false }, {}]) {
      const recorded = checkMeasureOf({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60, ...live, result });
      expect(recorded).toMatchObject({ passed: true, rootsChanged: true });
      expect(recorded.evidence).toContain("recorded, not a failure");
    }
    // A command that failed on its own is still failed.
    expect(checkMeasureOf({ command: "c", cwd: "/w", expectExit: 0, timeoutSec: 5, result: { ...result, exitCode: 1 } }).passed).toBe(false);
  });
});

describe("[sma:k_lib_landing] a merged landing waits for its suite verdict on the change row", () => {
  it("merged rows without a verdict are pending; the verdict stores on the same row", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    upsertAttemptChange(db, { attemptId: "a1", runId: "run_p", taskId: "t1" }, { outcome: "merged", mergeCommit: "f".repeat(40), checksGreen: 2 });
    const pending = listLandingSuitePending(db, 0);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ attemptId: "a1", taskId: "t1", mergeCommit: "f".repeat(40) });
    noteLandingSuite(db, "a1", { suite: "red", head: "f".repeat(40), at: 123, red: ["npm test"] });
    const change = getAttemptChange(db, "a1")!;
    expect(change.suite).toMatchObject({ suite: "red", head: "f".repeat(40), at: 123, red: ["npm test"] });
    expect(listLandingSuitePending(db, 0)).toHaveLength(0);
  });
});

describe("[sma:m_wrappers] parkAttemptWake keeps «not passed» apart from an explicit null", () => {
  it("a park with a time sets wake_at, a park with null clears it again, and a plain queued move keeps it", () => {
    const { db } = db0();
    createRun(db, "run_w", "proj_w", "bb", "/w");
    createTask(db, { id: "tw", runId: "run_w", kind: "bb", contract: {} });
    createAttempt(db, { id: "aw", runId: "run_w", taskId: "tw" });
    const wake = () => (db.prepare("SELECT wake_at FROM lane_pilot_attempt WHERE id='aw'").get() as { wake_at: number | null }).wake_at;
    const at = Date.now() + 90_000;
    parkAttemptWake(db, "aw", "wait for the night", at);
    expect(wake()).toBe(at);
    // queued -> queued without a wakeAt field is not a clear: the wake stays.
    transitionAttempt(db, "aw", "queued", { reason: "note" });
    expect(wake()).toBe(at);
    // An explicit null clears the wake, as parkAttemptWake(…, null) did before the wake moved into the transaction.
    parkAttemptWake(db, "aw", "released", null);
    expect(wake()).toBeNull();
  });
});

describe("[sma:m_wrappers] a cancel code is recorded whether or not the cancel move was accepted", () => {
  it("an already-final attempt refuses the move but keeps the code; an accepted cancel writes it in the same transaction; the first code stays", () => {
    const { db } = db0();
    createRun(db, "run_c", "proj_c", "bb", "/w");
    createTask(db, { id: "tc", runId: "run_c", kind: "bb", contract: {} });
    createAttempt(db, { id: "ac1", runId: "run_c", taskId: "tc" });
    createAttempt(db, { id: "ac2", runId: "run_c", taskId: "tc" });
    const code = (id: string) => (db.prepare("SELECT cancel_code FROM lane_pilot_attempt WHERE id=?").get(id) as { cancel_code: string | null }).cancel_code;
    // Final first (accepted never leaves), then a cancel with a code: the move is refused, the code is still kept.
    transitionAttempt(db, "ac1", "spawn_requested", { reason: "work" });
    transitionAttempt(db, "ac1", "running", {});
    transitionAttempt(db, "ac1", "accepted", { reason: "done" });
    expect(transitionAttempt(db, "ac1", "canceled", { reason: "late cancel", cancelCode: "stuck" })).toBe(false);
    expect(getAttempt(db, "ac1")!.state).toBe("accepted");
    expect(code("ac1")).toBe("stuck");
    // The refused move is journaled as refused, in the same write.
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition WHERE attempt_id='ac1' AND refused=1").get() as { n: number }).n).toBe(1);
    // An accepted cancel writes state and code together; a later code does not overwrite the first.
    transitionAttempt(db, "ac2", "spawn_requested", { reason: "work" });
    transitionAttempt(db, "ac2", "running", {});
    transitionAttempt(db, "ac2", "cancel_requested", { reason: "stop" });
    expect(transitionAttempt(db, "ac2", "canceled", { reason: "stop", cancelCode: "owner" })).toBe(true);
    expect(code("ac2")).toBe("owner");
    transitionAttempt(db, "ac2", "canceled", { reason: "again", cancelCode: "stuck" });
    expect(code("ac2")).toBe("owner");
  });
});

describe("[sma:ar_run_dir] the stored stream excerpt is masked, the sha is over the whole text", () => {
  it("a planted token never reaches the dossier; the sha and length are those of the unmasked output", () => {
    const { db } = db0();
    createRun(db, "run_s", "proj_s", "bb", "/w");
    createTask(db, { id: "ts", runId: "run_s", kind: "bb", contract: {} });
    createAttempt(db, { id: "as1", runId: "run_s", taskId: "ts" });
    saveReasoningTrace(db, { runId: "run_s", attemptId: "as1", threadId: null, planSha256: "p", sentPlanSha256: "p", sourceLength: 1, sentLength: 1,
      jevStatus: "ok" as const, jevDecision: null, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
      providerId: "claude-code", model: "m", serviceTier: null, requestedServiceTier: "default" as const });
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const known = "zz-handed-out-secret-9917";
    registerSecrets([known]);
    try {
      const text = `done.\nAuthorization: Bearer ${token}\npassword: hunter2hunter2\nenv KEY=${known}\n` + "y".repeat(6000);
      noteAttemptStream(db, "as1", text);
      const stream = getReasoningTrace(db, "as1")!.stream!;
      expect(stream.excerpt).not.toContain(token);
      expect(stream.excerpt).not.toContain(known);
      expect(stream.excerpt).not.toContain("hunter2hunter2");
      expect(stream.excerpt.length).toBeLessThanOrEqual(4000);
      expect(stream.chars).toBe(text.length);
      expect(stream.sha256).toBe(sha256Hex(text));
      // The raw blob in the table carries no token either.
      expect(JSON.stringify(db.prepare("SELECT trace_json FROM lane_pilot_attempt_reasoning WHERE attempt_id='as1'").get())).not.toContain(token);
    } finally { forgetSecrets(); }
  });
});

/** The landing sweep with a stand-in host (worktrees are paths, nothing runs) and a scripted check runner; everything else is the real rollback code and a real database. */
function sweepWorld(verdict: (task: { verification: Array<{ command: string }> }) => Array<{ command: string; exitCode: number; stdout: string; stderr: string; hostError?: true }>) {
  const { bb, db } = db0();
  const calls: string[] = [];
  const options: unknown[] = [];
  const logs: string[] = [];
  const host = { call: async (method: string) => {
    calls.push(method);
    if (method === "gitCreateWorktree") return { hostId: "h", status: "ready", path: `/tmp/lp-suite-${calls.length}` };
    return { hostId: "h" };
  } };
  const ctx = { bb, db, host, log: (line: string) => logs.push(line), isDisposed: () => false,
    configForRun: async (projectId: string) => ({ projectId, hostId: "h", writerWorkspacePath: "/w" }) };
  const services = { runVerification: async (_config: unknown, task: { verification: Array<{ command: string }> }, _run?: string, _thread?: string, opts?: unknown) => { options.push(opts); return verdict(task); } };
  const { rollback } = createRollback(ctx as never, services as never);
  createRun(db, "run_l", "proj_l", "bb", "/w", "none", undefined, "h");
  let n = 0;
  /** A merged landing of its own task, recorded at `at`. */
  const land = (at: number, commands: string[] = ["npm test"]) => {
    const id = `l${++n}`;
    createTask(db, { id: `task_${id}`, runId: "run_l", kind: "bb", contract: {
      schema_version: 2, id: `task_${id}`, title: id, risk: "low", lane: "server", project_cwd: "/w", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: id, acceptance: ["done"], verify: "tests",
      verification: commands.map((command) => ({ command, cwd: "/w" })) } });
    createAttempt(db, { id: `att_${id}`, runId: "run_l", taskId: `task_${id}` });
    upsertAttemptChange(db, { attemptId: `att_${id}`, runId: "run_l", taskId: `task_${id}` }, { outcome: "merged", mergeCommit: id.padEnd(40, "0") }, at);
    return `att_${id}`;
  };
  const suiteOf = (attemptId: string): LandingSuite | null => getAttemptChange(db, attemptId)!.suite;
  const items = () => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item").get() as { n: number }).n;
  return { bb, db, rollback, calls, options, logs, land, suiteOf, items };
}
const GREEN = (task: { verification: Array<{ command: string }> }) => task.verification.map((c) => ({ command: c.command, exitCode: 0, stdout: "ok", stderr: "" }));

describe("[sma:k_lib_landing] the landing sweep takes no backlog, newest first, one pass per row", () => {
  it("a landing recorded before the sweep first ran is never taken; the watermark is stored once in plugin kv", async () => {
    const w = sweepWorld(GREEN);
    const old = w.land(Date.now() - 3_600_000);
    expect(await w.rollback.landingSuite()).toBe(0);
    const since = await w.bb.storage.kv.get("lp.landing-suite.since");
    expect(typeof since).toBe("number");
    const fresh = w.land(Date.now() + 5_000);
    expect(await w.rollback.landingSuite()).toBe(1);
    expect(w.suiteOf(old)).toBeNull();
    expect(w.suiteOf(fresh)).toMatchObject({ suite: "green" });
    expect(await w.bb.storage.kv.get("lp.landing-suite.since")).toBe(since);
    // The worktree it made was removed again, and the run was isolated (own pool, no duration history).
    expect(w.calls.filter((c) => c === "gitCreateWorktree")).toHaveLength(1);
    expect(w.calls.filter((c) => c === "gitRemoveWorktree")).toHaveLength(1);
    expect(w.options).toEqual([{ isolated: true }]);
  });

  it("takes the newest four first when more are waiting", async () => {
    const w = sweepWorld(GREEN);
    await w.rollback.landingSuite();
    const base = Date.now() + 5_000;
    const ids = [1, 2, 3, 4, 5].map((i) => w.land(base + i * 1000));
    expect(await w.rollback.landingSuite()).toBe(4);
    expect(w.suiteOf(ids[0]!)).toBeNull();
    for (const id of ids.slice(1)) expect(w.suiteOf(id)).toMatchObject({ suite: "green" });
    expect(await w.rollback.landingSuite()).toBe(1);
    expect(w.suiteOf(ids[0]!)).toMatchObject({ suite: "green" });
  });

  it("a host error is `error` and tried three times, then stays `error`; no owner item is ever posted", async () => {
    const w = sweepWorld((task) => task.verification.map((c) => ({ command: c.command, exitCode: 1, stdout: "", stderr: "host offline", hostError: true as const })));
    await w.rollback.landingSuite();
    const id = w.land(Date.now() + 5_000);
    for (let pass = 1; pass <= 3; pass++) {
      expect(await w.rollback.landingSuite()).toBe(1);
      expect(w.suiteOf(id)).toMatchObject({ suite: "error", tries: pass });
    }
    expect(await w.rollback.landingSuite()).toBe(0);
    expect(w.suiteOf(id)).toMatchObject({ suite: "error", tries: 3 });
    expect(w.options).toHaveLength(3);
    expect(w.items()).toBe(0);
  });

  it("a failed worktree is `error` too, and every worktree it did make is dropped", async () => {
    const w = sweepWorld(GREEN);
    await w.rollback.landingSuite();
    const id = w.land(Date.now() + 5_000);
    const failing = createRollback({ bb: w.bb, db: w.db, log: () => undefined, isDisposed: () => false,
      host: { call: async () => ({ hostId: "h", status: "failed", path: null, reason: "disk full" }) },
      configForRun: async (projectId: string) => ({ projectId, hostId: "h", writerWorkspacePath: "/w" }) } as never,
      { runVerification: async () => { throw new Error("must not run"); } } as never);
    expect(await failing.rollback.landingSuite()).toBe(1);
    expect(w.suiteOf(id)).toMatchObject({ suite: "error", tries: 1 });
    expect(w.items()).toBe(0);
  });

  it("a check that ran and exited non-zero is red and posts exactly one owner item, once", async () => {
    const w = sweepWorld((task) => task.verification.map((c) => ({ command: c.command, exitCode: 1, stdout: "", stderr: "1 failed" })));
    await w.rollback.landingSuite();
    const id = w.land(Date.now() + 5_000);
    await w.rollback.landingSuite();
    expect(w.suiteOf(id)).toMatchObject({ suite: "red", red: ["npm test"] });
    expect(w.items()).toBe(1);
    expect((w.db.prepare("SELECT key FROM lane_pilot_owner_item").get() as { key: string }).key).toBe(`landing-suite:${id}`);
    await w.rollback.landingSuite();
    expect(w.items()).toBe(1);
    expect(w.options).toHaveLength(1);
  });

  it("at most five owner items a day per project; the sixth red is stored and logged only", async () => {
    const w = sweepWorld((task) => task.verification.map((c) => ({ command: c.command, exitCode: 1, stdout: "", stderr: "bad" })));
    await w.rollback.landingSuite();
    const base = Date.now() + 5_000;
    const ids = [1, 2, 3, 4, 5, 6].map((i) => w.land(base + i * 1000));
    await w.rollback.landingSuite();
    await w.rollback.landingSuite();
    for (const id of ids) expect(w.suiteOf(id)).toMatchObject({ suite: "red" });
    expect(w.items()).toBe(5);
    expect(w.logs.some((line) => line.includes("not posted"))).toBe(true);
  });

  it("a claimed row is skipped by a second pass; a claim older than 45 minutes is taken again", async () => {
    const w = sweepWorld(GREEN);
    await w.rollback.landingSuite();
    const id = w.land(Date.now() + 5_000);
    const [row] = listLandingSuitePending(w.db, 0);
    expect(claimLandingSuite(w.db, row!, Date.now(), row!.mergeCommit)).toBe(true);
    // A second claim on what the first pass read loses, and a sweep leaves the running row alone.
    expect(claimLandingSuite(w.db, row!, Date.now(), row!.mergeCommit)).toBe(false);
    expect(await w.rollback.landingSuite()).toBe(0);
    expect(w.suiteOf(id)).toMatchObject({ suite: "running" });
    expect(w.options).toHaveLength(0);
    w.db.prepare("UPDATE lane_pilot_attempt_change SET suite_json=? WHERE attempt_id=?").run(JSON.stringify({ suite: "running", head: null, at: Date.now() - 46 * 60_000, tries: 0 }), id);
    expect(await w.rollback.landingSuite()).toBe(1);
    expect(w.suiteOf(id)).toMatchObject({ suite: "green" });
  });
});
