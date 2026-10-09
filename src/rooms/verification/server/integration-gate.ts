import type { TaskV2, PrototypeConfig } from "../../contracts";
import type { LanePilotDatabase, StageReceiptRow } from "../../storage";
import { getRun, getRunSettingsScopes, getTask, listStageReceipts, loadProjectSettings, transitionAttempt } from "../../storage";
import { recordGateEvaluation } from "../../runs/server/stage-records";
import { stringAt } from "../../core/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { saveFollowUp } from "../../writer/server/sticky";
import { sendServiceMessage } from "../../relay/server";
import { isEnvironmentCheckFailure } from "../../runs";
import { gateLabel, gateResolverFor, type ResolvedGate } from "./gate-detect";
import { continuesEpisode, fixesInFlight, type GateEpisode } from "./gate-episode";
import { join } from "node:path";

export type GateWhen = "queue_drained" | "every_n";

export type IntegrationGateSettings = {
  /** The explicit command; null when empty (the gate is then detected) or `off`. */
  gateCommand: string | null;
  /** `integration.gate_command` is `off`: no gate for the project, detected or not. */
  gateOff: boolean;
  gateWhen: GateWhen;
  gateEvery: number;
};

export function parseIntegrationGateSettings(settings: Record<string, unknown>): IntegrationGateSettings {
  const rawCommand = typeof settings["integration.gate_command"] === "string" ? settings["integration.gate_command"].trim() : "";
  const gateOff = rawCommand.toLowerCase() === "off";
  const gateCommand = rawCommand && !gateOff ? rawCommand : null;
  const gateWhenRaw = settings["integration.gate_when"];
  const gateWhen: GateWhen = gateWhenRaw === "every_n" ? "every_n" : "queue_drained";
  const gateEveryRaw = Number(settings["integration.gate_every"]);
  const gateEvery = Number.isFinite(gateEveryRaw) && gateEveryRaw > 0 ? Math.floor(gateEveryRaw) : 5;
  return { gateCommand, gateOff, gateWhen, gateEvery };
}

export type FailingGateCheck = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failedFiles: string[];
};

export function extractFailingFiles(output: string): string[] {
  const files = new Set<string>();
  // Match test failure headers or tsc errors:
  // e.g. FAIL tests/integration-gate.test.ts, ❯ tests/foo.test.ts:12:3
  // src/file.ts:14:5 - error TS...
  // (tests/foo.test.ts)
  const lines = output.split("\n");
  for (const line of lines) {
    const tscMatch = line.match(/^([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+)\s+-\s+error/);
    if (tscMatch && tscMatch[1]) {
      files.add(tscMatch[1].trim());
      continue;
    }
    const vitestFail = line.match(/(?:FAIL|✕|❯)\s+([a-zA-Z0-9_./-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))/);
    if (vitestFail && vitestFail[1]) {
      files.add(vitestFail[1].trim());
      continue;
    }
    const fileWithExt = line.match(/\b([a-zA-Z0-9_./-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))\b/);
    if (fileWithExt && fileWithExt[1]) {
      files.add(fileWithExt[1].trim());
      continue;
    }
  }
  return [...files];
}

export type MergedTaskInfo = {
  taskId: string;
  commitSha: string;
  threadId: string | null;
  attemptId: string | null;
  produced: string[];
};

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
}): string {
  const tail = `${input.stderr}\n${input.stdout}`.trim().slice(-800);
  return `Result: integration gate failed after merging your task ${input.taskId}.
Full check log: ${input.logPath}

→ The integration gate command \`${input.gateCommand}\` exited with code ${input.exitCode}.
→ Output tail:
${tail}

Make this pass on main. Change only what your task requires within owns_paths.`;
}

export class IntegrationGateRunner {
  private inFlight = false;
  private mergesSinceLastGate = 0;
  private lastGreenCommit: string | null = null;
  private mergedTasksSinceLastGate: MergedTaskInfo[] = [];
  private drainWaiting: Parameters<IntegrationGateRunner["maybeRunGate"]>[0] | null = null;
  /** The red-gate episode of each run: the owner is asked once per episode, see `./gate-episode`. */
  private readonly episodes = new Map<string, GateEpisode>();

  constructor(
    private readonly ctx: ServerCore,
    private readonly services: Services
  ) {}

  noteMergedTask(task: MergedTaskInfo) {
    this.mergesSinceLastGate += 1;
    this.mergedTasksSinceLastGate.push(task);
  }

  getPendingMergeCount(): number {
    return this.mergesSinceLastGate;
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
    const settings = loadProjectSettings(this.ctx.db, input.projectId, getRunSettingsScopes(this.ctx.db, input.runId));
    const gateSettings = parseIntegrationGateSettings(settings);
    const gate = await gateResolverFor(this.ctx)({ runId: input.runId, hostId: input.configHostId, basePath: input.basePath, gate: gateSettings });

    if (!gate) {
      return { ran: false };
    }

    if (input.trigger === "merge" && gateSettings.gateWhen === "every_n") {
      if (this.mergesSinceLastGate < gateSettings.gateEvery) {
        return { ran: false };
      }
    } else if (input.trigger === "merge" && gateSettings.gateWhen === "queue_drained") {
      return { ran: false };
    }

    // Don't run concurrently; a drain that came while one runs is the batch's gate, so it goes once this one is done.
    if (this.inFlight) {
      if (input.trigger === "drain") this.drainWaiting = input;
      return { ran: false };
    }

    this.inFlight = true;
    let result: { ran: boolean; passed?: boolean; culpritTaskId?: string | null } = { ran: false };
    try {
      result = await this.executeGate({ ...input, gate });
      return result;
    } finally {
      this.inFlight = false;
      const waiting = this.drainWaiting;
      this.drainWaiting = null;
      if (waiting && result.ran && this.mergesSinceLastGate > 0) void this.maybeRunGate(waiting).catch((cause: unknown) => this.ctx.log(`integration-gate: queued run failed: ${cause instanceof Error ? cause.message : String(cause)}`));
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
  }): Promise<{ ran: boolean; passed?: boolean; culpritTaskId?: string | null }> {
    const { runId, projectId, pmThreadId, basePath, configHostId, gate } = input;
    const gateCommand = gate.command;
    const label = gateLabel(gate);
    const db = this.ctx.db;
    const bb = this.ctx.bb;
    const host = this.ctx.host;
    // The gate, git and file reads run on the project's own host, never at the project's path on the hub.
    const GATE_TIMEOUT_SEC = 30 * 60;
    const readProjectFile: ProjectFileReader = async (relativePath) => {
      const read = await host.call("readBoundedFile", { requestedHostId: configHostId, projectCwd: basePath, relativePath, offset: 0, maxLines: 2000 }, { hostId: configHostId, timeoutMs: 30_000 })
        .catch(() => null);
      return read ? read.content : null;
    };

    // Record stage on the merged task if one exists in the database
    const lastMerged = this.mergedTasksSinceLastGate[this.mergedTasksSinceLastGate.length - 1];
    let runTaskId = lastMerged?.taskId;
    if (!runTaskId) {
      const existingTask = db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=? LIMIT 1").get(runId) as { id: string } | undefined;
      runTaskId = existingTask?.id ?? "integration-gate";
    }
    const hasTaskInDb = Boolean(db.prepare("SELECT 1 FROM lane_pilot_task WHERE id=?").get(runTaskId));

    this.ctx.log(`integration-gate: running \`${gateCommand}\` on ${basePath}`);

    const ran = await host.call("gateRun", { requestedHostId: configHostId, basePath, command: gateCommand, timeoutSec: GATE_TIMEOUT_SEC },
      { hostId: configHostId, timeoutMs: (GATE_TIMEOUT_SEC + 60) * 1000 }).catch((cause: unknown) => {
      this.ctx.log(`integration-gate: could not run \`${gateCommand}\` on host ${configHostId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    // A gate that could not run says nothing about main: no receipt, no culprit; the merges stay counted for the next run.
    if (!ran) return { ran: false };

    const exitCode = ran.exitCode;
    const stdout = ran.stdout;
    const stderr = ran.stderr;
    const passed = exitCode === 0;

    const receiptResult = {
      command: gateCommand,
      source: gate.source,
      detail: gate.detail,
      exitCode,
      passed,
      mergesChecked: this.mergesSinceLastGate,
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
      this.mergesSinceLastGate = 0;
      this.mergedTasksSinceLastGate = [];
      // Save the commit the gate ran on as the last green one
      if (ran.head) this.lastGreenCommit = ran.head;
      return { ran: true, passed: true };
    }

    // The machine broke the gate (root-owned files, a permission error before any test ran): no commit is to blame and no
    // writer can fix it in owns_paths, so no culprit, no bisect, no fix turn. The merges stay counted for the next run.
    if (isEnvironmentCheckFailure({ stdout, stderr })) {
      const evidence = `${stderr}\n${stdout}`.split("\n").find((line) => isEnvironmentCheckFailure({ stderr: line }))?.trim().slice(0, 300) ?? "";
      this.ctx.log(`infra: integration gate \`${gateCommand}\` is red from the environment, no culprit searched: ${evidence}`);
      const { episode, repeat } = this.enterEpisode(runId, gateCommand, ["(environment)"]);
      if (repeat) {
        await this.repeatRed(runId, pmThreadId, episode, [], `Lane Pilot: integration gate ${label} is still red because of the machine (${evidence}). The owner was already asked about this; fix it in ${basePath}, then the gate runs again.`);
        return { ran: true, passed: false, culpritTaskId: null };
      }
      await this.tellPm(pmThreadId, `Lane Pilot: integration gate ${label} is red because of the machine, not the code: ${evidence}. No culprit was searched and no fix turn was sent (a writer cannot fix file permissions). Fix it in ${basePath}, then the gate runs again.`, {
        question: `The integration gate \`${gateCommand}\` is red because of the machine, not the code. It needs a fix in ${basePath} that only you can make.`,
        detail: evidence,
        options: ["Fixed, run the gate again", "I will look later"],
      }, episode);
      return { ran: true, passed: false, culpritTaskId: null };
    }

    // Gate failed. Find culprit.
    const failingFiles = extractFailingFiles(`${stderr}\n${stdout}`);
    const tasksToCheck = [...this.mergedTasksSinceLastGate];

    // A folder without git has no commits to bisect and no merges to blame: the PM and the owner get the red result.
    let culprit = input.live ? null : await findCulpritByFiles(failingFiles, tasksToCheck, readProjectFile);

    // Fallback: git bisect if ambiguous and we have a lastGreenCommit and merged tasks
    if (input.live) {
      // reported below
    } else if (!culprit && this.lastGreenCommit && tasksToCheck.length > 1) {
      const currentHead = ran.head;
      if (currentHead && currentHead !== this.lastGreenCommit) {
        culprit = await bisectCulprit(host, configHostId, gateCommand, this.lastGreenCommit, currentHead, basePath, tasksToCheck);
      }
    } else if (!culprit && tasksToCheck.length === 1) {
      culprit = tasksToCheck[0]!;
    }

    // Reset counts for the next cycle
    this.mergesSinceLastGate = 0;
    this.mergedTasksSinceLastGate = [];

    // Write log file
    const logRelativePath = `.agents/plans/items/${culprit ? culprit.taskId : "integration-gate"}/logs/integration-gate.log`;
    const logFullPath = join(basePath, logRelativePath);
    const logContent = `$ ${gateCommand}\nexit ${exitCode}\n\n${stdout}\n${stderr}`.trim() + "\n";

    await bb.sdk.files.write({
      hostId: configHostId,
      rootPath: basePath,
      path: logFullPath,
      content: logContent,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: null,
    }).catch(() => undefined);

    if (culprit && culprit.threadId) {
      // Send fix turn into culprit writer thread (no new task id!)
      const prompt = formatFixTurnPrompt({
        taskId: culprit.taskId,
        gateCommand,
        exitCode,
        stdout,
        stderr,
        logPath: logRelativePath,
      });

      if (culprit.attemptId) {
        await saveFollowUp(bb.storage.kv, culprit.attemptId, Date.now());
      }

      await sendServiceMessage(bb, { threadId: culprit.threadId, text: prompt, senderThreadId: pmThreadId }).catch(() => undefined);

      await sendServiceMessage(bb, {
        threadId: pmThreadId,
        text: `Lane Pilot: integration gate ${label} failed. Traced to ${culprit.taskId}; sent fix turn to @thread:${culprit.threadId}. Full log: ${logRelativePath}`,
        senderThreadId: culprit.threadId,
      }).catch(() => undefined);

      return { ran: true, passed: false, culpritTaskId: culprit.taskId };
    }

    // Tell PM with log; the owner is asked what to do (a form in the PM chat and a push on the phone), once per red-gate episode.
    const tasks = tasksToCheck.map((task) => task.taskId).join(", ");
    const why = input.live
      ? `This folder has no git, so no culprit can be searched${tasks ? ` (tasks since the last gate: ${tasks})` : ""}.`
      : "Could not unambiguously identify culprit.";
    const failingList = failingFiles.length ? ` Failing tests: ${failingFiles.join(", ")}.` : "";
    const { episode, repeat } = this.enterEpisode(runId, gateCommand, failingFiles);
    if (repeat) {
      await this.repeatRed(runId, pmThreadId, episode, failingFiles, `Lane Pilot: integration gate ${label} is still red (exit ${exitCode}), the same failing tests as before.${failingList} The owner was already asked about this red gate and is not asked again until a gate run is green. Full log: ${logRelativePath}`, tasksToCheck.map((task) => task.taskId));
      return { ran: true, passed: false, culpritTaskId: null };
    }
    await this.tellPm(pmThreadId, `Lane Pilot: integration gate ${label} failed (exit ${exitCode}). ${why}${failingList} Full log: ${logRelativePath}`, {
      question: `The integration gate \`${gateCommand}\` is red and no single task is to blame. What should the PM do?`,
      detail: `Full log: ${logRelativePath}\n\n${`${stderr}\n${stdout}`.trim().slice(-1200)}`,
      options: ["Investigate and fix it", "Leave it, I will look myself"],
    }, episode);

    return { ran: true, passed: false, culpritTaskId: null };
  }

  /**
   * The PM gets the failure as a message. A failure only the owner can settle also opens a question form for the owner
   * (see `createOwnerAsk`); when it opened, the message says so and the answer arrives in the PM chat as a message, and
   * when it could not open (an older BB, another form already open) the message alone is the old behaviour.
   */
  private async tellPm(pmThreadId: string, text: string, ask: { question: string; detail: string; options: string[] }, episode?: GateEpisode): Promise<void> {
    const TIMEOUT_MS = 60 * 60_000;
    const asked = await this.ctx.ownerAsk?.askInBackground(pmThreadId, { source: "gate", ...ask },
      (answer) => {
        // One answer reaches the PM once: the episode keeps it from a second delivery.
        if (episode) { if (episode.answered) return; episode.answered = true; }
        return this.ctx.ownerAsk.sendToThread(pmThreadId, this.ctx.ownerAsk.answerMessage(ask.question, answer, TIMEOUT_MS));
      },
      { timeoutMs: TIMEOUT_MS }).catch(() => false);
    await this.ctx.bb.sdk.threads.send({
      threadId: pmThreadId,
      mode: "queue-if-active",
      input: [{ type: "text", text: asked ? `${text} The owner was asked what to do; the answer arrives in this chat.` : text, mentions: [] }],
    } as never).catch(() => undefined);
  }

  /**
   * A red run belongs to the run's current episode, or starts a new one. `repeat` is true when the episode is already known
   * (the owner was asked for it).
   */
  private enterEpisode(runId: string, command: string, files: string[]): { episode: GateEpisode; repeat: boolean } {
    const known = this.episodes.get(runId);
    if (known && continuesEpisode(known, command, files)) {
      known.files = [...new Set([...known.files, ...files])];
      return { episode: known, repeat: true };
    }
    const episode: GateEpisode = { command, files: [...files], startedAt: Date.now(), answered: false };
    this.episodes.set(runId, episode);
    return { episode, repeat: false };
  }

  /** The same red gate again: no owner question; the PM hears it only when no fix task for these tests is in flight. */
  private async repeatRed(runId: string, pmThreadId: string, episode: GateEpisode, files: string[], text: string, mergedTaskIds: string[] = []): Promise<void> {
    const fixing = fixesInFlight(this.ctx.db, runId, files.length ? files : episode.files, episode.startedAt, mergedTaskIds);
    if (fixing.length) {
      this.ctx.log(`integration-gate: still red, same episode; PM fix in flight (${fixing.join(", ")}), nobody told`);
      return;
    }
    await this.ctx.bb.sdk.threads.send({ threadId: pmThreadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).catch(() => undefined);
  }
}
