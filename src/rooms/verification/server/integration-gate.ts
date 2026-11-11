import { parseIntegrationGateSettings, type ResolvedGate } from "../../contracts/integration-gate";
import type { IntegrationGateSettings, GateWhen } from "../../contracts/integration-gate";
import type { TaskV2, PrototypeConfig } from "../../contracts";
import { finishGateRun, getRun, getRunSettingsScopes, getTaskContractJson, latestGateRun, latestGateRunForTask, listStageReceipts, listTaskIdsForRun, loadProjectSettings, noteGateRunStart, transitionAttempt } from "../../storage";
import { recordGateEvaluation } from "../../runs/server/stage-records";
import { bestEffort, stringAt } from "@lane-pilot/kit";
import type { ServerCore } from "../../contracts/server";

import { isEnvironmentCheckFailure } from "../../contracts/failure-class";
import { readCheckRun } from "../../tasks";
import { gateLabel, gateResolverFor } from "./gate-detect"
import type { GateEpisode } from "./gate-episode";
import { closeOwnerItemsByPrefix } from "../../owner-waiting";
import type { LeadRoadApi } from "../../contracts";
import { testLabel } from "./gate-attribution";
import { cacheHitsNote, extractCacheHits, extractFailingFiles, extractFailingTests } from "../gate-output";
import { flakyEvidence, outputTail, readingFrom } from "../machine-pressure";

import type { DispatchWriter } from "../../platform/server";
import type { MergedTaskInfo, ProjectFileReader } from "./gate-culprit";
import { allFailuresAreTimeouts, buildRecheckGateCommand } from "./gate-timeouts";
import { enterEpisode, noteRed, reportRed } from "./gate-red-report";

export { gateRunVerdict } from "./gate-run-verdict";
export { bisectCulprit, extractStaticImports, findCulpritByFiles, isFileRelatedToTask, type MergedTaskInfo, type ProjectFileReader } from "./gate-culprit";
export { formatFixTurnPrompt } from "./gate-fix-prompt";
export { allFailuresAreTimeouts, buildRecheckGateCommand } from "./gate-timeouts";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
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
      noteRed(this.ctx, { runId, projectId }, enterEpisode(this.episodes, runId, gateCommand, ["(no test ran)"]), "gate_no_test",
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
      noteRed(this.ctx, { runId, projectId }, enterEpisode(this.episodes, runId, gateCommand, ["(environment)"]), "gate_machine",
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

    return reportRed({ ctx: this.ctx, services: this.services, episodes: this.episodes, consumePending: (k, n) => this.consumePending(k, n) }, { input, key, gateCommand, label, readProjectFile, batch, lastGreenCommit, gateRunId, ran, failingTests, activeExitCode, activeStdout, activeStderr, activeHead, repeatedTimeouts, cacheNote });
  }

}


