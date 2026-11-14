// Region 1 · Task graph, batch d: the verification barrier, the attempt automaton and the work acceptance. Shared by the four-proofs-r01-d tests
// and by the scene probe (scripts/lp_drill/scenes/sma_r01_d_probe.ts): each `observe*` runs the real code of the checkout and returns what it
// produced; the test asserts it against the card, the probe prints it and the scene compares it again. No model, no hub write.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { acceptanceProofGap } from "../../packages/contracts/src/stage-proof";
import { taskV2Schema, type TaskV2 } from "../../src/rooms/contracts";
import { failureFingerprint, repeatedFailureReason } from "../../src/rooms/contracts/failure-class";
import { MAIN_ATTEMPT_LIMIT, isLegalMove, nextAttemptState, retryAction } from "../../src/rooms/contracts/state-machine";
import { criticAcrossFamilies, type CriticCatalog } from "../../src/rooms/critique/critic-pair";
import { codeCritiqueResultSchema } from "../../src/rooms/critique/code-critique";
import { landingWordGap } from "../../src/rooms/tasks/words";
import { claudeGuardLauncherScript, HELPER_DISALLOWED_TOOLS, WRITER_DISALLOWED_TOOLS } from "../../src/rooms/native-agent/claude-guard-launch";
import { barrierInputBody } from "../../src/rooms/writer/server/barrier-input";
import { recordGateEvaluation, recordStage } from "../../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { createWorktree, integrateWorktree } from "../../src/rooms/verification/git-integrate";
import { runSandboxedCommandOnHost } from "../../src/rooms/verification/sandbox";
import { sha256Hex } from "@lane-pilot/kit";
import { WORKSPACE_DIRT_SCRIPT } from "../../src/rooms/verification/workspace-dirt";
import { git as gitIn, taskOf as taskC } from "./r01-world-c";

export const taskOf = taskC;

/** n256: the contract a verdict is read against is the confirmed edition; what a worker adds to it, or what it leaves out, is refused. */
export function observeContract() {
  const good = taskOf("d-contract");
  const parses = (value: unknown) => taskV2Schema.safeParse(value).success;
  return {
    confirmed: parses(good),
    workerKey: parses({ ...good, worker_says: "all done" }),
    noAcceptance: parses({ ...good, acceptance: [] }),
    noOutputs: parses({ ...good, expected_outputs: [] }),
    badVerify: parses({ ...good, verify: "trust-me" }),
    relativeCwd: parses({ ...good, project_cwd: "ws" }),
  };
}

const CATALOG_MODELS: Record<string, Record<string, string[]>> = {
  "claude-code": { "claude-opus-5-5": ["medium"] },
  codex: { "gpt-6.1-sol": ["medium"] },
};
function catalogOf(offered: readonly string[]): CriticCatalog {
  const spec = Object.fromEntries(Object.entries(CATALOG_MODELS).filter(([id]) => offered.includes(id)));
  return {
    provider: async (providerId) => (spec[providerId] ? { id: providerId, available: true, supportsServiceTier: false, serviceTiers: [] } : null),
    models: async (providerId) => Object.entries(spec[providerId] ?? {}).map(([model, efforts]) => ({ id: model, model, efforts })),
  };
}

/** n257: the code critic of the writer's own family moves to the other family when the host has it; with none on offer the same pair is kept. */
export async function observeCriticRoute() {
  const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
  const sol = { providerId: "codex", model: "gpt-6.1-sol" };
  const input = { effort: "medium", tier: "standard" as const };
  return {
    opus,
    sol,
    moved: await criticAcrossFamilies({ ...input, catalog: catalogOf(["claude-code", "codex"]), critic: opus, writer: opus }),
    onlyOwn: await criticAcrossFamilies({ ...input, catalog: catalogOf(["claude-code"]), critic: opus, writer: opus }),
    otherWriter: await criticAcrossFamilies({ ...input, catalog: catalogOf(["claude-code", "codex"]), critic: opus, writer: sol }),
    noWriter: await criticAcrossFamilies({ ...input, catalog: catalogOf(["claude-code", "codex"]), critic: opus, writer: null }),
  };
}

/** n259 and n272: the same failure on another id is the same failure; a different fault, a question and a budget stop are not. */
export function observeRepeat() {
  const same = { state: "validation_failed", reason: "verification failed (npm test): boom in thr_aaa" };
  const again = { state: "validation_failed", reason: "verification failed (npm test): boom in thr_bbb at /tmp/x/12" };
  const other = { state: "validation_failed", reason: "verification failed (npm test): other fault" };
  return {
    fpA: failureFingerprint(same.reason),
    fpB: failureFingerprint(again.reason),
    fpOther: failureFingerprint(other.reason),
    repeated: repeatedFailureReason(same, again),
    different: repeatedFailureReason(same, other),
    first: repeatedFailureReason(null, same),
    question: repeatedFailureReason({ state: "blocked", reason: "needs_human: which layout?" }, { state: "blocked", reason: "needs_human: which layout?" }),
    budget: repeatedFailureReason({ state: "blocked", reason: "run_budget_exceeded:tokens" }, { state: "blocked", reason: "run_budget_exceeded:tokens" }),
  };
}

/** n268: a critic's blocking finding is kept whole for the person; a change request with no blocking finding is an approval that carries the warnings. */
export function observeBlocks() {
  const blocking = { id: "f1", severity: "blocking", finding: "the guard is missing", criterion: "inputs are validated", path: "src/a.ts", line: 12, evidence: "export const a = 1;", impact: "a crash on empty input", status_note: "dropped" };
  const kept = codeCritiqueResultSchema.parse({ decision: "changes_requested", summary: "no guard", findings: [blocking] });
  const warned = codeCritiqueResultSchema.parse({ decision: "changes_requested", summary: "style", findings: [{ id: "w1", severity: "warning", finding: "name is vague", criterion: "naming" }] });
  return { decision: kept.decision, findings: kept.findings, warnedDecision: warned.decision, warnedCount: warned.findings.length };
}

/** n263: what the barrier archives per attempt. */
export function observeBarrierInput() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "run-d", "proj1", "bb", "/ws");
  createTask(db, { id: "t-barrier", runId: "run-d", kind: "bb", contract: taskOf("t-barrier") });
  const source = JSON.stringify({ evidenceSha256: "e", agent: "code-critic", task: taskOf("t-barrier") });
  recordStage(db, { runId: "run-d", taskId: "t-barrier", stageId: "code-critique", state: "blocked", input: source, reason: "changes_requested" });
  const receipt = listStageReceipts(db, "run-d", "t-barrier").find((row) => row.stageId === "code-critique")!;
  const body = barrierInputBody({ state: "blocked", inputSha256: receipt.inputSha256, diff: { "src/a.ts": "+x" }, promise: { given: "g", when: "w", then: "t" }, contract: taskOf("t-barrier"), priorVerdict: { status: "changes_requested" } });
  const long = barrierInputBody({ state: "passed", inputSha256: "s", diff: "x".repeat(200_050), promise: null, contract: null, priorVerdict: null });
  return { body, receiptSha: receipt.inputSha256, sourceSha: sha256Hex(source), longDiffTail: String(long.diff).slice(-24), longDiffLen: String(long.diff).length };
}

/** n269: the barrier's outcome lands on the attempt's row. */
export function observeBarrierRecord() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "run-d", "proj1", "bb", "/ws");
  createTask(db, { id: "t1", runId: "run-d", kind: "bb", contract: taskOf("t1") });
  createAttempt(db, { id: "a1", runId: "run-d", taskId: "t1" });
  recordGateEvaluation(db, { attemptId: "a1", projectId: "proj1", runId: "run-d", taskId: "t1", gate: "accept", status: "rejected", attempt: 1, input: "{}",
    summary: { writerStatus: "code_critique_blocked", reason: "critic asked for rework" }, tree: "deadbeef", verdict: { status: "rework", summary: "missing error handling" } });
  return getAttempt(db, "a1")!.barrier!;
}

/** n261: the verify step is a durable receipt (state, the hash of its input, the attempt number kept in 0-2). */
export function observeStepRecord() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "run-d", "proj1", "bb", "/ws");
  createTask(db, { id: "t1", runId: "run-d", kind: "bb", contract: taskOf("t1") });
  recordStage(db, { runId: "run-d", taskId: "t1", stageId: "verification", state: "pending", input: "plan one" });
  recordStage(db, { runId: "run-d", taskId: "t1", stageId: "verification", state: "running", input: "plan one", attempt: 4, providerId: "p", model: "m" });
  const row = listStageReceipts(db, "run-d", "t1").find((item) => item.stageId === "verification")!;
  return { row, inputSha: sha256Hex("plan one"), count: listStageReceipts(db, "run-d", "t1").filter((item) => item.stageId === "verification").length };
}

/** n262: the daemon runs a check itself in a sandbox on the candidate's copy; its exit code and both streams come back as they were. */
export async function observeSandboxCheck() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "sma-r01-d-sb-")));
  mkdirSync(join(ws, "sub"));
  const base = { requestedHostId: "h", workspacePath: ws, cwd: ws, backend: "linux-bubblewrap" as const };
  const green = await runSandboxedCommandOnHost({ ...base, command: "echo green-out; echo green-err >&2" });
  const red = await runSandboxedCommandOnHost({ ...base, command: "echo red-out; echo red-err >&2; exit 3" });
  const where = await runSandboxedCommandOnHost({ ...base, cwd: join(ws, "sub"), command: "pwd" });
  let outside = "";
  try { await runSandboxedCommandOnHost({ ...base, cwd: tmpdir(), command: "pwd" }); outside = "ran"; } catch (cause) { outside = (cause as Error).message; }
  return { ws, green, red, wherePwd: where.stdout.trim(), outside };
}

const gitTree = (cwd: string, ...args: string[]) => gitIn(cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args);

/** n258: the candidate (the worker's copy) is committed and merged with main; the merge names the hash, what main was and what changed. */
export async function observeCandidateMerge() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sma-r01-d-mg-")));
  const base = join(dir, "app");
  mkdirSync(base);
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  writeFileSync(join(base, "a.txt"), "a\n");
  gitTree(base, "add", ".");
  gitTree(base, "commit", "-qm", "first");
  const first = gitTree(base, "rev-parse", "HEAD");
  const target = join(dir, "wt", "lpattempt_d1");
  const made = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_d1", commit: first });
  writeFileSync(join(target, "c.txt"), "candidate\n");
  // Main moves while the worker works: the candidate is replayed on it and still merges.
  writeFileSync(join(base, "m.txt"), "main moved\n");
  gitTree(base, "add", ".");
  gitTree(base, "commit", "-qm", "main moved");
  const moved = gitTree(base, "rev-parse", "HEAD");
  const merged = await integrateWorktree({ basePath: base, worktreePath: target, message: "task d1", removeWorktree: true });
  const head = gitTree(base, "rev-parse", "HEAD");
  // A second candidate that clashes with main is refused, and main stays as it was.
  const clash = join(dir, "wt", "lpattempt_d2");
  await createWorktree({ basePath: base, targetPath: clash, name: "lpattempt_d2", commit: head });
  writeFileSync(join(clash, "c.txt"), "clash from the worker\n");
  gitTree(clash, "add", ".");
  gitTree(clash, "commit", "-qm", "clash");
  writeFileSync(join(base, "c.txt"), "clash on main\n");
  gitTree(base, "add", ".");
  gitTree(base, "commit", "-qm", "main took c.txt");
  const before = gitTree(base, "rev-parse", "HEAD");
  const refused = await integrateWorktree({ basePath: base, worktreePath: clash, message: "task d2" });
  return {
    made: { status: made.status, branch: made.branch }, first, moved, merged: { status: merged.status, commit: merged.commit, base: merged.base, changed: merged.changed, rebased: merged.rebased, worktreeRemoved: merged.worktreeRemoved },
    head, hasCandidateFile: existsSync(join(base, "c.txt")), hasMainFile: existsSync(join(base, "m.txt")), gone: !existsSync(target),
    refused: { status: refused.status, conflicts: refused.conflicts, commit: refused.commit }, mainAfterClash: gitTree(base, "rev-parse", "HEAD"), before,
  };
}

/** n273–n278: the automaton's states, the moves into them and the rows the ledger stamps with them. */
/** A move the automaton refuses is data here (`false`), not an exception: a changed table must fail the assertions, not the collection. */
function go(db: Parameters<typeof transitionAttempt>[0], id: string, to: Parameters<typeof transitionAttempt>[2], extra?: Parameters<typeof transitionAttempt>[3]): boolean {
  try { return transitionAttempt(db, id, to, extra); } catch { return false; }
}
const tryState = (from: Parameters<typeof nextAttemptState>[0], event: Parameters<typeof nextAttemptState>[1]): string => { try { return nextAttemptState(from, event); } catch (cause) { return (cause as Error).message; } };

export function observeAutomaton() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "run-d", "proj1", "bb", "/ws");
  createTask(db, { id: "t1", runId: "run-d", kind: "bb", contract: taskOf("t1") });
  const stateOf = (id: string) => getAttempt(db, id)?.state;
  createAttempt(db, { id: "a1", runId: "run-d", taskId: "t1" });
  const ready = { form: tryState(null, "form_task"), row: stateOf("a1"), no: getAttempt(db, "a1")?.attempt_no };
  const claimedTo = tryState("queued", "spawn_called");
  go(db, "a1", "spawn_requested");
  const claimed = { to: claimedTo, row: stateOf("a1"), skipRunning: isLegalMove("queued", "running") };
  const runningTo = tryState("spawn_requested", "spawn_ok");
  go(db, "a1", "running", { threadId: "thr_w" });
  const running = { to: runningTo, row: stateOf("a1"), thread: getAttempt(db, "a1")?.thread_id };
  const producedTo = tryState("running", "checks_passed");
  const failedTo = tryState("running", "validation_failed");
  go(db, "a1", "accepted");
  const produced = { to: producedTo, failedTo, row: stateOf("a1"), reopened: go(db, "a1", "running"), still: stateOf("a1") };
  createAttempt(db, { id: "a2", runId: "run-d", taskId: "t1" });
  go(db, "a2", "spawn_requested");
  go(db, "a2", "running");
  go(db, "a2", "validation_failed", { reason: "red" });
  const retryTo = tryState("validation_failed", "retry");
  const retryable = { first: retryAction("validation_failed", 1), exhausted: retryAction("validation_failed", MAIN_ATTEMPT_LIMIT), to: retryTo,
    spent: tryState("validation_failed", "retry_exhausted"), accepted: (() => { try { retryAction("accepted", 1); return "allowed"; } catch (cause) { return (cause as Error).message; } })() };
  createAttempt(db, { id: "a3", runId: "run-d", taskId: "t1" });
  go(db, "a3", "spawn_requested");
  go(db, "a3", "running");
  const cancelTo = tryState("running", "cancel");
  go(db, "a3", "cancel_requested");
  const canceledTo = tryState("cancel_requested", "cancel_observed");
  go(db, "a3", "canceled");
  const cancelled = { cancelTo, to: canceledTo, row: stateOf("a3"), late: go(db, "a3", "accepted"), still: stateOf("a3") };
  return { ready, claimed, running, produced, retryable, cancelled };
}

/** n284: the merge landed in main before the attempt's state caught up: every state that ended without acceptance moves to accepted, accepted never moves back. */
export function observeLanded() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "run-d", "proj1", "bb", "/ws");
  createTask(db, { id: "t1", runId: "run-d", kind: "bb", contract: taskOf("t1") });
  const landed: Record<string, string | undefined> = {};
  const tries = ["cancel_requested", "blocked", "provider_error", "timeout", "empty_output", "validation_failed"] as const;
  for (const [index, from] of tries.entries()) {
    const id = `l${index}`;
    createAttempt(db, { id, runId: "run-d", taskId: "t1" });
    go(db, id, "spawn_requested");
    go(db, id, "running");
    go(db, id, from);
    go(db, id, "accepted");
    landed[from] = getAttempt(db, id)?.state;
  }
  createAttempt(db, { id: "mainfix", runId: "run-d", taskId: "t1" });
  const mainfix = go(db, "mainfix", "accepted");
  return { landed, mainfix: getAttempt(db, "mainfix")?.state === "accepted" && mainfix, backToRunning: isLegalMove("accepted", "running"), backToQueued: isLegalMove("accepted", "queued") };
}

/** n279: acceptance needs a stage decided by code; opinion stages alone never accept. */
export function observeProofGap() {
  return {
    opinion: acceptanceProofGap(["plan-critique", "code-critique"]),
    none: acceptanceProofGap([]),
    code: acceptanceProofGap(["verification"]),
    mixed: acceptanceProofGap(["code-critique", "writer-agent"]),
  };
}

/** n280: a writer's launch line is refused push, merge, tag and release before any permit; a critic's and a PM's are not given that list. */
export function observePushRefused() {
  const line = (role: string) => claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role, agentType: role } as never);
  const flag = (text: string) => /--disallowedTools '([^']*)'/.exec(text)?.[1] ?? null;
  return { writer: flag(line("writer")), critic: flag(line("code-critic")), pm: flag(line("pm")), writerConst: WRITER_DISALLOWED_TOOLS, helperConst: HELPER_DISALLOWED_TOOLS };
}

/** n283: the owner's yes binds this very candidate; a no, a missing word and a yes for another candidate each hold the landing. */
export function observeAuthorized() {
  const word = (over: Record<string, unknown>) => ({ turn: "land", decision: "yes", text: "да", by: "owner", at: 1, attemptId: "att-1", ...over }) as never;
  return {
    off: landingWordGap(false, undefined, "att-1"),
    none: landingWordGap(true, [], "att-1"),
    yes: landingWordGap(true, [word({})], "att-1"),
    no: landingWordGap(true, [word({ decision: "no", text: "не сливать" })], "att-1"),
    other: landingWordGap(true, [word({ attemptId: "att-0" })], "att-1"),
    latestWins: landingWordGap(true, [word({ decision: "no", text: "позже" }), word({})], "att-1"),
  };
}

// ---- the critic session (n261, n264): a roster worker launched on the attempt's own copy to judge the candidate ----
const CRITIC_MODELS = ["claude-opus-5-5", "gpt-6.1-sol", "test-model"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }));

export const criticAnswer = (decision: "approve" | "changes_requested") => JSON.stringify({
  decision, summary: decision === "approve" ? "fine" : "the guard is missing",
  findings: decision === "approve" ? [] : [{ id: "f1", severity: "blocking", finding: "no guard on empty input", criterion: "inputs are validated", path: "src/a.ts", line: 1, evidence: "export const a = 1;" }],
});

export async function criticSession(answer: string) {
  const { runCodeCritique } = await import("../../src/rooms/critique/server/critique-runs");
  const { stageHelperSettings } = await import("../../src/rooms/settings/server/stage-settings");
  const { saveProjectSetting, setRunThread } = await import("../../src/rooms/plugin-db");
  const spawns: Array<Record<string, unknown>> = [];
  const atSpawn: Array<{ state: string; inputSha256: string } | null> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  harness.sdk.stub("providers.list", async () => ["claude-code", "codex", "opencode2"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] })));
  harness.sdk.stub("providers.models", async () => ({ models: CRITIC_MODELS.map((id) => ({ id, model: id, supportedReasoningEfforts: EFFORTS })) }));
  harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", projectId: "P", parentThreadId: "thr_root", sourceThreadId: "thr_root", lifecycleOwnerThreadId: "thr_root", status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => {
    const receipt = listStageReceipts(db, "r", "t1").find((row) => row.stageId === "code-critique");
    atSpawn.push(receipt ? { state: receipt.state, inputSha256: receipt.inputSha256 } : null);
    spawns.push(input);
    return { id: `crit${spawns.length}` };
  });
  harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }]);
  harness.sdk.stub("threads.output", async () => ({ output: answer }));
  harness.sdk.stub("threads.stop", async () => undefined);
  harness.sdk.stub("files.read", async () => ({ content: "export const a = 1;\n", contentEncoding: "utf8" }));
  bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
  createRun(db, "r", "P", "bb", "/repo");
  setRunThread(db, "r", "thr_pm");
  const task = { ...taskOf("t1"), project_cwd: "/repo", risk: "medium", owns_paths: ["src/**"], expected_outputs: ["src/a.ts"] } as never;
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo', environment_id='env_wt' WHERE id='a1'").run();
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  const hash = "d".repeat(64);
  const evidence = { truncated: false, artifactRevisionSha256: hash, evidenceSha256: hash, revisionSha256: hash, produced: ["src/a.ts"], hashes: {}, baselineHashes: {},
    verification: [{ command: "npm test", exitCode: 0 }], files: [{ path: "src/a.ts", diff: "+export const a = 1;", content: "export const a = 1;\n" }],
    packetSha256: hash, outputSha256: hash, ownsPaths: ["src/**"], neverTouch: [] };
  const config = { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "claude-code", pmModel: "claude-opus-5-5", writerProviderId: "claude-code", writerModel: "claude-opus-5-5" } as never;
  const result = await runCodeCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "r", taskId: "t1", config, task, evidence } as never);
  const receipt = listStageReceipts(db, "r", "t1").find((row) => row.stageId === "code-critique");
  await harness.lifecycle.dispose();
  return { result, spawns, atSpawn, receipt };
}

export async function observeCritic() {
  const approved = await criticSession(criticAnswer("approve"));
  const blocked = await criticSession(criticAnswer("changes_requested"));
  const meta = (approved.spawns[0] as { pluginMetadata?: Record<string, unknown> }).pluginMetadata ?? {};
  return {
    spawned: approved.spawns.length,
    environment: (approved.spawns[0] as { environment?: unknown }).environment,
    metaRole: meta.role, metaStage: meta.stageId, metaRun: meta.lanePilotRunId, metaTask: meta.lanePilotTaskId, metaParent: meta.parentPmThreadId,
    approved: { allowed: approved.result.allowed, review: approved.result.review, state: approved.receipt?.state, thread: approved.receipt?.threadId },
    blocked: { allowed: blocked.result.allowed, state: blocked.receipt?.state },
    atSpawn: approved.atSpawn[0],
    spawnKeys: Object.keys(approved.spawns[0] ?? {}).sort(),
  };
}

/** n270: the critic's refusal (status block) ends the attempt «blocked» with the verdict on its row, kept whole for the person; nothing is merged. */
export async function observeNeedsDecision() {
  const { createWriterFinish } = await import("../../src/rooms/writer/server/finish");
  const { createCore } = await import("../../src/rooms/core/server/core");
  const { stageHelperSettings } = await import("../../src/rooms/settings/server/stage-settings");
  const { saveProjectSetting, setRunThread } = await import("../../src/rooms/plugin-db");
  const spawns: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const answer = JSON.stringify({ status: "block", summary: "the query is built from the request body", evidence: "read src/a.ts and the vitest output",
    findings: [{ file: "src/a.ts", line: 1, severity: "critical", dimension: "security", evidence: "export const a = 1;", id: "f1", finding: "the query is built from the request body without a check" }] });
  harness.sdk.stub("providers.list", async () => ["claude-code", "codex"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] })));
  harness.sdk.stub("providers.models", async () => ({ models: CRITIC_MODELS.map((id) => ({ id, model: id, supportedReasoningEfforts: EFFORTS })) }));
  harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", projectId: "P", parentThreadId: "thr_root", sourceThreadId: "thr_root", lifecycleOwnerThreadId: "thr_root", status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: `crit${spawns.length}` }; });
  harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }]);
  harness.sdk.stub("threads.output", async () => ({ output: answer, text: "done" }));
  harness.sdk.stub("threads.stop", async () => undefined);
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("files.read", async () => ({ content: "export const a = 1;\n", contentEncoding: "utf8" }));
  harness.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) => method === "files"
    ? { outcome: "available", files: [{ path: "src/a.ts", revision: "r1" }], initialPatches: [{ path: "src/a.ts", patch: "@@\n+export const a = 1;\n", truncated: false }] }
    : { outcome: "available", patches: { "src/a.ts": { outcome: "available", patch: { path: "src/a.ts", patch: "@@\n+export const a = 1;\n", truncated: false } } } });
  harness.sdk.stub("environments.list", async () => [{ id: "env-1" }]);
  bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
  const task = { ...taskOf("t1"), project_cwd: "/repo", risk: "high", owns_paths: ["src/**"], expected_outputs: ["src/a.ts"], verify: "none", verification: [] } as never;
  createRun(db, "r", "P", "bb", "/repo");
  setRunThread(db, "r", "thr_pm");
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo', environment_id='env_wt' WHERE id='a1'").run();
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  const config = { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "claude-code", pmModel: "claude-opus-5-5", writerProviderId: "claude-code", writerModel: "claude-opus-5-5" } as never;
  const ctx = createCore(bb, db);
  const finish = createWriterFinish(ctx as never, {
    stageHelperSettings, activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined },
    validateWriterResult: async () => ({ status: "accepted", output: "done", produced: ["src/a.ts"], verification: [{ command: "npm test", exitCode: 0, stdout: "1 passed", stderr: "" }] }),
    persistWriterAcceptance: async () => ({ state: "passed" }),
    workspaceDirt: async () => ({ ok: true, snapshots: [{ path: "src/a.ts", sha256: sha256Hex("export const a = 1;\n") }] }),
    runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }),
  } as never);
  const result = await finish.finishWriterAttempt({ projectId: "P", config, task, runId: "r", taskId: "t1", attemptId: "a1", pmThreadId: "thr_pm", writerThreadId: "writer-1", dirtBefore: [] } as never);
  const attempt = getAttempt(db, "a1")!;
  const receipt = listStageReceipts(db, "r", "t1").find((row) => row.stageId === "code-critique");
  await harness.lifecycle.dispose();
  return { result: { status: result.status, reason: result.reason }, attempt: { state: attempt.state, reason: attempt.reason, barrier: attempt.barrier }, receipt: { state: receipt?.state, reason: receipt?.reason }, spawns: spawns.length };
}

// ---- n271: the candidate is declared prepared when the writer's change passes validation ----
type Dirt = { path: string; sha256: string | null };
const dirtOf = (sub: string): Dirt[] => JSON.parse(execFileSync("python3", ["-c", WORKSPACE_DIRT_SCRIPT], { cwd: sub, encoding: "utf8" })) as Dirt[];

async function validateIn(sub: string, taskId: string, dirtBefore: Dirt[], contents: Record<string, string | null>, answer: string) {
  const { createWriterVerify } = await import("../../src/rooms/writer/server/verify");
  const { buildRunPolicy } = await import("../../src/rooms/tasks/run-policy");
  const { setAttemptWorkspace } = await import("../../src/rooms/plugin-db");
  const dirtAfter = dirtOf(sub);
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    threads: { output: async () => ({ text: answer }) },
    files: { read: async ({ path }: { path: string }) => { for (const [rel, content] of Object.entries(contents)) if (path === `${sub}/${rel}`) return { content }; return { content: null }; } },
  } });
  const db = openDatabase(bb);
  const task = { ...taskOf(taskId), project_cwd: sub, expected_outputs: ["owned.ts"], owns_paths: ["owned.ts"], verify: "none", verification: [] } as TaskV2;
  createRun(db, "run-v", "P", "bb", sub);
  createTask(db, { id: taskId, runId: "run-v", kind: "bb", contract: task });
  createAttempt(db, { id: "att-v", runId: "run-v", taskId });
  setAttemptWorkspace(db, "att-v", { path: sub, environmentId: null, decision: { strategy: "inherit_run", reason: "sma r01 d" } });
  const ctx = { bb, db, log: () => undefined, host: { call: async () => { throw new Error("host must not be reached"); } }, runPolicyFor: () => buildRunPolicy({}) };
  const services = { runWriterPool: { acquire: async () => () => {} }, workspaceDirt: async () => ({ ok: true as const, paths: dirtAfter.map((row) => row.path), snapshots: dirtAfter }) };
  const config = { projectId: "P", hostId: "h", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/pm", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" };
  const result = await createWriterVerify(ctx as never, services as never).validateWriterResult({ config, projectId: "P", runId: "run-v", taskId, attempt: 1, task, writerThreadId: "w", attemptId: "att-v", dirtBefore } as never);
  return { status: result.status, reason: result.reason, produced: result.produced, hasDiffKey: typeof result.diffKey === "string" && result.diffKey.length === 64 };
}

export async function observePrepared() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sma-r01-d-vf-")));
  const repo = join(root, "site");
  mkdirSync(join(repo, "sub"), { recursive: true });
  const sub = join(repo, "sub");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(sub, "owned.ts"), "one\n");
  writeFileSync(join(sub, "other.ts"), "keep\n");
  gitTree(repo, "add", "-A");
  gitTree(repo, "commit", "-qm", "base");
  const before = dirtOf(sub);
  const idle = await validateIn(sub, "d-idle", before, { "owned.ts": "one\n" }, "I looked and changed nothing");
  writeFileSync(join(sub, "owned.ts"), "two\n");
  const done = await validateIn(sub, "d-done", before, { "owned.ts": "two\n" }, "changed owned.ts");
  writeFileSync(join(sub, "other.ts"), "not mine\n");
  const stray = await validateIn(sub, "d-stray", before, { "owned.ts": "two\n", "other.ts": "not mine\n" }, "changed owned.ts and other.ts");
  return { idle, done, stray };
}
