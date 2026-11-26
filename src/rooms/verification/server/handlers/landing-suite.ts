import { join as joinPath, relative, resolve } from "node:path";
import { SETTING_VERIFICATION_PROJECT_SUITE } from "@lane-pilot/settings-catalog";
import { runOnHost } from "@lane-pilot/host-calls";
import { parseIntegrationGateSettings, type LeadRoadApi, type TaskV2 } from "../../../contracts";
import { configuredSetting, type ServerCore } from "../../../contracts/server";
import type { DispatchWriter, WorkflowEngineApi } from "../../../platform/server";
import { getAttempt, getRun, getRunSettingsScopes, getTask, listOpenAttempts, loadProjectSettings } from "../../../storage";
import type { RedCheckInput } from "../../models/mainfix";
import { gateResolverFor } from "../services/gate-detect";
import { IntegrationGateRunner, type Services as GateServices } from "../services/integration-gate";
import { handleLandingRed, verifyProofReceiptsCurrent, type LandingSuiteServices, type ProofReceiptRef } from "../services/landing-suite";
import { hostGit } from "../services/proof-currency";

const LANDING_GATE_TIMEOUT_SEC = 30 * 60;

/**
 * Registers the single unified `lp.landing_suite` workflow action for `workflows/lp.landing-suite.json` (triggered by `lp.attempt.merged`).
 */
export function registerLandingSuiteAction(engine: WorkflowEngineApi["workflowEngine"], ctx: ServerCore, services: LandingSuiteServices): void {
  const claimedInMemory = new Set<string>();
  const gateServices: GateServices = {
    leadRoad: services.leadRoad ?? ({} as LeadRoadApi),
    dispatchWriter: services.dispatchWriter as DispatchWriter,
  };
  const gateRunner = new IntegrationGateRunner(ctx, gateServices);

  engine.register("lp.landing_suite", {
    reentrant: true,
    run: async (stepCtx) => {
      const raw = stepCtx.input.with ?? {};
      const attemptId = String(raw.attemptId ?? "");
      const runId = String(raw.runId ?? "");
      const taskId = String(raw.taskId ?? "");
      const projectId = String(raw.projectId ?? "");
      const pmThreadId = String(raw.pmThreadId ?? "");
      const writerThreadId = typeof raw.writerThreadId === "string" ? raw.writerThreadId : null;
      const hostId = String(raw.hostId ?? "");
      const basePath = String(raw.basePath ?? "");
      const mergeCommit = typeof raw.mergeCommit === "string" && raw.mergeCommit ? raw.mergeCommit : undefined;
      const worktreePath = typeof raw.worktreePath === "string" && raw.worktreePath ? raw.worktreePath : undefined;
      const live = raw.live === true;
      const produced = Array.isArray(raw.produced) ? raw.produced.filter((v): v is string => typeof v === "string") : [];
      const greenInWorktree = Array.isArray(raw.greenInWorktree) ? raw.greenInWorktree.filter((v): v is string => typeof v === "string") : [];

      if (!attemptId || !taskId || !runId || !projectId || !basePath || !hostId) {
        return { output: { status: "skipped", culprit_task_id: "", mainfix_task_id: "" } };
      }

      const claimKey = `${attemptId}:${mergeCommit ?? ""}`;
      if (claimedInMemory.has(claimKey)) {
        return { output: { status: "skipped", culprit_task_id: "", mainfix_task_id: "" } };
      }
      claimedInMemory.add(claimKey);

      const attempt = getAttempt(ctx.db, attemptId);
      const taskRow = getTask(ctx.db, taskId);
      const run = getRun(ctx.db, runId);
      if (!attempt || !taskRow || !run) {
        return { output: { status: "skipped", culprit_task_id: "", mainfix_task_id: "" } };
      }
      if (Boolean(await ctx.bb.storage.kv.get(`run-halted:${runId}`))) {
        return { output: { status: "skipped", culprit_task_id: "", mainfix_task_id: "" } };
      }

      const scopes = getRunSettingsScopes(ctx.db, runId);
      const settings = loadProjectSettings(ctx.db, projectId, scopes);

      // Currency guard (Task 28): stale proofs/receipts never exempt main verification.
      const receiptsRaw = Array.isArray(raw.receipts) ? (raw.receipts as ProofReceiptRef[]) : [];
      if (receiptsRaw.length && mergeCommit) {
        const git = hostGit(async (command) => {
          const ran = await runOnHost(ctx.host, { hostId, cwd: basePath, command, timeoutSec: 30, timeoutMs: 30_000 }).catch(() => null);
          return ran ?? { exitCode: 1, stdout: "", stderr: "host_error" };
        });
        const checked = await verifyProofReceiptsCurrent({ receipts: receiptsRaw, git, log: ctx.log });
        if (!checked.current) {
          ctx.log(`landing-suite: ignoring stale proof receipts for ${taskId} (${checked.staleIds.join(", ") || "non-current commit"})`);
        }
      }

      const gate = await gateResolverFor(ctx)({ runId, hostId, basePath, gate: parseIntegrationGateSettings(settings) });
      if (gate) {
        gateRunner.noteMergedTask({ taskId, commitSha: mergeCommit ?? "", threadId: writerThreadId, attemptId, produced }, { projectId, hostId, basePath });
        const drained = !listOpenAttempts(ctx.db).some((row) => row.project_id === projectId && row.id !== attemptId);
        const res = await gateRunner.maybeRunGate({ runId, projectId, pmThreadId, basePath, configHostId: hostId, trigger: drained ? "drain" : "merge", ...(live ? { live: true } : {}) });
        return { output: { status: res.ran ? (res.passed ? "passed" : "red") : "skipped", culprit_task_id: res.culpritTaskId ?? "", mainfix_task_id: "" } };
      }

      const task = taskRow.contract as TaskV2;
      const namedSuite = configuredSetting(settings, SETTING_VERIFICATION_PROJECT_SUITE);
      const suiteCommand = typeof namedSuite === "string" && namedSuite.trim() ? namedSuite.trim() : null;
      const onBase = (cwd: string) => worktreePath && resolve(cwd).startsWith(resolve(worktreePath)) ? joinPath(basePath, relative(worktreePath, cwd)) : cwd;
      const onMain: TaskV2 = {
        ...task,
        project_cwd: basePath,
        verification: (task.verification ?? []).map((command) => ({ ...command, cwd: onBase(command.cwd) })),
      };

      const config = await ctx.configForRun(projectId, run);
      let checks: RedCheckInput[] = [];
      if (!live && onMain.verification.length && services.runVerification && config) {
        const ran = await services.runVerification(config, onMain, runId, undefined, {
          background: true,
          jobKey: `post-merge:${attemptId}:${mergeCommit ?? ""}`,
        } as never).catch((cause: unknown) => {
          ctx.log(`post-merge check of ${taskId} could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
          return null;
        });
        if (ran) checks = ran;
      }

      let suiteExitCode: number | undefined;
      if (suiteCommand && mergeCommit) {
        const ranSuite = await ctx.host.call("gateRun", { requestedHostId: hostId, basePath, command: suiteCommand, timeoutSec: LANDING_GATE_TIMEOUT_SEC }, { hostId, timeoutMs: (LANDING_GATE_TIMEOUT_SEC + 60) * 1000 })
          .catch(() => null) as { exitCode?: number } | null;
        if (typeof ranSuite?.exitCode === "number") suiteExitCode = ranSuite.exitCode;
      }

      const outcome = config
        ? await handleLandingRed(ctx, services, {
            projectId,
            pmThreadId,
            config,
            runId,
            task,
            onMain,
            basePath,
            attemptId,
            mergeCommit,
            worktreePath,
            greenInWorktree,
            checks,
            projectSuiteCommand: suiteCommand,
            projectSuiteExitCode: suiteExitCode,
          } as Parameters<typeof handleLandingRed>[2])
        : { status: "skipped" as const, mainfixTaskId: null, redCommands: [] };

      return {
        output: {
          status: outcome.status,
          culprit_task_id: outcome.status === "red" ? taskId : "",
          mainfix_task_id: outcome.mainfixTaskId ?? "",
        },
      };
    },
  });
}
