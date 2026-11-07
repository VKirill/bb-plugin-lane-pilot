import { parseIntegrationGateSettings, type ResolvedGate } from "../../contracts/integration-gate";
import type { IntegrationGateSettings, GateWhen } from "../../contracts/integration-gate";
import type { TaskV2, PrototypeConfig } from "../../contracts";
import type { GateRunRow, GateRunState, LanePilotDatabase, StageReceiptRow } from "../../storage";
import { finishGateRun, getRun, getRunSettingsScopes, getTask, getTaskContractJson, latestGateRun, latestGateRunForTask, listStageReceipts, listTaskIdsForRun, loadProjectSettings, noteGateRunStart, transitionAttempt } from "../../storage";
import { recordGateEvaluation } from "../../runs/server/stage-records";
import { bestEffort, stringAt, stripAnsi } from "@lane-pilot/kit";
import type { ServerCore } from "../../contracts/server";

import { isEnvironmentCheckFailure } from "../../contracts/failure-class";
import { isMainfixTask, readCheckRun } from "../../tasks";
import { gateLabel, gateResolverFor } from "./gate-detect"
import { continuesEpisode, type GateEpisode } from "./gate-episode";
import { closeOwnerItemsByPrefix, postOwnerItem } from "../../owner-waiting";
import type { LeadRoadApi } from "../../contracts";
import { attributeFailures, testLabel } from "./gate-attribution";
import { cacheHitsNote, extractCacheHits, extractFailingFiles, extractFailingTests, unhandledErrorBlock, type FailingTest } from "../gate-output";
import { flakyEvidence, outputTail, readingFrom } from "../machine-pressure";
import type { GateAttributeResult } from "../integration-gate-host";
import { join } from "node:path";

import type { DispatchWriter } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  leadRoad: LeadRoadApi;
  dispatchWriter: DispatchWriter;
}



export type FailingGateCheck = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failedFiles: string[];
};

export { extractFailingFiles };

export type MergedTaskInfo = {
  taskId: string;
  commitSha: string;
  threadId: string | null;
  attemptId: string | null;
  produced: string[];
};

/**
 * The durable record of one integration-gate run (lane_pilot_gate_run): «all tasks accepted» alone never said what
 * main's own check did after the merge — still running, red, never ran, or green, and on which commit (Astra F1).
 */
const GATE_RUN_STALE_MS = 35 * 60_000; // gate timeout (30 min) + slack

/** A run left `running` past the gate's own timeout died with it (a reload kills the in-flight call): it ran no verdict. */
function gateRunEffective(row: GateRunRow, now = Date.now()): { state: GateRunState; reason: string | null } {
  if (row.state === "running" && now - row.updatedAt > GATE_RUN_STALE_MS) {
    return { state: "not_run", reason: "the gate run was interrupted (timeout or reload)" };
  }
  return { state: row.state, reason: row.reason };
}

/**
 * The gate state the PM reads next to an accepted task / in preship, in the brief's words:
 * `green on <short sha>` / `running` / `red: <command>` / `not run: <reason>`. `pending` while the verdict is still out.
 */
export function gateRunVerdict(row: GateRunRow | undefined): { line: string; pending: boolean; failed: boolean } {
  if (!row) return { line: "running", pending: true, failed: false };
  const eff = gateRunEffective(row);
  if (eff.state === "running") return { line: "running", pending: true, failed: false };
  if (eff.state === "passed") return { line: `green on ${row.head ? row.head.slice(0, 12) : "unknown commit"}`, pending: false, failed: false };
  if (eff.state === "failed") return { line: `red: ${row.command}${eff.reason ? ` (${eff.reason.slice(0, 160)})` : ""}`, pending: false, failed: true };
  return { line: `not run: ${eff.reason ?? "unknown"}`, pending: false, failed: true };
}

/**
 * Parses static imports from file content to trace dependency to changed files.
 */
export function extractStaticImports(source: string): string[] {
  const imported = new Set<string>();
  const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    if (match[1]) imported.add(match[1]);
  }
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(source)) !== null) {
    if (match[1]) imported.add(match[1]);
  }
  return [...imported];
}

/**
 * Reads a file of the project checkout, relative to its root, on the machine that holds it; null when it cannot be read.
 * The project may live on another host: the hub never opens its path.
 */
export type ProjectFileReader = (relativePath: string) => Promise<string | null>;

/**
 * Checks if a failing file is related to a merged task by checking:
 * 1. Did the task touch/produce this file directly?
 * 2. Did the task touch/produce a file imported by this failing file?
 */
export async function isFileRelatedToTask(
  failingFile: string,
  taskProduced: string[],
  readProjectFile: ProjectFileReader
): Promise<boolean> {
  const norm = (p: string) => p.replace(/^\.\//, "").trim();
  const failingNorm = norm(failingFile);
  const taskProducedSet = new Set(taskProduced.map(norm));

  if (taskProducedSet.has(failingNorm)) return true;

  // Check imports in failingFile if it can be read
  try {
    const content = await readProjectFile(failingNorm);
    if (content === null) throw new Error("unreadable");
    const rawImports = extractStaticImports(content);
    for (const imp of rawImports) {
      if (imp.startsWith(".")) {
        // Resolve relative to failingNorm
        const failingDir = failingNorm.includes("/") ? failingNorm.slice(0, failingNorm.lastIndexOf("/")) : "";
        const candidateBase = join(failingDir, imp).replace(/^\.\//, "");
        for (const prod of taskProducedSet) {
          const prodNoExt = prod.replace(/\.[^/.]+$/, "");
          if (candidateBase === prod || candidateBase === prodNoExt || prod.startsWith(candidateBase)) {
            return true;
          }
        }
      } else {
        for (const prod of taskProducedSet) {
          if (prod.includes(imp)) return true;
        }
      }
    }
  } catch {
    // Cannot read file, check basic substring/basename relation
    for (const prod of taskProducedSet) {
      if (prod.includes(failingNorm) || failingNorm.includes(prod)) return true;
    }
  }

  return false;
}

export async function findCulpritByFiles(
  failingFiles: string[],
  mergedTasks: MergedTaskInfo[],
  readProjectFile: ProjectFileReader
): Promise<MergedTaskInfo | null> {
  if (mergedTasks.length === 0) return null;
  if (failingFiles.length === 0) return null;

  const matchingTasks = new Set<MergedTaskInfo>();

  for (const task of mergedTasks) {
    for (const file of failingFiles) {
      if (await isFileRelatedToTask(file, task.produced, readProjectFile)) {
        matchingTasks.add(task);
        break;
      }
    }
  }

  if (matchingTasks.size === 1) {
    return [...matchingTasks][0]!;
  }
  return null;
}

/**
 * Fallback: bisect over the commits of mergedTasks with the gate command, as one host job on the project's machine (a
 * scratch worktree there; the checkout itself is not moved). Null when the host cannot name a first bad commit.
 */
export async function bisectCulprit(
  host: ServerCore["host"],
  hostId: string,
  gateCommand: string,
  goodSha: string,
  badSha: string,
  basePath: string,
  mergedTasks: MergedTaskInfo[],
  timeoutMs = 30 * 60_000
): Promise<MergedTaskInfo | null> {
  try {
    const found = await host.call("gateBisect", {
      requestedHostId: hostId, basePath, command: gateCommand, goodSha, badSha, timeoutSec: Math.ceil(timeoutMs / 1000),
    }, { hostId, timeoutMs: timeoutMs + 60_000 });
    if (found.status !== "found" || !found.commit) return null;
    const badCommit = found.commit;
    return mergedTasks.find((t) => t.commitSha.startsWith(badCommit) || badCommit.startsWith(t.commitSha)) ?? null;
  } catch {
    return null;
  }
}

export function formatFixTurnPrompt(input: {
  taskId: string;
  gateCommand: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  logPath: string;
  /** The failing tests your task's diff can have broken (the host checked they pass on the base and live in a workspace the task touched). */
  failingTests?: string[];
  /** Failing tests that also fail on the base commit: not this task's, to be left alone. */
  preexistingTests?: string[];
  /** The run's own «Unhandled Errors» block (gate-output.ts `unhandledErrorBlock`): it fails the run with every test green and sits above the 800-char tail. */
  unhandled?: string | null;
}): string {
  const tail = `${input.stderr}\n${input.stdout}`.trim().slice(-800);
  return `Result: integration gate failed after merging your task ${input.taskId}.
Full check log: ${input.logPath}

→ The integration gate command \`${input.gateCommand}\` exited with code ${input.exitCode}.${input.failingTests?.length ? `\n→ Failing tests your change can have broken: ${input.failingTests.join(", ")}.` : ""}${input.preexistingTests?.length ? `\n→ Also red, but they fail without your change too (not yours, leave them): ${input.preexistingTests.join(", ")}.` : ""}${input.unhandled ? `\n→ The run reported an unhandled error outside any test (it fails the run even with every test green): ${input.unhandled}` : ""}
→ Output tail:
${tail}

Make this pass on main. Change only what your task requires within owns_paths.`;
}

const TIMEOUT_ERROR_PATTERN = /(?:Test timed out in|Hook timed out in|\bTimeout\b|\btimed out\b)/i;

/**
 * Returns true if every failing test was caused exclusively by a timeout (e.g. machine load).
 * Returns false if there are no failing tests or if any test failed with non-timeout errors (e.g. assertion).
 */
export function allFailuresAreTimeouts(output: string, failingTests: readonly FailingTest[]): boolean {
  if (!failingTests.length) return false;
  const clean = stripAnsi(output);
  const lines = clean.split("\n");

  // If there are standard assertion / syntax / type errors anywhere in output, it's not all timeouts
  if (/\bAssertionError\b|\bexpected\s+.+\s+to\b|\berror TS\d+:/.test(clean)) {
    return false;
  }

  // Find sections or errors per failing test
  // Map files to whether a timeout was seen for that file
  const testFiles = new Set(failingTests.map((t) => t.file));
  const timeoutsByFile = new Set<string>();

  // In vitest / jest output:
  // e.g. FAIL tests/foo.test.ts > suite > test
  // Error: Test timed out in 5000ms.
  // or ❯ tests/foo.test.ts:24:5
  // or blocks per file. Let's associate lines with the current failing file being reported.
  let currentFile: string | null = null;

  for (const line of lines) {
    for (const file of testFiles) {
      if (line.includes(file)) {
        currentFile = file;
        break;
      }
    }

    if (TIMEOUT_ERROR_PATTERN.test(line)) {
      if (currentFile) {
        timeoutsByFile.add(currentFile);
      }
    }
  }

  // If not every file was associated via block tracking, check if global output has timeout
  // and each file is mentioned with a timeout or all errors in output are timeouts.
  if (timeoutsByFile.size === testFiles.size) {
    return true;
  }

  // Also handle case where test headers and errors appear in distinct structures:
  // If the output contains TIMEOUT_ERROR_PATTERN and no other failure keywords (AssertionError, etc.)
  const hasTimeout = TIMEOUT_ERROR_PATTERN.test(clean);
  const hasAssertionOrOtherFail = /\bAssertionError\b|\bExpected:|\bReceived:|\bexpect\(|\bassert\b/i.test(clean);

  if (hasTimeout && !hasAssertionOrOtherFail) {
    return true;
  }

  return false;
}

export function buildRecheckGateCommand(gateCommand: string, failingFiles: readonly string[]): string | null {
  // A detected `npm test` / `pytest -q` used to re-run the whole suite after an all-timeouts red (grill 2026-10-29 F-007): the files go
  // after `--` to a package script (vitest, jest, mocha and node --test all take them) and straight to pytest. A runner this cannot
  // narrow (`make check`, `python3 -I scripts/studio_test.py`) gets no encore at all: null, and the timeouts stand as the verdict.
  const isVitestOrJest = /(?:^|[;&|]\s*)(?:npx\s+)?(?:vitest|jest)(?:\s+run)?(?:\s+|$)/i.test(gateCommand);
  const isPytest = /(?:^|[;&|]\s*)(?:python3?\s+-m\s+)?pytest(?:\s|$)/i.test(gateCommand);
  const isPackageScript = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?test\s*$/i.test(gateCommand.trim());
  if (!failingFiles.length || !(isVitestOrJest || isPytest || isPackageScript)) return null;
  const uniqueFiles = [...new Set(failingFiles)];
  return isPackageScript ? `${gateCommand.trim()} -- ${uniqueFiles.join(" ")}` : `${gateCommand} ${uniqueFiles.join(" ")}`;
}

/** Which checkout a merge or a gate run belongs to: the gate's queue and green commit are per scope (F-007). */
type GateScope = { projectId?: string; hostId?: string; basePath?: string };

type GateInput = Parameters<IntegrationGateRunner["maybeRunGate"]>[0];

export class IntegrationGateRunner {
  private inFlight = false;
  /** Merges waiting for their gate. `key === ""` is a legacy/unscoped merge: it joins every scope's batch (tests, one-project setups). */
  private pending: { key: string; task: MergedTaskInfo }[] = [];
  /** The commit the gate last proved green, per scope. */
  private readonly lastGreenCommits = new Map<string, string>();
  /** Drains that arrived while a gate ran, per scope: several drains of different projects no longer overwrite one slot. */
  private readonly drainWaiting = new Map<string, GateInput>();
  /** The red-gate episode of each run: the owner is asked once per episode, see `./gate-episode`. */
  private readonly episodes = new Map<string, GateEpisode>();

  constructor(
    private readonly ctx: ServerCore,
    private readonly services: Services
  ) {}

  private keyOf(scope: GateScope): string {
    return `${scope.projectId ?? ""}${scope.hostId ?? ""}${scope.basePath ?? ""}`;
  }

  /** The merges a scope's gate still has to check, oldest first. Unscoped merges belong to every scope's batch. */
  private pendingFor(key: string): MergedTaskInfo[] {
    return this.pending.filter((p) => !p.key || p.key === key).map((p) => p.task);
  }

  /** Drops the first `count` merges of the scope's batch, leaving merges that landed during the run and other scopes'. */
  private consumePending(key: string, count: number): void {
    let left = count;
    this.pending = this.pending.filter((p) => {
      if (left > 0 && (!p.key || p.key === key)) { left -= 1; return false; }
      return true;
    });
  }

  noteMergedTask(task: MergedTaskInfo, scope?: GateScope) {
    this.pending.push({ key: scope ? this.keyOf(scope) : "", task });
  }

  getPendingMergeCount(): number {
    return this.pending.length;
  }

  async maybeRunGate(input: {
    runId: string;
    projectId: string;
    pmThreadId: string;
    basePath: string;
    configHostId: string;
    trigger: "merge" | "drain";
    /** The folder has no git: the gate runs in place, and a red result is reported, never bisected. */
    live?: boolean;
  }): Promise<{ ran: boolean; passed?: boolean; culpritTaskId?: string | null }> {
    const key = this.keyOf({ projectId: input.projectId, hostId: input.configHostId, basePath: input.basePath });
    const settings = loadProjectSettings(this.ctx.db, input.projectId, getRunSettingsScopes(this.ctx.db, input.runId));
    const gateSettings = parseIntegrationGateSettings(settings);
    const gate = await gateResolverFor(this.ctx)({ runId: input.runId, hostId: input.configHostId, basePath: input.basePath, gate: gateSettings });

    if (!gate) {
      return { ran: false };
    }

    if (input.trigger === "merge" && gateSettings.gateWhen === "every_n") {
      if (this.pendingFor(key).length < gateSettings.gateEvery) {
        return { ran: false };
      }
    } else if (input.trigger === "merge" && gateSettings.gateWhen === "queue_drained") {
      return { ran: false };
    }

    // Don't run concurrently; a drain that came while one runs is the batch's gate, so it goes once this one is done.
    if (this.inFlight) {
      if (input.trigger === "drain") this.drainWaiting.set(key, input);
      return { ran: false };
    }

    this.inFlight = true;
    let result: { ran: boolean; passed?: boolean; culpritTaskId?: string | null } = { ran: false };
    try {
      result = await this.executeGate({ ...input, gate }, key);
      return result;
    } finally {
      this.inFlight = false;
      // This scope's queued drain re-runs first; otherwise the first parked drain of another scope that still has merges waiting runs now
      // (Astra F-007 residual: `inFlight` is one flag for every scope, so a drain parked while another project's gate ran used to wait
      // for that project's next merge, and its batch sat ungated).
      const waiting = this.drainWaiting.get(key);
      this.drainWaiting.delete(key);
      let next = waiting && result.ran && this.pendingFor(key).length > 0 ? waiting : undefined;
      if (!next) for (const [parkedKey, parked] of this.drainWaiting) { if (this.pendingFor(parkedKey).length > 0) { this.drainWaiting.delete(parkedKey); next = parked; break; } }
      if (next) void this.maybeRunGate(next).catch((cause: unknown) => this.ctx.log(`integration-gate: queued run failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }

  private async executeGate(input: {
    runId: string;
    projectId: string;
    pmThreadId: string;
    basePath: string;
    configHostId: string;
    gate: ResolvedGate;
    live?: boolean;
  }, key: string): Promise<{ ran: boolean; passed?: boolean; culpritTaskId?: string | null }> {
    const { runId, projectId, basePath, configHostId, gate } = input;
    const gateCommand = gate.command;
    const label = gateLabel(gate);
    const db = this.ctx.db;
    const bb = this.ctx.bb;
    const host = this.ctx.host;
    // The gate, git and file reads run on the project's own host, never at the project's path on the hub.
    const GATE_TIMEOUT_SEC = 30 * 60;
    const readProjectFile: ProjectFileReader = async (relativePath) => {
      const read = await bestEffort(this.ctx.log, `gate read ${relativePath}`, host.call("readBoundedFile", { requestedHostId: configHostId, projectCwd: basePath, relativePath, offset: 0, maxLines: 2000 }, { hostId: configHostId, timeoutMs: 30_000 }), null);
      return read ? read.content : null;
    };

    // Snapshot this scope's batch before the run: merges that land while the gate runs belong to the next batch.
    const batch = this.pendingFor(key);
    const lastGreenCommit = this.lastGreenCommits.get(key) ?? null;
    // Record stage on the merged task if one exists in the database
    const lastMerged = batch[batch.length - 1];
    let runTaskId = lastMerged?.taskId;
    if (!runTaskId) {
      runTaskId = listTaskIdsForRun(db, runId)[0] ?? "integration-gate";
    }
    const hasTaskInDb = getTaskContractJson(db, runTaskId) !== null;

    this.ctx.log(`integration-gate: running \`${gateCommand}\` on ${basePath}`);
    // The machine the gate runs on, read right before a run (never during it): a timeout that passes on the recheck is called «load» only on a reading.
    const sampleMachine = async () => {
      try { return readingFrom(await host.call("diskFree", { requestedHostId: configHostId, path: basePath, machine: true }, { hostId: configHostId, timeoutMs: 5_000 })); }
      catch { return null; }
    };
    const beforeGate = await sampleMachine();

    // The run's record goes down before it starts: «accepted» alone never says the gate is still out (Astra F1).
    const gateRunId = noteGateRunStart(db, { projectId, runId, scopeKey: key, command: gateCommand, batch });

    const ran = await host.call("gateRun", { requestedHostId: configHostId, basePath, command: gateCommand, timeoutSec: GATE_TIMEOUT_SEC },
      { hostId: configHostId, timeoutMs: (GATE_TIMEOUT_SEC + 60) * 1000 }).catch((cause: unknown) => {
      this.ctx.log(`integration-gate: could not run \`${gateCommand}\` on host ${configHostId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    // A gate that could not run says nothing about main: no culprit; the merges stay counted for the next run.
    if (!ran) {
      finishGateRun(db, gateRunId, "not_run", { reason: `host could not run it on ${configHostId}` });
      return { ran: false };
    }

    const exitCode = ran.exitCode;
    const stdout = ran.stdout;
    const stderr = ran.stderr;
    // The same reading as the writer's check, the replay and the post-merge check (readCheckRun): a green that ran no test is no pass.
    const reading = readCheckRun({ exitCode, stdout, stderr }, { command: gateCommand });
    const passed = reading.verdict === "pass";

    // turbo answers a task from its cache without running it: a result the PM should know was not rerun.
    const cache = extractCacheHits(`${stdout}\n${stderr}`);
    const cacheNote = cacheHitsNote(cache);
    const receiptResult = {
      command: gateCommand,
      source: gate.source,
      detail: gate.detail,
      exitCode,
      passed,
      mergesChecked: batch.length,
      head: ran.head ?? null,
    };

    // The gate's verdict is a gate evaluation of the batch. It used to be written over the last merged task's own
    // `verification` receipt, which was already passed: «illegal stage transition verification: passed -> failed» was
    // thrown from a fire-and-forget call and took the whole BB server down (2026-10-08 21:05 UTC).
    if (hasTaskInDb) {
      try {
        recordGateEvaluation(db, { projectId, runId, taskId: runTaskId, gate: "verification", status: passed ? "passed" : "failed",
          attempt: 0, input: gateCommand, summary: receiptResult });
      } catch (cause) {
        this.ctx.log(`integration-gate: could not record the verdict: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    if (passed) {
      this.episodes.delete(runId);
      closeOwnerItemsByPrefix(this.ctx.db as never, `gate-red:${runId}:`, "gate green"); // the red rows of this run leave the owner's list (Gemini F-006.3)
      this.consumePending(key, batch.length);
      // Save the commit the gate ran on as the last green one
      if (ran.head) this.lastGreenCommits.set(key, ran.head);
      finishGateRun(db, gateRunId, "passed", { head: ran.head ?? null });
      return { ran: true, passed: true };
    }

    // Exit 0 with no test run: nothing is red, so no culprit; but nothing is proven either, and the merges stay counted for the next run.
    if (exitCode === 0) {
      finishGateRun(db, gateRunId, "not_run", { head: ran.head ?? null, reason: `exit 0 but no test ran: ${reading.reason}` });
      this.ctx.log(`integration-gate: \`${gateCommand}\` exited 0 but proved nothing, no culprit searched: ${reading.reason}`);
      this.noteRed({ runId, projectId }, this.enterEpisode(runId, gateCommand, ["(no test ran)"]), "gate_no_test",
        `Проверка после слияния (${label}) завершилась без единого теста: ${reading.reason}.`,
        "Зелёной её считать нельзя, но и виноватого коммита нет, поэтому никого не искали. Нужно поправить команду проверки или её тесты; проверка повторится при следующем слиянии.");
      return { ran: true, passed: false, culpritTaskId: null };
    }

    // The machine broke the gate (root-owned files, a permission error before any test ran): no commit is to blame and no
    // writer can fix it in owns_paths, so no culprit, no bisect, no fix turn. The merges stay counted for the next run.
    if (isEnvironmentCheckFailure({ stdout, stderr })) {
      const evidence = `${stderr}\n${stdout}`.split("\n").find((line) => isEnvironmentCheckFailure({ stderr: line }))?.trim().slice(0, 300) ?? "";
      finishGateRun(db, gateRunId, "not_run", { head: ran.head ?? null, reason: `machine: ${evidence.slice(0, 200)}` });
      this.ctx.log(`infra: integration gate \`${gateCommand}\` is red from the environment, no culprit searched: ${evidence}`);
      this.noteRed({ runId, projectId }, this.enterEpisode(runId, gateCommand, ["(environment)"]), "gate_machine",
        `Проверка после слияния (${label}) красная из-за машины, а не кода: ${evidence}.`,
        `Виноватого не искали и исправление никому не отправляли. Нужно починить машину (владельцы файлов или права в ${basePath}); проверка повторится при следующем слиянии.`);
      return { ran: true, passed: false, culpritTaskId: null };
    }

    // Gate failed. Check if all failures are test timeouts (e.g. machine load) and can be rechecked once.
    let failingTests = extractFailingTests(`${stderr}\n${stdout}`);
    let activeExitCode = exitCode;
    let activeStdout = stdout;
    let activeStderr = stderr;
    let activeHead = ran.head;
    let repeatedTimeouts = false;

    const timeoutsOnly = allFailuresAreTimeouts(`${stderr}\n${stdout}`, failingTests);
    const recheckCmd = timeoutsOnly ? buildRecheckGateCommand(gateCommand, [...new Set(failingTests.map((t) => t.file))]) : null;
    if (timeoutsOnly && !recheckCmd) this.ctx.log(`integration-gate: all failures are timeouts, but \`${gateCommand}\` cannot re-run only the failing files: no encore, the timeouts stand (grill 2026-10-29 F-007)`);
    if (recheckCmd) {
      this.ctx.log(`integration-gate: all failures are timeouts; rechecking with \`${recheckCmd}\``);
      const beforeRecheck = await sampleMachine();

      const rechecked = await host.call("gateRun", { requestedHostId: configHostId, basePath, command: recheckCmd, timeoutSec: GATE_TIMEOUT_SEC },
        { hostId: configHostId, timeoutMs: (GATE_TIMEOUT_SEC + 60) * 1000 }).catch((cause: unknown) => {
        this.ctx.log(`integration-gate: recheck \`${recheckCmd}\` failed to run on host ${configHostId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      });

      // A recheck counts only when it shows it ran a test; a command that filtered every test away, or printed no summary the first run printed, is no green.
      const recheckReading = rechecked ? readCheckRun(rechecked, { command: recheckCmd, first: { stdout, stderr } }) : null;
      if (rechecked && recheckReading?.verdict === "pass") {
        // The first run's failure is kept with the readings, so «load» is a measured verdict or «unexplained», not the log's guess.
        const evidence = flakyEvidence({ exitCode, outputTail: outputTail({ stdout, stderr }) }, beforeGate, beforeRecheck);
        this.ctx.log(`integration-gate: ${failingTests.length} timeouts passed on recheck, gate green (${evidence.classification}: ${evidence.basis})`);
        if (hasTaskInDb) {
          const recheckReceiptResult = {
            command: recheckCmd,
            originalCommand: gateCommand,
            source: gate.source,
            detail: gate.detail,
            exitCode: 0,
            passed: true,
            mergesChecked: batch.length,
            head: rechecked.head ?? ran.head ?? null,
            note: `rechecked: timeouts passed on the second run (${evidence.classification})`,
            flakyEvidence: evidence,
            recheckedTests: failingTests.map(testLabel),
          };
          try {
            recordGateEvaluation(db, {
              projectId,
              runId,
              taskId: runTaskId,
              gate: "verification",
              status: "passed",
              attempt: 0,
              input: gateCommand,
              summary: recheckReceiptResult,
            });
          } catch (cause) {
            this.ctx.log(`integration-gate: could not record recheck verdict: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }

        this.episodes.delete(runId);
        closeOwnerItemsByPrefix(this.ctx.db as never, `gate-red:${runId}:`, "gate green"); // the red rows of this run leave the owner's list (Gemini F-006.3)
        this.consumePending(key, batch.length);
        if (rechecked.head) this.lastGreenCommits.set(key, rechecked.head);
        finishGateRun(db, gateRunId, "passed", { head: rechecked.head ?? ran.head ?? null });
        return { ran: true, passed: true };
      }

      if (rechecked && recheckReading?.verdict === "not_run") {
        // The recheck proved nothing: the timeouts stand, the culprit flow continues on the original output.
        this.ctx.log(`integration-gate: recheck \`${recheckCmd}\` exited 0 but proved nothing (${recheckReading.reason}); the timeouts stand`);
        repeatedTimeouts = true;
      } else if (rechecked) {
        const recheckFailingTests = extractFailingTests(`${rechecked.stderr}\n${rechecked.stdout}`);
        if (allFailuresAreTimeouts(`${rechecked.stderr}\n${rechecked.stdout}`, recheckFailingTests)) {
          // Still timeouts on recheck: continue normal culprit flow with original output, note repeated timeouts
          repeatedTimeouts = true;
        } else {
          // Recheck failed with real failures: switch to recheck output for culprit flow
          activeExitCode = rechecked.exitCode;
          activeStdout = rechecked.stdout;
          activeStderr = rechecked.stderr;
          activeHead = rechecked.head;
          failingTests = recheckFailingTests;
        }
      }
    }

    // Gate failed. Find culprit.
    const failingFiles = [...new Set(failingTests.map((test) => test.file))];
    const tasksToCheck = batch;

    // The host knows what each merged commit changed and which failing tests also fail on the base the batch started from.
    let info: GateAttributeResult | null = null;
    if (!input.live && failingTests.length) {
      const commits = tasksToCheck.map((task) => task.commitSha).filter((sha) => /^[a-f0-9]{7,64}$/.test(sha));
      const baseSha = lastGreenCommit ?? (commits[0] ? `${commits[0]}^1` : null);
      const ATTRIBUTE_TIMEOUT_SEC = 20 * 60;
      info = await host.call("gateAttribute", { requestedHostId: configHostId, basePath, baseSha, commits, failing: failingTests.slice(0, 300), timeoutSec: ATTRIBUTE_TIMEOUT_SEC },
        { hostId: configHostId, timeoutMs: (ATTRIBUTE_TIMEOUT_SEC + 60) * 1000 }).catch((cause: unknown) => {
        this.ctx.log(`integration-gate: could not attribute the failing tests on host ${configHostId}, the older file search is used: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      });
    }
    const attribution = attributeFailures(failingTests, tasksToCheck, info);

    let culprit: MergedTaskInfo | null = null;
    if (input.live) {
      // A folder without git has no commits to bisect and no merges to blame: the PM and the owner get the red result.
    } else if (attribution.strict) {
      // Only a task whose diff touches a failing test (or its workspace) and that was green on the base can be the culprit.
      const { candidates, remaining } = attribution;
      if (candidates.length === 1) culprit = candidates[0]!;
      else if (candidates.length > 1) {
        culprit = await findCulpritByFiles(remaining.map((test) => test.file), candidates, readProjectFile);
        if (!culprit && lastGreenCommit && ran.head && ran.head !== lastGreenCommit) {
          const found = await bisectCulprit(host, configHostId, gateCommand, lastGreenCommit, ran.head, basePath, tasksToCheck);
          culprit = found && candidates.includes(found) ? found : null;
        }
      }
    } else {
      culprit = await findCulpritByFiles(failingFiles, tasksToCheck, readProjectFile);
    }

    // Fallback (the host could not attribute): git bisect with a proven green base works even for one task — the only
    // evidence a lone merge broke the gate. F-009: headcount alone is no proof, so no «only task → culprit» shortcut.
    if (input.live || attribution.strict) {
      // reported below
    } else if (!culprit && lastGreenCommit && tasksToCheck.length >= 1) {
      const currentHead = ran.head;
      if (currentHead && currentHead !== lastGreenCommit) {
        culprit = await bisectCulprit(host, configHostId, gateCommand, lastGreenCommit, currentHead, basePath, tasksToCheck);
      }
    }

    const preexistingNote = attribution.preexisting.length
      ? ` Были сломаны и раньше, не этой партией (падают и на базовом коммите): ${attribution.preexisting.map(testLabel).join(", ")}.`
      : "";

    // Reset this scope's counts for the next cycle; merges that landed during the run stay queued.
    this.consumePending(key, batch.length);
    finishGateRun(db, gateRunId, "failed", { head: activeHead ?? ran.head ?? null,
      reason: (failingTests.length ? failingTests.slice(0, 3).map(testLabel).join(", ") : `exit ${activeExitCode}`).slice(0, 300) });

    // An unhandled error outside any test fails the run with every test green; its block sits above the summary the log tail ends with.
    const unhandled = unhandledErrorBlock(`${activeStderr}\n${activeStdout}`);

    // Write log file
    const logRelativePath = `.agents/plans/items/${culprit ? culprit.taskId : "integration-gate"}/logs/integration-gate.log`;
    const logFullPath = join(basePath, logRelativePath);
    const logContent = `$ ${gateCommand}\nexit ${activeExitCode}\n\n${activeStdout}\n${activeStderr}`.trim() + "\n";

    await bestEffort(this.ctx.log, `gate log write ${logRelativePath}`, bb.sdk.files.write({
      hostId: configHostId,
      rootPath: basePath,
      path: logFullPath,
      content: logContent,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: null,
    }), undefined);

    if (culprit) {
      // The culprit's attempt is accepted and its worktree gone: a message into its old writer thread had no loop waiting for the turn, so
      // nobody verified or merged the fix (Gemini F-013). The repair is a task of its own, dispatched to the run's PM queue like a post-merge
      // mainfix (finish.ts postMergeRepair); a sticky writer of the area may still take it in the same thread. One that cannot be dispatched
      // (the run closed, a repair of a repair) is a row on the owner's list, never a lost message.
      const prompt = formatFixTurnPrompt({
        taskId: culprit.taskId,
        gateCommand,
        exitCode: activeExitCode,
        stdout: activeStdout,
        stderr: activeStderr,
        logPath: logRelativePath,
        ...(attribution.strict ? { failingTests: attribution.remaining.map(testLabel), preexistingTests: attribution.preexisting.map(testLabel) } : {}),
        unhandled,
      });
      const dispatched = await this.dispatchRepair(input, culprit.taskId, gateCommand, prompt, logRelativePath);
      if (dispatched) {
        this.ctx.log(`integration-gate: ${label} failed, traced to ${culprit.taskId}; repair task ${dispatched} dispatched.${preexistingNote} Full log: ${logRelativePath}`);
      } else {
        this.noteRed({ runId, projectId }, this.enterEpisode(runId, gateCommand, [culprit.taskId]), "gate_red", `После слияния задачи ${culprit.taskId} общая проверка проекта красная`,
          `Проверка «${gateCommand}» упала после слияния партии, и виновата задача ${culprit.taskId}.${preexistingNote} Задачу починки создать не удалось (запуск закрыт или это уже починка починки): поручите исправление в чате проекта.`, logRelativePath);
      }
      return { ran: true, passed: false, culpritTaskId: culprit.taskId };
    }

    // No culprit: a fact for the log and the owner's list, once per red-gate episode; nobody is asked anything.
    const tasks = tasksToCheck.map((task) => task.taskId).join(", ");
    const allPreexisting = attribution.strict && failingTests.length > 0 && attribution.remaining.length === 0;
    const why = !failingTests.length && unhandled
      ? `Проверка завершилась с кодом ${activeExitCode}, но ни один тест не назван упавшим: ошибка случилась вне тестов (сами тесты могут быть зелёными): ${unhandled}.${preexistingNote}`
      : input.live
      ? `В этой папке нет git, поэтому виноватого искать негде${tasks ? ` (задачи с прошлой проверки: ${tasks})` : ""}.`
      : allPreexisting
        ? `Все ${failingTests.length} упавших тестов падают и на базе до этой партии (были сломаны раньше), поэтому ни одна слитая задача не виновата.`
        : attribution.strict && attribution.candidates.length === 0
          ? `Ни одна задача этой партии не трогала упавшие тесты или их папки, поэтому виноватых среди них нет.${preexistingNote}`
          : `Виноватого однозначно не определить.${preexistingNote}`;
    const timeoutNote = repeatedTimeouts ? " (дважды не уложились во время, в том числе при перепроверке)" : "";
    const failingList = failingTests.length ? ` Упавшие тесты${timeoutNote}: ${failingTests.map(testLabel).join(", ")}.` : "";
    const cacheSuffix = cacheNote ? ` ${cacheNote}` : "";
    if (allPreexisting) {
      // Every failing test is red on the base too, so no merged task is guilty: this is not the owner's decision, it is work a
      // decides lead can pick up itself. One branch on the lead's road tree (class next_step), the log keeps the rest; no owner row.
      this.ctx.log(`integration-gate: ${label} red, all ${failingTests.length} failing tests fail on the base too; filed to the lead's road for ${projectId}. Full log: ${logRelativePath}`);
      this.fileWithLead({ runId, projectId }, failingTests, logRelativePath);
    } else {
      this.noteRed({ runId, projectId }, this.enterEpisode(runId, gateCommand, failingFiles), "gate_red",
        `Проверка после слияния (${label}) не прошла (код ${activeExitCode}).${failingList}`, `${why}${cacheSuffix} Полный лог: ${logRelativePath}`, logRelativePath);
    }

    return { ran: true, passed: false, culpritTaskId: null };
  }

  /**
   * A red gate with no writer to fix it is a fact for the log and the owner's list, never a message into the PM chat: the gate runs
   * after the batch's last merge, when the run is often accepted and its PM done (2026-10-31: a gate note woke a finished PM two
   * hours later; the owner wants no event of the plugin's own in that chat, and since 2026-10-09 no question «what should the PM
   * do?» either). One row per red-gate episode: the same red again changes nothing.
   */
  /**
   * The repair task of a red gate traced to one merged task: that task's contract with the gate's command as its check and the fix turn as
   * its objective, dispatched to the run's PM queue (the same «x-mainfix» id the post-merge check uses, so the redispatch and validation rules
   * of a repair apply). Returns the task id, or null when nothing could be dispatched: no contract, no PM chat, a refused dispatch, or a
   * culprit that is itself a repair (main red again after a repair is a person's to read, as checkMainAfterMerge holds).
   */
  private async dispatchRepair(input: { runId: string; projectId: string; pmThreadId: string }, taskId: string, gateCommand: string, prompt: string, logPath: string): Promise<string | null> {
    if (isMainfixTask(taskId) || !input.pmThreadId) return null;
    const contract = getTask(this.ctx.db as never, taskId)?.contract as TaskV2 | undefined;
    if (!contract || typeof contract !== "object") return null;
    const fix: TaskV2 = { ...contract, id: `${taskId}-mainfix`.slice(0, 128), title: `Make main green after ${taskId}`.slice(0, 200),
      display_title: `Починка main после ${taskId}`.slice(0, 60), kind: "fix", area: contract.area ?? "maintenance", depends_on: [],
      risk: contract.risk === "low" ? "medium" : contract.risk, expected_outputs: [gateCommand], objective: prompt,
      // Each of the culprit's items whole: one string cut at 600 characters left a requirement broken mid-word and the plan critic blocked it.
      acceptance: [`\`${gateCommand}\` passes on main`, ...(contract.acceptance ?? []).map((item) => `${taskId}'s acceptance still holds: ${item}`)] };
    const plan = `Integration gate repair, dispatched by Lane Pilot. Full gate log: ${logPath}. Read the failure, find what ${taskId} clashes with on main, fix within owns_paths, run \`${gateCommand}\`.`;
    try {
      const result = await this.services.dispatchWriter({ threadId: input.pmThreadId, projectId: input.projectId, task: fix, plan });
      const rejected = (result as { ok?: unknown }).ok === false || (result as { state?: unknown }).state === "rejected";
      return rejected ? null : (stringAt(result, "taskId") ?? fix.id);
    } catch (cause) {
      this.ctx.log(`integration-gate: repair of ${taskId} not dispatched: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  /**
   * A red the batch did not cause (every failing test is red on the base) becomes a branch of the lead's road tree, class
   * next_step: «fix the pre-existing red test X in project P». A decides tier of the next tick acts on it without the owner;
   * a proposes tier still puts it to him as a proposal, which is the right place for it — not a bare «nobody is guilty» row.
   * One branch per (project, first failing tests): an open, proposed or already-deciding twin is enough.
   */
  private fileWithLead(input: { runId: string; projectId: string }, tests: FailingTest[], logPath?: string): void {
    try {
      const db = this.ctx.db as never as Parameters<LeadRoadApi["listRoad"]>[0];
      const names = tests.map(testLabel).slice(0, 3).join(", ");
      const title = `Починить ранее красный тест: ${names} (проект ${input.projectId})`.slice(0, 300);
      const alive = this.services.leadRoad.listRoad(db, { projectId: input.projectId, state: ["open", "later", "proposed"], limit: 500 });
      if (alive.some((row) => row.title === title)) return;
      const rootId = `dir:${input.projectId}`;
      const root = this.services.leadRoad.getRoad(db, rootId) ?? this.services.leadRoad.addRoad(db, { id: rootId, projectId: input.projectId, title: `${input.projectId}: directions`, kind: "direction", source: "lead", why: "the root the lead files a project's branches under when a proposal names no parent" });
      this.services.leadRoad.addRoad(db, {
        parentId: root.id, projectId: input.projectId, title, kind: "option", source: "lead", class: "next_step",
        why: `Общая проверка после слияния красная, но все упавшие тесты падают и на базе до этой партии: ни одна слитая задача не виновата. Это работа, а не решение владельца: починить тест, который был сломан раньше.`,
        evidence: [
          { kind: "run", ref: input.runId, label: "красная проверка" },
          ...(logPath ? [{ kind: "file" as const, ref: logPath, label: "полный лог" }] : []),
          ...tests.slice(0, 5).map((test) => ({ kind: "note" as const, ref: testLabel(test).slice(0, 500), label: "упавший тест" })),
        ],
        costEstimate: "one fix",
      });
    } catch (cause) {
      this.ctx.log(`integration-gate: the pre-existing red was not filed to the lead's road: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private noteRed(input: { runId: string; projectId: string }, episode: GateEpisode, kind: string, what: string, why: string, logPath?: string): void {
    this.ctx.log(`integration-gate: ${stripAnsi(what)} ${stripAnsi(why)}`);
    postOwnerItem(this.ctx.db as never, {
      key: `gate-red:${input.runId}:${episode.startedAt}`, source: "integration-gate", kind, projectId: input.projectId, wake: false,
      what: stripAnsi(what), why: stripAnsi(why),
      evidence: [{ kind: "run", ref: input.runId }, ...(logPath ? [{ kind: "file" as const, ref: logPath }] : [])],
    });
  }

  /** A red run belongs to the run's current episode, or starts a new one (the owner's list has one row per episode). */
  private enterEpisode(runId: string, command: string, files: string[]): GateEpisode {
    const known = this.episodes.get(runId);
    if (known && continuesEpisode(known, command, files)) {
      known.files = [...new Set([...known.files, ...files])];
      return known;
    }
    const episode: GateEpisode = { command, files: [...files], startedAt: Date.now() };
    this.episodes.set(runId, episode);
    return episode;
  }
}


