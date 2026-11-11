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
import { attributeFailures, testLabel } from "./gate-attribution";
import { cacheHitsNote, extractCacheHits, extractFailingFiles, extractFailingTests, unhandledErrorBlock } from "../gate-output";
import { flakyEvidence, outputTail, readingFrom } from "../machine-pressure";
import type { GateAttributeResult } from "../integration-gate-host";
import { join } from "node:path";

import type { DispatchWriter } from "../../platform/server";
import { bisectCulprit, findCulpritByFiles, type MergedTaskInfo, type ProjectFileReader } from "./gate-culprit";
import { formatFixTurnPrompt } from "./gate-fix-prompt";
import { allFailuresAreTimeouts, buildRecheckGateCommand } from "./gate-timeouts";
import { dispatchRepair } from "./gate-repair";
import { enterEpisode, fileWithLead, noteRed } from "./gate-red-report";

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
      const dispatched = await dispatchRepair(this.ctx, this.services, input, culprit.taskId, gateCommand, prompt, logRelativePath);
      if (dispatched) {
        this.ctx.log(`integration-gate: ${label} failed, traced to ${culprit.taskId}; repair task ${dispatched} dispatched.${preexistingNote} Full log: ${logRelativePath}`);
      } else {
        noteRed(this.ctx, { runId, projectId }, enterEpisode(this.episodes, runId, gateCommand, [culprit.taskId]), "gate_red", `После слияния задачи ${culprit.taskId} общая проверка проекта красная`,
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
      fileWithLead(this.ctx, this.services, { runId, projectId }, failingTests, logRelativePath);
    } else {
      noteRed(this.ctx, { runId, projectId }, enterEpisode(this.episodes, runId, gateCommand, failingFiles), "gate_red",
        `Проверка после слияния (${label}) не прошла (код ${activeExitCode}).${failingList}`, `${why}${cacheSuffix} Полный лог: ${logRelativePath}`, logRelativePath);
    }

    return { ran: true, passed: false, culpritTaskId: null };
  }

}


