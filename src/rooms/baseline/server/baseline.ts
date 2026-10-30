import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { getRunSettingsScopes, listCheckDurations, noteToldPmDirectly, taskBasePath } from "../../storage";
import type { RollbackApi, RollbackTarget } from "../../rollback/server";
import type { ServerCore, Services } from "../../core/server";
import {
  baselineSummary, baselineVerdict, CHECK_NOTE_TAIL, estimateSec, parseBaselineSettings, planChecks, RED_OUTSIDE_KINDS, redBeforeAndAfter, redOutsideMessage, redOutsideTaskFiles,
  closesWhenAlreadyGreen, requiresRedOnBase, turnedRed, unrunnableMessage, unrunnableReason, vacuousChecks, vacuousMessage,
  type BaselineCheck, type BaselineSettings,
} from "../logic";
import { cachedChecks, checkKey, getBaseline, insertBaseline, listBaselines, setBaselineAfter, type BaselineRecord } from "../store";

/**
 * The baseline before a writer (SMA atlas delta D1-3: «what was red before», «already built?», «what turned red»).
 *
 * Before the first attempt of a task starts, its verification[] runs on the base the attempt will start from, in a throwaway worktree of
 * that commit, with the same runner the acceptance uses (the host sandbox). Which checks were green and which red is written down. When
 * every check already passes, the task may be done already: in `notify` mode (the default) the PM and the acceptance card say so and the
 * attempt goes on; in `stop` mode the attempt does not start and the PM gets the evidence. After the merge, the checks that were green on
 * the base and are red on main are named («what turned red»).
 *
 * The cost is bounded: `baseline.time_cap_sec` (default 300, 0 turns the baseline off) is the sum of the checks' estimates, taken from
 * their own history; a check over it, or one that carries secrets, is skipped and says so; an answer already known for the same base and
 * command is reused; one baseline at a time per project. Nothing here can fail a task: any trouble is a record and the attempt starts.
 */

export type BaselineInput = {
  projectId: string; runId: string; taskId: string; attemptId: string; pmThreadId: string;
  config: PrototypeConfig; task: TaskV2;
};

const tail = (text: string) => text.trim().slice(-CHECK_NOTE_TAIL);

export function createBaseline(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;
  const log = (line: string) => ctx.log(line);
  const kitOf = (): RollbackApi["kit"] => (services.rollback as RollbackApi).kit;

  async function settingsOf(projectId: string, runId: string): Promise<BaselineSettings> {
    const values = (await ctx.effectiveProjectSettings(projectId, getRunSettingsScopes(db, runId)).catch(() => ({ values: {} as Record<string, unknown> }))).values;
    return parseBaselineSettings(values);
  }

  /** The commit the base checkout stands on, from the project's host; null for a folder without git. */
  async function headOf(hostId: string, basePath: string): Promise<string | null> {
    const base = await host.call("gitOwnershipBase", { requestedHostId: hostId, projectCwd: basePath }, { hostId, timeoutMs: 30_000 }).catch(() => null);
    return base?.status === "ready" ? base.headSha : null;
  }

  const record = (input: BaselineInput, row: Pick<BaselineRecord, "baseSha" | "state" | "verdict" | "mode" | "action" | "summary" | "checks" | "durationMs">): BaselineRecord["id"] | null => {
    try {
      return insertBaseline(db, { projectId: input.projectId, runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, ...row });
    } catch (cause) {
      log(`baseline record of ${input.taskId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  };

  /**
   * Runs the baseline of a task about to start and says whether the attempt may. Never throws; `stop` is the reason the attempt ends with
   * (a block verdict, so the task goes to the PM and is not redone as it is). `alreadyDone` means every check is already green on a
   * `fix` or `check`: the attempt closes accepted and no writer starts. Any other kind with the same result still blocks.
   */
  async function preflight(input: BaselineInput): Promise<{ stop: string | null; record: BaselineRecord | null; alreadyDone?: string }> {
    const started = Date.now();
    try {
      const settings = await settingsOf(input.projectId, input.runId);
      if (settings.timeCapSec === 0 || !input.task.verification.length) return { stop: null, record: null };
      // The same task started again after a reload keeps its first answer; a task the PM sent again with other checks, or one this gate
      // stopped, is asked again (the answers of the base are cached, so only a new command costs a run).
      const earlier = getBaseline(db, input.runId, input.taskId);
      const sameChecks = earlier && earlier.checks.length === input.task.verification.length && earlier.checks.every((check, index) => check.command === input.task.verification[index]!.command);
      if (earlier && sameChecks && earlier.action !== "stopped") {
        if (earlier.summary.startsWith("already done:")) return { stop: null, alreadyDone: earlier.summary, record: earlier };
        return { stop: null, record: null };
      }
      const basePath = taskBasePath(db, input.runId, input.taskId) ?? input.task.project_cwd;
      const hostId = input.config.hostId;
      const skipped = (reason: string, baseSha: string | null = null): { stop: null; record: BaselineRecord | null } => {
        const checks: BaselineCheck[] = input.task.verification.map((item) => ({ command: item.command, cwd: item.cwd, status: "skipped", exitCode: null, note: reason }));
        record(input, { baseSha, state: "skipped", verdict: "unknown", mode: settings.mode, action: "proceed", summary: `baseline skipped: ${reason}`, checks, durationMs: Date.now() - started });
        return { stop: null, record: getBaseline(db, input.runId, input.taskId) ?? null };
      };
      const baseSha = await headOf(hostId, basePath);
      if (!baseSha) return skipped("the project folder is not a git checkout, so there is no base to run on");

      const cache = cachedChecks(db, input.projectId, baseSha);
      const plan = planChecks(input.task.verification,
        (item) => estimateSec(listCheckDurations(db, input.projectId, { command: item.command, cwd: item.cwd, root: input.task.project_cwd }), item.timeout_sec ?? 120),
        { totalCapSec: settings.timeCapSec, perCheckCapSec: settings.timeCapSec, free: (item) => cache.has(checkKey(item.command, item.cwd)) });

      const checks: BaselineCheck[] = plan.map((entry) => {
        const cached = cache.get(checkKey(entry.item.command, entry.item.cwd));
        if (cached) return { ...cached, cached: true as const };
        if (entry.skip) return { command: entry.item.command, cwd: entry.item.cwd, status: "skipped" as const, exitCode: null, note: entry.skip };
        return { command: entry.item.command, cwd: entry.item.cwd, status: "unknown" as const, exitCode: null, note: "not run" };
      });
      const toRun = plan.filter((entry, index) => !entry.skip && !checks[index]!.cached);

      let ranFor = 0;
      if (toRun.length) {
        const target: RollbackTarget = { taskId: input.taskId, task: input.task, runId: input.runId, projectId: input.projectId, hostId, basePath, config: input.config };
        const kit = kitOf();
        const work = (async () => {
          // One baseline at a time per project: each makes a worktree and may link its dependencies.
          const release = await services.runWriterPool.acquire(`baseline:${input.projectId}`, 1);
          let path: string | null = null;
          try {
            const made = await kit.makeWorktree(target, `baseline-${input.taskId}-${Date.now().toString(36)}`, baseSha);
            if ("error" in made) { for (const entry of toRun) mark(checks, plan, entry.item.command, { status: "unknown", note: made.error }); return; }
            path = made.path;
            const ran = await kit.runChecks(target, made.path, toRun.map((entry) => ({ ...entry.item, timeout_sec: Math.min(entry.item.timeout_sec ?? 120, settings.timeCapSec) })));
            for (const row of ran) {
              mark(checks, plan, row.command, row.hostError ? { status: "unknown", note: `the host could not run it: ${row.tail}` }
                : { status: row.ok ? "green" : "red", exitCode: row.exitCode, note: row.ok ? "" : tail(row.tail) });
            }
            ranFor = ran.length;
          } catch (cause) {
            // The answer is «unknown» for what did not run; the attempt starts all the same.
            for (const entry of toRun) mark(checks, plan, entry.item.command, { status: "unknown", note: cause instanceof Error ? cause.message : String(cause) });
          } finally {
            release();
            await kit.dropWorktree(target, path);
          }
        })();
        // The wait is bounded; a run that outlives it finishes (and removes its worktree) on its own, and the attempt starts without an answer.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<"late">((resolveLate) => { timer = setTimeout(() => resolveLate("late"), (settings.timeCapSec * 2 + 60) * 1000); });
        const outcome = await Promise.race([work.then(() => "done" as const), limit]);
        clearTimeout(timer);
        if (outcome === "late") {
          work.catch(() => undefined);
          for (const entry of toRun) mark(checks, plan, entry.item.command, { status: "unknown", note: `the baseline did not finish within ${settings.timeCapSec * 2 + 60}s` });
        } else await work;
      }

      const verdict = baselineVerdict(checks);
      // A check the base itself shows cannot run (exit 127, a missing tool or folder), or one that is red in files the task does not own:
      // the writer would only ask the owner about it after a paid start (120 attempts ended that way). The PM fixes the contract first.
      const unrunnable = checks.flatMap((check) => { const why = unrunnableReason(check, input.task); return why ? [{ check, why }] : []; });
      const outside = unrunnable.length || !RED_OUTSIDE_KINDS.includes(input.task.kind ?? "") ? []
        : checks.flatMap((check) => { const files = redOutsideTaskFiles(check, input.task); return files.length ? [{ check, files }] : []; });
      if (unrunnable.length || outside.length) {
        const code = unrunnable.length ? "check_cannot_run" : "red_outside_task";
        const detail = unrunnable.length ? unrunnable.map((item) => `${item.check.command}: ${item.why}`).join("; ")
          : outside.map((item) => `${item.check.command}: red in ${item.files.join(", ")}`).join("; ");
        const summary = `${baselineSummary(verdict, checks, baseSha)}; ${code}`;
        record(input, { baseSha, state: "ran", verdict, mode: settings.mode, action: "stopped", summary, checks, durationMs: Date.now() - started });
        log(`baseline ${input.taskId}: ${summary} (${detail}); the attempt does not start`);
        const text = unrunnable.length ? unrunnableMessage(input.taskId, unrunnable, baseSha) : redOutsideMessage(input.taskId, outside, baseSha);
        if (input.pmThreadId) {
          noteToldPmDirectly(input.pmThreadId, input.taskId);
          await bb.sdk.threads.send({ threadId: input.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text: `Lane Pilot: задача ${input.taskId} не запущена: ${text}`, mentions: [] }] } as never).catch(() => undefined);
        }
        return { stop: `verdict_block: ${code}: ${detail.slice(0, 600)}. ${unrunnable.length ? "Fix the command or cwd, or drop the check" : "Narrow the check to the task's files or widen owns_paths"}; nothing was started and no attempt was spent`, record: getBaseline(db, input.runId, input.taskId) ?? null };
      }
      // Red before green. An all-green fix or check is the failure no longer reproducing: close accepted. Any other kind
      // whose checks are all green still blocks: those checks do not tell done from not done. A fix whose only red checks
      // are existence tests (`test -f` of a file that is not there yet) still blocks: that work is not done.
      const allGreen = checks.length > 0 && checks.every((check) => check.status === "green");
      if (allGreen && closesWhenAlreadyGreen(settings.requireRed, input.task)) {
        const summary = `already done: ${baselineSummary(verdict, checks, baseSha)}`;
        record(input, { baseSha, state: "ran", verdict, mode: settings.mode, action: "notified", summary, checks, durationMs: Date.now() - started });
        log(`baseline ${input.taskId}: ${summary}; closing accepted without a writer`);
        await tellPmAlreadyDone(input, checks, baseSha);
        return { stop: null, alreadyDone: summary, record: getBaseline(db, input.runId, input.taskId) ?? null };
      }
      const vacuous = requiresRedOnBase(settings.requireRed, input.task) ? vacuousChecks(checks, { behaviour: input.task.kind === "fix" }) : [];
      if (vacuous.length) {
        const summary = `${baselineSummary(verdict, checks, baseSha)}; no check is red on the base (checks.require_red_on_base=${settings.requireRed}, risk ${input.task.risk})`;
        record(input, { baseSha, state: "ran", verdict, mode: settings.mode, action: "stopped", summary, checks, durationMs: Date.now() - started });
        log(`baseline ${input.taskId}: ${summary}; the attempt does not start`);
        const proveNothing = "проверки уже зелёные — они не отличают сделанное от несделанного; добавь проверку, которая сейчас красная";
        if (allGreen) await tellPmGreenProvesNothing(input, checks, proveNothing);
        else await tellPmVacuous(input, vacuous, baseSha);
        const why = allGreen ? `${proveNothing}. Nothing was started`
          : `Every check of ${input.taskId} passes before any writer, so none can fail when the work is missing; add a check that is red now and nothing was started`;
        return { stop: `verdict_block: no_red_on_base: ${summary}. ${why}`, record: getBaseline(db, input.runId, input.taskId) ?? null };
      }
      const stop = verdict === "already_built" && settings.mode === "stop";
      const action = verdict === "already_built" ? (stop ? "stopped" : "notified") : "proceed";
      const summary = baselineSummary(verdict, checks, baseSha);
      const id = record(input, { baseSha, state: "ran", verdict, mode: settings.mode, action, summary, checks, durationMs: Date.now() - started });
      log(`baseline ${input.taskId}: ${summary}${ranFor ? ` (${ranFor} run, ${Math.round((Date.now() - started) / 1000)}s)` : " (answered from earlier baselines)"}`);
      const saved = id ? getBaseline(db, input.runId, input.taskId) ?? null : null;
      if (verdict === "already_built") await tellPm(input, checks, baseSha, stop);
      return { stop: stop ? `verdict_block: baseline already_built: ${summary}. The checks of ${input.taskId} are green on the base before any writer; nothing was started (baseline.already_built=stop)` : null, record: saved };
    } catch (cause) {
      log(`baseline of ${input.taskId} failed, the attempt starts without it: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { stop: null, record: null };
    }
  }

  function mark(checks: BaselineCheck[], plan: ReadonlyArray<{ item: { command: string } }>, command: string, patch: Partial<BaselineCheck>): void {
    plan.forEach((entry, index) => { if (entry.item.command === command && !checks[index]!.cached) checks[index] = { ...checks[index]!, ...patch }; });
  }

  async function tellPm(input: BaselineInput, checks: BaselineCheck[], baseSha: string | null, stopped: boolean): Promise<void> {
    if (!input.pmThreadId) return;
    const list = checks.map((check) => `- ${check.command} (${check.cached ? "известно по прошлой проверке этой базы" : "запущена сейчас"})`).join("\n");
    const fact = `все ${checks.length} проверок(и) задачи ${input.taskId} уже проходят на базе${baseSha ? ` ${baseSha.slice(0, 10)}` : ""}, до писателя`;
    const text = stopped
      ? `Lane Pilot: задача ${input.taskId} не запущена: ${fact} (baseline.already_built=stop).\n${list}\nЕсли задача действительно не нужна, ничего делать не надо. Если проверки слабые и работа не сделана, усильте acceptance/verification и отправьте задачу снова.`
      : `Lane Pilot: ${fact}: задача, возможно, уже сделана. Писатель всё равно стартует (baseline.already_built=notify); карточка приёмки покажет эти проверки.\n${list}\nЕсли работа уже сделана, остановите задачу (lane_pilot_cancel); если проверки слабые, усильте их.`;
    if (stopped) noteToldPmDirectly(input.pmThreadId, input.taskId);
    await bb.sdk.threads.send({ threadId: input.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).catch(() => undefined);
  }

  async function tellPmAlreadyDone(input: BaselineInput, checks: BaselineCheck[], baseSha: string | null): Promise<void> {
    if (!input.pmThreadId) return;
    const list = checks.map((check) => `- ${check.command}`).join("\n");
    const text = `Lane Pilot: задача ${input.taskId} закрыта принятой без писателя — все ${checks.length} проверок(и) уже зелёные на базе${baseSha ? ` ${baseSha.slice(0, 10)}` : ""}, до писателя.\n${list}\nЕсли баг на самом деле не исправлен, переоткрой задачу с проверкой, которая его воспроизводит.`;
    noteToldPmDirectly(input.pmThreadId, input.taskId);
    await bb.sdk.threads.send({ threadId: input.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).catch(() => undefined);
  }

  async function tellPmGreenProvesNothing(input: BaselineInput, checks: BaselineCheck[], sentence: string): Promise<void> {
    if (!input.pmThreadId) return;
    const list = checks.map((check) => `- ${check.command}`).join("\n");
    noteToldPmDirectly(input.pmThreadId, input.taskId);
    await bb.sdk.threads.send({ threadId: input.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text: `Lane Pilot: задача ${input.taskId} не запущена: ${sentence}.\n${list}`, mentions: [] }] } as never).catch(() => undefined);
  }

  async function tellPmVacuous(input: BaselineInput, vacuous: BaselineCheck[], baseSha: string | null): Promise<void> {
    if (!input.pmThreadId) return;
    const text = `Lane Pilot: задача ${input.taskId} не запущена: ${vacuousMessage(input.taskId, vacuous, input.task.risk, baseSha, input.task.kind)}`;
    noteToldPmDirectly(input.pmThreadId, input.taskId);
    await bb.sdk.threads.send({ threadId: input.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).catch(() => undefined);
  }

  /**
   * «What turned red»: after the merge the task's checks ran on main. Those that were green on the base and are red now are recorded on the
   * baseline row and returned. Never throws; nothing is returned for a task with no baseline.
   */
  function afterMerge(input: { runId: string; taskId: string; mergeCommit?: string | undefined; checks: ReadonlyArray<{ command: string; exitCode: number; hostError?: true | undefined }> }): string[] {
    try {
      const row = getBaseline(db, input.runId, input.taskId);
      if (!row || row.state !== "ran") return [];
      const red = turnedRed(row.checks, input.checks);
      setBaselineAfter(db, row.id, { at: Date.now(), mergeCommit: input.mergeCommit ?? null, turnedRed: red, checked: input.checks.length });
      if (red.length) log(`baseline ${input.taskId}: green on the base and red on main after the change: ${red.join(", ")}`);
      return red;
    } catch (cause) {
      log(`baseline difference of ${input.taskId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`);
      return [];
    }
  }

  /** Of the red checks on main, those that were red on the base before the task too. Nothing is returned for a task with no baseline. */
  function redBefore(input: { runId: string; taskId: string; checks: ReadonlyArray<{ command: string; exitCode: number; hostError?: true | undefined }> }): string[] {
    try {
      const row = getBaseline(db, input.runId, input.taskId);
      return !row || row.state !== "ran" ? [] : redBeforeAndAfter(row.checks, input.checks);
    } catch { return []; }
  }

  /** What is on record for a task: every baseline it started with and what turned red after its merge. */
  const status = (taskId: string) => listBaselines(db, taskId);

  return { baseline: { preflight, afterMerge, redBefore, status } };
}

export type BaselineApi = ReturnType<typeof createBaseline>["baseline"];
