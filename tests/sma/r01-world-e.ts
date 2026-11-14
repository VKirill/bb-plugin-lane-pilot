// Region 1 · Task graph, batch e: observations of the real code of nodes n288..n319. Each function runs the node's own code on a scratch world and returns plain
// JSON; the tests assert on it and the drill scene's probe prints the very same values (scripts/lp_drill/scenes/sma_r01_e_probe.ts).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { taskV2Schema } from "../../packages/contracts/src/schemas";
import { acceptanceKey, acceptanceLines } from "../../src/rooms/phase/logic/acceptance";
import { pieceProblems } from "../../src/rooms/phase/logic/gates";
import type { Phase, PhaseRecord } from "../../src/rooms/phase/logic/record";
import { mountWorkflowAttemptFinished } from "../../src/rooms/workflow/server/after-accept";
import { HEAD_MOVED } from "../../src/rooms/verification/git-integrate/git-core";
import { integrateWorktree } from "../../src/rooms/verification/git-integrate/merge";
import { attemptMergeMessage, createMergeIntentRecovery, mergeIntentKey, recordMergeIntent, type RunOnHost } from "../../src/rooms/verification/server/merge-intent";
import { runCommandOnHost } from "../../src/rooms/writer/cli-run";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, saveTaskPlan, transitionAttempt } from "../../src/rooms/storage";
import { openDatabase } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { landingWordGap, birthFindings } from "../../src/rooms/tasks";
import { BIRTH_GATES, birthGates } from "../../src/rooms/contracts";
import { lintReply } from "../../src/rooms/tasks/server/contract-lint";
import { contractEditions, updateTaskContract } from "../../src/rooms/storage";
import { git, scratchRepo, taskOf } from "./r01-world-c";

const phaseOf = (record: PhaseRecord, stage: Phase["stage"] = "acceptance"): Phase => ({
  id: "ph_e", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
const NOW_BASE = { mainSha: "abc", openDeferrals: 0 };
const lineOf = (lines: ReturnType<typeof acceptanceLines>, id: string) => lines.find((row) => row.id === id)!;

/** A worktree `lane/<name>` cut from the scratch base's main. */
function worktreeOf(repo: { dir: string; base: string }, name: string): string {
  const path = join(repo.dir, name);
  git(repo.base, "worktree", "add", "-q", "-b", `lane/${name}`, path, "main");
  return path;
}
const commitIn = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, "add", "-A"); git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `add ${file}`); };

// n288 «Useful» and «limits acknowledged» — before anything else: a person's yes counts under the key of the package now shown.
export function decisionsObs() {
  const record: PhaseRecord = { ownerWords: true, plan: { items: [], sha: "plan", contextSha: "ctx", admittedSha: "plan" }, verification: { verdict: { state: "passed", detail: "ok", mainSha: "abc", at: 1, inputSha: "in" } } };
  const line = (id: string, words?: PhaseRecord["words"]) => lineOf(acceptanceLines(phaseOf({ ...record, words }), new Map(), NOW_BASE), id).ok;
  const yes = [{ turn: "acceptance" as const, decision: "yes" as const, by: "owner", text: "да", at: 1, useful: true, limits: true, key: acceptanceKey(record) }];
  const onlyUseful = [{ ...yes[0]!, limits: false }];
  return {
    none: [line("result_useful"), line("limits_acknowledged")], yes: [line("result_useful", yes), line("limits_acknowledged", yes)],
    onlyUseful: [line("result_useful", onlyUseful), line("limits_acknowledged", onlyUseful)], otherPackage: line("result_useful", [{ ...yes[0]!, key: "other-package" }]),
    notAsked: lineOf(acceptanceLines(phaseOf({ ...record, ownerWords: false }), new Map(), NOW_BASE), "result_useful").ok,
  };
}

// n289 An owed verification that did not run or refused closes the merge: the acceptance line «composition_verified».
export function unverifiedObs() {
  const at = (state?: "passed" | "failed") => lineOf(acceptanceLines(phaseOf({ plan: { items: [], sha: "p", contextSha: "c", admittedSha: "p" }, verification: state ? { verdict: { state, detail: state === "passed" ? "blind check green" : "blind check red: 2 failed", mainSha: "abc", at: 1, inputSha: "in" } } : undefined }), new Map(), NOW_BASE), "composition_verified");
  const none = at(), failed = at("failed"), passed = at("passed");
  return { none: [none.ok, none.detail], failed: [failed.ok, failed.detail], passed: [passed.ok, passed.detail] };
}

// n290 A lost race names the holder instead of staying silent.
export async function holderObs() {
  const repo = scratchRepo();
  const wt = worktreeOf(repo, "h1");
  writeFileSync(join(wt, "w.txt"), "w\n");
  const lock = join(repo.base, ".git", "lane-pilot-integrate.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${process.pid}\nwriter-a: Fix the form`);
  try {
    const busy = await integrateWorktree({ basePath: repo.base, worktreePath: wt, message: "m", lockWaitMs: 200 });
    return { status: busy.status, holder: (busy as { holder?: string | null }).holder, reason: busy.reason, mainKept: git(repo.base, "rev-parse", "HEAD") === repo.second, committed: git(wt, "log", "-1", "--format=%s") === "m" && busy.commit === git(wt, "rev-parse", "HEAD") };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

// n291 The tree that was verified is the tree that lands.
export async function mergeVerifiedObs() {
  const repo = scratchRepo();
  const moved = worktreeOf(repo, "m1");
  commitIn(moved, "f.txt", "verified\n");
  const verified = git(moved, "rev-parse", "HEAD");
  commitIn(moved, "g.txt", "after the verdict\n");
  const refused = await integrateWorktree({ basePath: repo.base, worktreePath: moved, message: "land", expectedHead: verified });
  const refusedMain = git(repo.base, "rev-parse", "HEAD");
  const leaked = existsSync(join(repo.base, "f.txt"));
  const kept = worktreeOf(repo, "m2");
  commitIn(kept, "f.txt", "verified\n");
  const head = git(kept, "rev-parse", "HEAD");
  const landed = await integrateWorktree({ basePath: repo.base, worktreePath: kept, message: "land", expectedHead: head });
  return {
    refused: [refused.status, String(refused.reason).startsWith(HEAD_MOVED), refusedMain === repo.second, leaked],
    landed: [landed.status, readFileSync(join(repo.base, "f.txt"), "utf8"), git(repo.base, "merge-base", "--is-ancestor", head, "HEAD") === ""],
  };
}

// n292 The work file is closed and re-read before the word «accepted».
export function bookCloseObs() {
  const record: PhaseRecord = { bookWritten: { seq: 5, sha256: "shaB", at: 1 } };
  const ok = (rec: PhaseRecord, book: { lastSeq: number; readSha: string }) => lineOf(acceptanceLines(phaseOf(rec), new Map(), { ...NOW_BASE, mainSha: null, book }), "book_closed").ok;
  return { intact: ok(record, { lastSeq: 5, readSha: "shaB" }), behind: ok(record, { lastSeq: 7, readSha: "shaB" }), tampered: ok(record, { lastSeq: 5, readSha: "other" }), neverWritten: ok({}, { lastSeq: 3, readSha: "x" }) };
}

// n293 Work without an owed verification takes the old path: `verify: none` needs no check command; any other verify does.
export function oldPathObs() {
  const item = (verify: string, verification: unknown[]) => ({ id: "p1", title: "P1", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id: "p1", owns_paths: ["src/"], acceptance: ["done"], verify, verification } }) as never;
  const noCheck = (problems: string[]) => problems.some((problem) => problem.includes("no verification command"));
  return { none: noCheck(pieceProblems(item("none", []))), tests: noCheck(pieceProblems(item("tests", []))), testsWithCheck: noCheck(pieceProblems(item("tests", [{ command: "npm test", cwd: "/ws" }]))) };
}

// n295 Memory harvest before the copy disappears: an accepted task starts the after-acceptance run (the memory and project-life maintainers).
export function harvestObs() {
  const started: string[][] = [];
  let subscriber: ((event: never) => void) | undefined;
  let name = "";
  mountWorkflowAttemptFinished({} as never, { onAttemptFinished: (_ctx: unknown, sub: never, label?: string) => { subscriber = sub; name = label ?? ""; }, startAfterAcceptance: (...args: string[]) => { started.push(args); } } as never);
  const emit = (scope: string, status: string) => subscriber!({ scope, status, projectId: "proj", runId: "run", taskId: `t-${scope}-${status}`, pmThreadId: "pm" } as never);
  emit("task", "accepted"); emit("task", "blocked"); emit("phase", "accepted"); emit("task", "failed");
  return { name, started };
}

// n296 A «landing» row with nobody behind it is finished after restart: the merge landed, its reply was lost, the recovery accepts the attempt.
export async function tornObs() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { send: async () => ({}) } } as never });
  const db = openDatabase(bb);
  const repo = scratchRepo();
  createRun(db, "run", "proj", "cli", repo.base);
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm' WHERE id='run'").run();
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
  saveTaskPlan(db, "T1", "Fix");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run", taskId: "T1", stageId, state: "pending", input: "Fix" });
  createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
  for (const state of ["spawn_requested", "running"]) transitionAttempt(db, "a1", state);
  const maintained: string[] = [];
  const services = { activeWriterTasks: new Set<string>(), startAfterAcceptance: (_p: string, _r: string, task: string) => { maintained.push(task); } };
  const run: RunOnHost = (hostId, cwd, command) => runCommandOnHost({ requestedHostId: hostId, cwd, command });
  const ctx = { bb, db, log: () => undefined, host: { call: (_method: string, input: { requestedHostId: string; cwd: string; command: string }) => runCommandOnHost(input) }, refreshRun: () => undefined } as never;
  const { recoverMergeIntents } = createMergeIntentRecovery(ctx, services as never);
  const message = attemptMergeMessage({ id: "T1", title: "Fix" }, "a1");
  const wt = worktreeOf(repo, "a");
  writeFileSync(join(wt, "new.ts"), "x\n");
  await recordMergeIntent(bb.storage.kv as never, run, { attemptId: "a1", runId: "run", taskId: "T1", projectId: "proj", hostId: "h", basePath: repo.base, worktreePath: wt, message });
  const merged = (await integrateWorktree({ basePath: repo.base, worktreePath: wt, message, removeWorktree: true })).status;
  const before = getAttempt(db, "a1")?.state;
  const first = await recoverMergeIntents();
  const after = getAttempt(db, "a1")?.state;
  const gate = db.prepare("SELECT gate, status FROM lane_pilot_gate_event WHERE task_id='T1'").all();
  const stages = listStageReceipts(db, "run", "T1").filter((row) => ["writer-agent", "verification", "acceptance-receipt"].includes(row.stageId)).map((row) => row.state);
  const intentLeft = Boolean(await bb.storage.kv.get(mergeIntentKey("a1")));
  const second = await recoverMergeIntents();
  return { merged, before, first, after, gate, stages, intentLeft, second, maintained };
}

// n297 After a return a new tree replaces the old and revokes consent.
export function replaceObs() {
  const words = [{ turn: "land" as const, decision: "yes" as const, text: "да", at: 1, attemptId: "att-A" }];
  const gap = (list: typeof words | Array<Omit<(typeof words)[0], "attemptId">>, attempt: string) => landingWordGap(true, list as never, attempt);
  return { same: gap(words, "att-A"), other: gap(words, "att-B"), noCandidate: gap([{ turn: "land", decision: "yes", text: "да", at: 1 }], "att-B"), off: landingWordGap(false, words, "att-B") };
}

// n298 A different hash is presented — the decision is taken anew: the person's word is keyed to the package it was given on.
export function staleObs() {
  const record: PhaseRecord = { ownerWords: true, plan: { items: [], sha: "plan-1", contextSha: "ctx", admittedSha: "plan-1" }, verification: { verdict: { state: "passed", detail: "ok", mainSha: "abc", at: 1, inputSha: "in" } } };
  const word = { turn: "acceptance" as const, decision: "yes" as const, by: "owner", text: "да", at: 1, useful: true, limits: true, key: acceptanceKey(record) };
  const useful = (rec: PhaseRecord) => lineOf(acceptanceLines(phaseOf({ ...rec, words: [word] }), new Map(), NOW_BASE), "result_useful");
  const replanned = useful({ ...record, plan: { ...record.plan!, sha: "plan-2", admittedSha: "plan-2" } });
  const newTree = useful({ ...record, verification: { verdict: { ...record.verification!.verdict!, mainSha: "def" } } });
  const same = useful(record);
  return { keyChanges: [acceptanceKey(record) !== acceptanceKey({ ...record, plan: { ...record.plan!, sha: "plan-2" } }), acceptanceKey(record) !== acceptanceKey({ ...record, verification: { verdict: { ...record.verification!.verdict!, mainSha: "def" } } })],
    same: same.ok, replanned: [replanned.ok, replanned.detail.startsWith("the owner's word was given on another package")], newTree: newTree.ok };
}

// n299 Five birth kinds of a row: the kind decides the gates.
export function birthKindsObs() {
  const task = { kind: "feature", risk: "medium" };
  const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code);
  return {
    pm: [codes(birthFindings(task, "pm").errors), codes(birthFindings(task, "pm").warnings)], phase: [codes(birthFindings(task, "phase").errors), codes(birthFindings(task, "phase").warnings)],
    bench: birthFindings(task, "bench"), loops: [birthGates("pm").topicLoop, BIRTH_GATES.phase.topicLoop, birthGates("redo", "phase").topicLoop, birthGates("backlog").topicLoop], redoPromise: birthGates("redo", "pm").promise,
  };
}

// n300 Enqueue gate: a closed field set, and a refusal that classes what is missing.
export function validateObs() {
  const reply = lintReply("run-1", [{ code: "clarify_open", message: "the task has open clarification questions: Which currency?" }]);
  const task = taskOf("x");
  return {
    state: reply.state, runId: reply.runId, nothing: String(reply.reason).includes("nothing was dispatched"), findings: reply.findings, classes: reply.blockingClasses,
    closed: [taskV2Schema.safeParse(task).success, taskV2Schema.safeParse({ ...task, surprise: 1 }).success],
  };
}

// n301 Every word change mints a new numbered, hashed edition; history is kept.
export function contractObs() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "p");
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { title: "v1" } });
  updateTaskContract(db, "t1", { title: "v2" });
  updateTaskContract(db, "t1", { title: "v3" });
  const editions = contractEditions(db, "t1");
  const first = db.prepare("SELECT contract_json FROM lane_pilot_task_contract_edition WHERE task_id='t1' AND edition=1").get() as { contract_json: string };
  return { editions: editions.map((row) => row.edition), distinct: new Set(editions.map((row) => row.sha256)).size, first: JSON.parse(first.contract_json) };
}

// n302 Promise items: Given, When, Then.
export function promiseObs() {
  const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code);
  const incomplete = birthFindings({ kind: "feature", risk: "low", promise: { given: "g", when: "", then: "t" } });
  const missing = birthFindings({ kind: "feature", risk: "medium" });
  const whole = birthFindings({ kind: "feature", risk: "medium", promise: { given: "g", when: "w", then: "t" } });
  return { incomplete: codes(incomplete.errors), missing: codes(missing.warnings), whole: [whole.errors, whole.warnings] };
}

