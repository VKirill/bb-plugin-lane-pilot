import { IntegrationGateRunner } from "../../verification/server";
import { gateResolverFor } from "../../verification/server";
import { getRunSettingsScopes, listOpenAttempts, loadProjectSettings } from "../../storage";
import { failureFingerprint, isEnvironmentCheckFailure } from "../../runs";
import { isMainfixTask } from "../../tasks";
import { readCheckRun } from "../../tasks/server";
import { postOwnerItem } from "../../owner-waiting";
import { isRunHalted } from "../../runs/server";
import { join, relative, resolve } from "node:path";
import type { TaskV2 } from "../../contracts";
import type { ServerCore, Services } from "../../core/server";

/**
 * MERGER: this file belongs to src/rooms/verification. Move it there and call
 * `mountVerificationAttemptFinished(ctx, services)` from that room's mount code instead of writer's.
 *
 * What a landed task leaves behind for verification: the project's integration gate hears the merge
 * (and runs once the project drains or every n merges), or — without a gate — the post-merge check
 * reruns the task's checks on main and dispatches a -mainfix repair task when they went red with it.
 * Both were `void`-launched inline after the merge; as a reaction they stay fire-and-forget.
 */
export function mountVerificationAttemptFinished(ctx: ServerCore, services: Services) {
  const { db } = ctx;
  const integrationGateRunner = new IntegrationGateRunner(ctx, services);

  /** The project's gate (explicit, detected on its host, or none). */
  const gateFor = (projectId: string, runId: string, hostId: string, basePath: string) =>
    gateResolverFor(ctx)({ runId, hostId, basePath, gate: parseGate(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))) });

  /**
   * A task landed (merged, or accepted in place in a folder with no repository): the batch gate counts it. The gate runs
   * once the project has no other open attempt; with `every_n` it also runs every n merges.
   */
  function noteMergedForGate(input: { projectId: string; runId: string; taskId: string; attemptId: string; writerThreadId: string | null; pmThreadId: string; config: { hostId: string } },
    basePath: string, commitSha: string, produced: string[], live: boolean) {
    integrationGateRunner.noteMergedTask({ taskId: input.taskId, commitSha, threadId: input.writerThreadId, attemptId: input.attemptId, produced },
      { projectId: input.projectId, hostId: input.config.hostId, basePath });
    const drained = !listOpenAttempts(db).some((row) => row.project_id === input.projectId && row.id !== input.attemptId);
    // Called without await: a throw here must never become an unhandled rejection, which kills the whole BB server.
    return integrationGateRunner.maybeRunGate({ runId: input.runId, projectId: input.projectId, pmThreadId: input.pmThreadId, basePath,
      configHostId: input.config.hostId, trigger: drained ? "drain" : "merge", ...(live ? { live: true } : {}) })
      .catch((cause: unknown) => { ctx.log(`integration-gate: failed after merging ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`); return { ran: false }; });
  }

  /**
   * The task's checks again on main once it is merged: green alone, two tasks can break main together (merge queues
   * test the merged result). The work stays merged — nothing is thrown away — and a follow-up task makes main green
   * on top of it, so an agent repairs it rather than the owner or the PM. A follow-up that breaks main again is
   * reported to the PM instead of chaining.
   */
  async function checkMainAfterMerge(input: { projectId: string; pmThreadId: string; config: Parameters<typeof services.runVerification>[0];
    runId: string; task: TaskV2; basePath: string; worktreePath: string;
    /** The merge this check follows: one merge commit of one attempt is one check, never another's. */ attemptId?: string; mergeCommit?: string;
    /** Checks this attempt ran green in its own worktree: red on the base, green there and red on main again is a clash of the merge. */ greenInWorktree?: readonly string[] }) {
    if (!input.task.verification.length || !input.pmThreadId || await isRunHalted(ctx.bb.storage.kv as never, input.runId)) return;
    const onBase = (cwd: string) => resolve(cwd).startsWith(resolve(input.worktreePath)) ? join(input.basePath, relative(input.worktreePath, cwd)) : cwd;
    const onMain = { ...input.task, project_cwd: input.basePath, verification: input.task.verification.map((command) => ({ ...command, cwd: onBase(command.cwd) })) };
    const checks = await services.runVerification(input.config, onMain, input.runId, undefined, { background: true, jobKey: `post-merge:${input.attemptId ?? input.task.id}:${input.mergeCommit ?? ""}` }).catch((cause: unknown) => {
      ctx.log(`post-merge check of ${input.task.id} could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    // A check whose host call failed says nothing about main: read as red, it dispatched a mainfix for a green main.
    const unrun = checks?.filter((check) => check.hostError) ?? [];
    if (unrun.length) ctx.log(`post-merge check of ${input.task.id} could not run on the host: ${unrun.map((check) => `${check.command} (${check.stderr.slice(0, 160)})`).join(", ")}`);
    const failing = checks?.filter((check) => check.exitCode !== 0 && !check.hostError) ?? [];
    // «What turned red» (src/rooms/baseline): the checks that were green on the base before this task and are red on main with it.
    const turnedRed = checks ? services.baseline?.afterMerge({ runId: input.runId, taskId: input.task.id, mergeCommit: input.mergeCommit, checks }) ?? [] : [];
    // No message of the plugin's own into the PM chat (0.1.443; Gemini F-007 found this one still live): the fact is a row on the owner's list.
    const tell = (kind: "gate_machine" | "gate_red", key: string, what: string, why: string) => {
      try { postOwnerItem(db as never, { key, source: "integration-gate", kind, projectId: input.projectId, wake: false, what, why, evidence: [{ kind: "run", ref: input.runId }, { kind: "task", ref: input.task.id }] }); } catch { /* the list is a mirror; the log has it */ }
    };
    // A check the machine broke (EACCES, EPERM, EEXIST: root-owned files after a deploy) is no clash of merged work, and
    // no writer can fix it inside owns_paths: an infra incident and one message to the PM, no -mainfix.
    const environment = failing.filter((check) => isEnvironmentCheckFailure(check));
    if (environment.length) {
      const evidence = `${environment[0]!.stderr ?? ""}\n${environment[0]!.stdout ?? ""}`.split("\n").find((line) => isEnvironmentCheckFailure({ stderr: line }))?.trim().slice(0, 300) ?? "";
      ctx.log(`infra: post-merge check of ${input.task.id} is red on main from the environment, no repair task: ${environment.map((check) => check.command).join(", ")} (${evidence})`);
      // One row per machine failure (the key is its fingerprint): the same broken permission does not fill the list.
      tell("gate_machine", `post-merge-infra:${input.runId}:${failureFingerprint(evidence)}`, `После слияния задачи ${input.task.id} проверка ${environment.map((check) => check.command).join(", ")} красная из-за машины, не кода`,
        `${evidence}. Задача исправления не создана: исполнитель не может починить права на файлы. Проверьте машину, на которой идёт проект.`);
    }
    const red = failing.filter((check) => !isEnvironmentCheckFailure(check));
    if (!red.length) return;
    ctx.log(`post-merge check of ${input.task.id} failed on main: ${red.map((check) => check.command).join(", ")}`);
    if (isMainfixTask(input.task.id)) {
      tell("gate_red", `post-merge-red-again:${input.runId}:${input.task.id}`, `main снова красный после починки ${input.task.id}`,
        `Проверка ${red[0]!.command} упала уже после задачи, которая чинила main. Посмотрите, что ещё слилось за это время, и поручите починку в чате проекта.`);
      return;
    }
    // Only a reproducible regression of this task gets a writer: a red that was red on the base too is not its doing, and one
    // that passes on a re-run is flaky. Without a baseline record for a check, the re-run alone decides.
    // A fix turns a check red on the base green: green in its own worktree and red again on main is the merge's doing, not an old red.
    const ownGreen = new Set(input.greenInWorktree ?? []);
    const redBefore = (services.baseline?.redBefore?.({ runId: input.runId, taskId: input.task.id, checks: checks ?? [] }) ?? []).filter((command) => !ownGreen.has(command));
    const candidates = red.filter((check) => !redBefore.includes(check.command));
    // A red that already failed its own re-run (runWithFlakyRerun: `reran`) as a product red both times is reproduced; running it again
    // only repeated the same command twice more (2026-10-29 audit). A re-run that timed out or broke reproduced nothing (audit N-05).
    const reproduced = candidates.filter((check) => {
      const rerun = (check as { rerun?: { exitCode: number; stdout?: string; stderr?: string; hostError?: boolean; threw?: boolean } }).rerun;
      return !!rerun && rerun.exitCode !== 124 && readCheckRun(check, { command: check.command }).verdict === "product_fail" && readCheckRun({ ...check, hostError: false, threw: false, ...rerun }, { command: check.command }).verdict === "product_fail";
    });
    const toRerun = candidates.filter((check) => !reproduced.includes(check));
    let confirmed = candidates;
    let flaky: string[] = [];
    if (toRerun.length) {
      const names = new Set(toRerun.map((check) => check.command));
      const again = await services.runVerification(input.config, { ...onMain, verification: onMain.verification.filter((command) => names.has(command.command)) }, input.runId, undefined,
        { background: true, jobKey: `post-merge:${input.attemptId ?? input.task.id}:${input.mergeCommit ?? ""}:rerun` }).catch(() => null);
      // Only a re-run that is a product red again reproduces the defect (readCheckRun, the reading replay and the gate share). One the
      // machine or the host broke, that threw, or that ran no test says nothing: the first red stays recorded, no writer is sent.
      const readings = new Map((again ?? []).map((check) => [check.command, readCheckRun(check, { command: check.command })] as const));
      flaky = toRerun.filter((check) => readings.get(check.command)?.verdict === "pass").map((check) => check.command);
      confirmed = [...reproduced, ...toRerun.filter((check) => readings.get(check.command)?.verdict === "product_fail")];
      const unsettled = toRerun.filter((check) => !flaky.includes(check.command) && !confirmed.includes(check));
      if (unsettled.length) ctx.log(`post-merge check of ${input.task.id}: red on main once, the re-run did not reproduce it (${unsettled.map((check) => `${check.command}: ${readings.get(check.command)?.verdict ?? "no result"}`).join(", ")}); no repair task, the red stays recorded`);
    }
    if (flaky.length || redBefore.length) {
      ctx.log(`post-merge check of ${input.task.id} on main: no repair task for ${[...flaky, ...redBefore].join(", ")} (${flaky.length ? "flaky" : "red before this task too"})`);
      if (redBefore.length) tell("gate_red", `post-merge-redbefore:${input.runId}:${input.task.id}`, `После слияния задачи ${input.task.id} проверка на main красная, но она была красной и до этой задачи`,
        `${redBefore.join(", ")}: не регрессия этой задачи, задача исправления не создана. Посмотрите сами, если эта проверка важна.`);
    }
    if (!confirmed.length) return;
    const { fix, plan, logs } = postMergeRepair(onMain, confirmed);
    // The writer reads the failure from its task folder; a full log per failing check, best-effort.
    for (const log of logs) {
      await ctx.bb.sdk.files.write({ hostId: input.config.hostId, rootPath: input.basePath, path: `${input.basePath}/${log.path}`,
        content: log.content, contentEncoding: "utf8", createParents: true, expectedSha256: null }).catch(() => undefined);
    }
    const sent = await services.dispatchWriter({ threadId: input.pmThreadId, projectId: input.projectId, task: fix, plan }).catch((cause: unknown) => ({ state: "rejected", reason: cause instanceof Error ? cause.message : String(cause) }));
    const notStarted = String(sent.state) === "rejected" || String(sent.state) === "blocked" || (sent as { ok?: unknown }).ok === false;
    ctx.log(`post-merge check of ${input.task.id}: ${confirmed.map((check) => check.command).join(", ")} fails on main with it${turnedRed.length ? ` (${turnedRed.join(", ")} passed on the base before this task)` : ""}; repair task ${fix.id} ${notStarted ? `could not start (${String((sent as { reason?: unknown }).reason ?? (sent as { hint?: unknown }).hint ?? sent.state)})` : "dispatched"}`);
    if (notStarted) tell("gate_red", `post-merge-repair:${input.runId}:${input.task.id}`, `После слияния задачи ${input.task.id} проверка на main красная, а задача исправления не запустилась`,
      `${confirmed.map((check) => check.command).join(", ")}${turnedRed.length ? ` (до этой задачи проходила)` : ""}. Причина: ${String((sent as { reason?: unknown }).reason ?? (sent as { hint?: unknown }).hint ?? sent.state)}. Работа осталась в main; запустите исправление в чате проекта.`);
  }

  /**
   * What a landed task leaves for verification: the project's gate hears the merge, or — without one — the task's
   * checks rerun on main. Launched from finish.ts at the merge point, before the merge intent is cleared: a reload
   * between merge and this launch leaves the intent, and recovery redoes the check. Fire-and-forget as before;
   * a rejection is logged, and a disposed instance does nothing (its recovery owns the attempt).
   */
  function landed(input:{ projectId:string; runId:string; taskId:string; attemptId:string; writerThreadId:string | null; pmThreadId:string;
      config:{ hostId:string }; task:TaskV2 }, basePath:string, commit:string | null, produced:string[], live:boolean,
      worktreePath:string | null, greenInWorktree:readonly string[] | undefined): void {
    void (async () => {
      if (ctx.state.disposed) return;
      const gate = await gateFor(input.projectId, input.runId, input.config.hostId, basePath);
      if (ctx.state.disposed) return;
      if (gate) await noteMergedForGate(input, basePath, commit ?? "", produced, live);
      else if (!live && worktreePath) await checkMainAfterMerge({ projectId:input.projectId, pmThreadId:input.pmThreadId, config:input.config as never,
        runId:input.runId, task:input.task, basePath, worktreePath, attemptId:input.attemptId, mergeCommit:commit ?? undefined,
        greenInWorktree });
    })().catch((cause:unknown) => {
      ctx.log(`landed reactions of ${input.taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  // Returned for the finish API's callers (tests drive the post-merge check directly).
  return { noteMergedForGate, checkMainAfterMerge, landed };
}

// parseIntegrationGateSettings is re-exported here under a short alias to keep `gateFor` readable.
import { parseIntegrationGateSettings as parseGate } from "../../verification/server";

/**
 * The follow-up task that makes main green after a merge. It keeps the merged task's scope and checks but not its
 * expected_outputs (a prose entry names no file): those files are already in main, and the fix may sit in another owned
 * file or nowhere. Inherited, they made the writer of a green main edit routes.ts only to «put the required file in the
 * diff» (SelfyStudio cards-checkout-typecheck-fix-mainfix, 2026-10-05). The objective carries each failing command with
 * its output tail, the full output goes to the task folder's logs/, and expected_outputs holds the commands themselves.
 */
export function postMergeRepair(onMain: TaskV2, red: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>): {
  fix: TaskV2; plan: string; logs: Array<{ path: string; content: string }>;
} {
  const tail = (check: typeof red[number], size = 600) => `${check.stderr ?? ""}\n${check.stdout ?? ""}`.trim().slice(-size);
  const logName = (command: string, index: number) =>
    `${String(index + 1).padStart(2, "0")}-${command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check"}.log`;
  const fix: TaskV2 = { ...onMain, id: `${onMain.id}-mainfix`.slice(0, 128), title: `Make main green after ${onMain.id}`.slice(0, 200),
    // The task standard (the Tasks board): Lane Pilot's own task fills it, so the contract lint never sends it back.
    display_title: `Починка main после ${onMain.id}`.slice(0, 60), kind: "fix", area: onMain.area ?? "maintenance",
    depends_on: [], risk: onMain.risk === "low" ? "medium" : onMain.risk, expected_outputs: red.map((check) => check.command),
    objective: `Main is red after merging ${onMain.id} (${onMain.title}): these checks fail on main while they passed in the task's own worktree, so the merged work clashes with what landed meanwhile. Make each of them pass on main, keeping what ${onMain.id} and the work merged before it intended; change the least code that does it. Failing now:\n${red.map((check) => `\`${check.command}\` (exit ${check.exitCode}) output tail:\n${tail(check)}`).join("\n\n")}`,
    // Each of the merged task's items whole, never one string cut at 600 characters (a requirement broken mid-word blocks the plan critic).
    acceptance: [...red.map((check) => `\`${check.command}\` passes on main`), ...onMain.acceptance.map((item) => `${onMain.id}'s acceptance still holds: ${item}`)] };
  const logs = red.map((check, index) => ({
    path: `.agents/plans/items/${fix.id}/logs/${logName(check.command, index)}`,
    content: `$ ${check.command}\nexit ${check.exitCode}\n\n${check.stdout ?? ""}\n${check.stderr ?? ""}`.trim() + "\n",
  }));
  const plan = `Post-merge repair, dispatched by Lane Pilot. Full output of every failing check: ${logs.map((log) => log.path).join(", ")}.\n\nRead the failure, find which merged change clashes (git log -5 on main), fix within owns_paths, run the checks. If every check already passes in your worktree before you change anything, main is green now: change no files and answer with the first line \`NEEDS_HUMAN: main is already green, nothing to fix\`.`;
  return { fix, plan, logs };
}
