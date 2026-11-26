import { bestEffort } from "@lane-pilot/kit";
import {
  failureFingerprint,
  isEnvironmentCheckFailure,
  type LeadRoadApi,
  type PrototypeConfig,
  type TaskV2,
  type VerificationGatePort,
} from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { postOwnerItem } from "../../../owner-waiting";
import type { DispatchWriter, RunVerification, WriterDispatchApi } from "../../../platform/server";
import { writeReplacing } from "../../../storage";
import { isMainfixTask, readCheckRun } from "../../../tasks";
import { buildMainfixTask, type RedCheckInput } from "../../models/mainfix";
import { proofCurrency, type GitRun, type ProofCurrencyResult } from "./proof-currency";

export type { RedCheckInput } from "../../models/mainfix";
export { buildMainfixTask } from "../../models/mainfix";

export type LandingBaselinePort = {
  afterMerge?: (input: { runId: string; taskId: string; mergeCommit?: string; checks: readonly { command: string; exitCode: number; hostError?: true }[] }) => string[];
  redBefore?: (input: { runId: string; taskId: string; checks: readonly { command: string; exitCode: number }[] }) => string[];
};

export interface LandingSuiteServices {
  baseline?: LandingBaselinePort;
  dispatchWriter: DispatchWriter | WriterDispatchApi["dispatchWriter"];
  runVerification?: RunVerification;
  leadRoad?: LeadRoadApi;
  resolveIntegrationGate?: VerificationGatePort;
}

export type ProofReceiptRef = {
  id?: string;
  commit?: string | null;
  paths?: readonly string[];
};

const LANDING_ITEMS_PER_DAY = 5;

/**
 * Checks every receipt/proof against Task 28's `proofCurrency`.
 * Only receipts whose currency verdict is `"current"` count as valid green proof; stale or non-ancestor receipts are rejected.
 */
export async function verifyProofReceiptsCurrent(input: {
  receipts: readonly ProofReceiptRef[];
  git: GitRun;
  log?: (line: string) => void;
}): Promise<{ current: boolean; staleIds: string[]; verdicts: Array<{ id?: string; commit: string | null; verdict: string; reason: string }> }> {
  if (!input.receipts.length) return { current: false, staleIds: [], verdicts: [] };
  const verdicts: Array<{ id?: string; commit: string | null; verdict: string; reason: string }> = [];
  const staleIds: string[] = [];
  for (const receipt of input.receipts) {
    const commit = typeof receipt.commit === "string" ? receipt.commit.trim() : "";
    if (!commit) {
      verdicts.push({ ...(receipt.id ? { id: receipt.id } : {}), commit: null, verdict: "stale", reason: "receipt has no commit SHA" });
      if (receipt.id) staleIds.push(receipt.id);
      continue;
    }
    const evaluated: ProofCurrencyResult = await proofCurrency({
      commit,
      ...(receipt.paths ? { paths: receipt.paths } : {}),
      git: input.git,
      ...(receipt.id ? { receiptId: receipt.id } : {}),
      ...(input.log ? { log: input.log } : {}),
    });
    verdicts.push({
      ...(receipt.id ? { id: receipt.id } : {}),
      commit: evaluated.resolvedCommit ?? commit,
      verdict: evaluated.verdict,
      reason: evaluated.reason,
    });
    if (evaluated.verdict !== "current" && receipt.id) staleIds.push(receipt.id);
  }
  const current = verdicts.length > 0 && verdicts.every((row) => row.verdict === "current");
  return { current, staleIds, verdicts };
}

/**
 * The ONE red handler for post-merge landing failures: classifies environment errors, prevents `-mainfix-mainfix` recursion,
 * suppresses pre-existing baseline failures and flaky reruns, writes logs, dispatches a single `-mainfix` repair task, or
 * files a bounded owner item when repair is not possible.
 */
export async function handleLandingRed(
  ctx: Pick<ServerCore, "bb" | "db" | "log">,
  services: Pick<LandingSuiteServices, "baseline" | "dispatchWriter" | "runVerification">,
  input: {
    projectId: string;
    pmThreadId: string;
    config: PrototypeConfig;
    runId: string;
    task: TaskV2;
    onMain: TaskV2;
    basePath: string;
    attemptId?: string;
    mergeCommit?: string;
    greenInWorktree?: readonly string[];
    checks: RedCheckInput[];
    projectSuiteCommand?: string | null;
    projectSuiteExitCode?: number;
  },
): Promise<{ status: "passed" | "red"; mainfixTaskId: string | null; redCommands: string[] }> {
  const { db } = ctx;
  const tell = (kind: "gate_machine" | "gate_red" | "landing_suite_red", key: string, what: string, why: string) => {
    try {
      postOwnerItem(db as never, {
        key,
        source: "integration-gate",
        kind,
        reason: "red",
        projectId: input.projectId,
        wake: false,
        what,
        why,
        evidence: [{ kind: "run", ref: input.runId }, { kind: "task", ref: input.task.id }],
      });
    } catch { /* mirror item is best-effort */ }
  };

  const failing = input.checks.filter((check) => check.exitCode !== 0 && !check.hostError);
  const turnedRed = services.baseline?.afterMerge?.({
    runId: input.runId,
    taskId: input.task.id,
    mergeCommit: input.mergeCommit,
    checks: input.checks.map((c) => ({ command: c.command, exitCode: c.exitCode, stdout: c.stdout ?? "", stderr: c.stderr ?? "", ...(c.hostError ? { hostError: true as const } : {}) })) as Array<{ command: string; exitCode: number; stdout: string; stderr: string; hostError?: true }>,
  }) ?? [];

  const environment = failing.filter((check) => isEnvironmentCheckFailure(check));
  if (environment.length) {
    const evidence = `${environment[0]!.stderr ?? ""}\n${environment[0]!.stdout ?? ""}`
      .split("\n")
      .find((line) => isEnvironmentCheckFailure({ stderr: line }))
      ?.trim()
      .slice(0, 300) ?? "";
    ctx.log(`infra: post-merge check of ${input.task.id} is red on main from the environment, no repair task: ${environment.map((check) => check.command).join(", ")} (${evidence})`);
    tell(
      "gate_machine",
      `post-merge-infra:${input.runId}:${failureFingerprint(evidence)}`,
      `После слияния задачи ${input.task.id} проверка ${environment.map((check) => check.command).join(", ")} красная из-за машины, не кода`,
      `${evidence}. Задача исправления не создана: исполнитель не может починить права на файлы. Проверьте машину, на которой идёт проект.`,
    );
  }

  const red = failing.filter((check) => !isEnvironmentCheckFailure(check));
  if (!red.length && input.projectSuiteExitCode === undefined) {
    return { status: "passed", mainfixTaskId: null, redCommands: [] };
  }

  if (red.length) ctx.log(`post-merge check of ${input.task.id} failed on main: ${red.map((check) => check.command).join(", ")}`);
  if (red.length && isMainfixTask(input.task.id)) {
    tell(
      "gate_red",
      `post-merge-red-again:${input.runId}:${input.task.id}`,
      `main снова красный после починки ${input.task.id}`,
      `Проверка ${red[0]!.command} упала уже после задачи, которая чинила main. Посмотрите, что ещё слилось за это время, и поручите починку в чате проекта.`,
    );
    return { status: "red", mainfixTaskId: null, redCommands: red.map((c) => c.command) };
  }

  const ownGreen = new Set(input.greenInWorktree ?? []);
  const redBefore = (services.baseline?.redBefore?.({
    runId: input.runId,
    taskId: input.task.id,
    checks: input.checks.map((c) => ({ command: c.command, exitCode: c.exitCode, stdout: c.stdout ?? "", stderr: c.stderr ?? "" })),
  }) ?? []).filter((command) => !ownGreen.has(command));
  const candidates = red.filter((check) => !redBefore.includes(check.command));

  const reproduced = candidates.filter((check) => {
    const rerun = check.rerun;
    return Boolean(rerun)
      && rerun!.exitCode !== 124
      && readCheckRun(check, { command: check.command }).verdict === "product_fail"
      && readCheckRun({ ...check, hostError: false, threw: false, ...rerun }, { command: check.command }).verdict === "product_fail";
  });
  const toRerun = candidates.filter((check) => !reproduced.includes(check));
  let confirmed = candidates;
  let flaky: string[] = [];
  if (toRerun.length && services.runVerification) {
    const names = new Set(toRerun.map((check) => check.command));
    const again = await bestEffort(
      ctx.log,
      "post-merge check rerun",
      services.runVerification(
        input.config,
        { ...input.onMain, verification: input.onMain.verification.filter((command) => names.has(command.command)) },
        input.runId,
        undefined,
        { background: true, jobKey: `post-merge:${input.attemptId ?? input.task.id}:${input.mergeCommit ?? ""}:rerun` } as never,
      ),
      null,
    );
    const readings = new Map((again ?? []).map((check) => [check.command, readCheckRun(check, { command: check.command })] as const));
    flaky = toRerun.filter((check) => readings.get(check.command)?.verdict === "pass").map((check) => check.command);
    confirmed = [...reproduced, ...toRerun.filter((check) => readings.get(check.command)?.verdict === "product_fail")];
    const unsettled = toRerun.filter((check) => !flaky.includes(check.command) && !confirmed.includes(check));
    if (unsettled.length) {
      ctx.log(`post-merge check of ${input.task.id}: red on main once, the re-run did not reproduce it (${unsettled.map((check) => `${check.command}: ${readings.get(check.command)?.verdict ?? "no result"}`).join(", ")}); no repair task, the red stays recorded`);
    }
  }
  if (flaky.length || redBefore.length) {
    ctx.log(`post-merge check of ${input.task.id} on main: no repair task for ${[...flaky, ...redBefore].join(", ")} (${flaky.length ? "flaky" : "red before this task too"})`);
    if (redBefore.length) {
      tell(
        "gate_red",
        `post-merge-redbefore:${input.runId}:${input.task.id}`,
        `После слияния задачи ${input.task.id} проверка на main красная, но она была красной и до этой задачи`,
        `${redBefore.join(", ")}: не регрессия этой задачи, задача исправления не создана. Посмотрите сами, если эта проверка важна.`,
      );
    }
  }

  let mainfixTaskId: string | null = null;
  if (confirmed.length) {
    const { fix, plan, logs } = buildMainfixTask(input.onMain, confirmed);
    for (const entry of logs) {
      await bestEffort(ctx.log, "post-merge check log write", writeReplacing(ctx.bb.sdk.files, {
        hostId: input.config.hostId,
        rootPath: input.basePath,
        path: `${input.basePath}/${entry.path}`,
        content: entry.content,
        createParents: true,
      }), undefined);
    }
    const sent = await services.dispatchWriter({ threadId: input.pmThreadId, projectId: input.projectId, task: fix, plan })
      .catch((cause: unknown) => ({ state: "rejected", reason: cause instanceof Error ? cause.message : String(cause) }));
    const notStarted = String(sent.state) === "rejected" || String(sent.state) === "blocked" || (sent as { ok?: unknown }).ok === false;
    ctx.log(`post-merge check of ${input.task.id}: ${confirmed.map((check) => check.command).join(", ")} fails on main with it${turnedRed.length ? ` (${turnedRed.join(", ")} passed on the base before this task)` : ""}; repair task ${fix.id} ${notStarted ? `could not start (${String((sent as { reason?: unknown }).reason ?? (sent as { hint?: unknown }).hint ?? sent.state)})` : "dispatched"}`);
    if (notStarted) {
      tell(
        "gate_red",
        `post-merge-repair:${input.runId}:${input.task.id}`,
        `После слияния задачи ${input.task.id} проверка на main красная, а задача исправления не запустилась`,
        `${confirmed.map((check) => check.command).join(", ")}${turnedRed.length ? " (до этой задачи проходила)" : ""}. Причина: ${String((sent as { reason?: unknown }).reason ?? (sent as { hint?: unknown }).hint ?? sent.state)}. Работа осталась в main; запустите исправление в чате проекта.`,
      );
    } else {
      mainfixTaskId = fix.id;
    }
  }

  if (input.projectSuiteCommand && input.projectSuiteExitCode !== undefined && input.projectSuiteExitCode !== 0 && input.attemptId) {
    const dayKey = `lp.landing-suite.items:${input.projectId}:${new Date().toISOString().slice(0, 10)}`;
    const kv = ctx.bb.storage.kv as { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<unknown> };
    const posted = Number(await kv.get(dayKey).catch(() => 0)) || 0;
    if (posted < LANDING_ITEMS_PER_DAY) {
      const result = postOwnerItem(db as never, {
        key: `landing-suite:${input.attemptId}`,
        source: "landing-suite",
        kind: "landing_suite_red",
        reason: "red",
        projectId: input.projectId,
        wake: false,
        what: `После вливания принятой задачи её проверка упала — ${input.projectSuiteCommand.slice(0, 200)}`,
        why: `На голове ${(input.mergeCommit ?? "").slice(0, 12)} не прошёл набор проекта (${input.projectSuiteCommand.slice(0, 200)}, exit ${input.projectSuiteExitCode}). Вливание не отменялось.`,
        evidence: [{ kind: "task", ref: input.task.id }],
      });
      if (result.created) await kv.set(dayKey, posted + 1).catch(() => undefined);
    }
  }

  const allRed = [
    ...confirmed.map((c) => c.command),
    ...(input.projectSuiteCommand && input.projectSuiteExitCode && input.projectSuiteExitCode !== 0 ? [input.projectSuiteCommand] : []),
  ];
  return { status: allRed.length ? "red" : "passed", mainfixTaskId, redCommands: allRed };
}
