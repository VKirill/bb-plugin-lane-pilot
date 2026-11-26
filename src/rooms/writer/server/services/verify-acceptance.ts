import type { openDatabase } from "../../../storage";
import { acceptanceArtifactDir, bbWriterReportMarkdown, buildRunExecutionProfile } from "../../../tasks";
import { buildAcceptanceV2, validateAcceptanceV2 } from "../../../tasks/server";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { getAttempt, getRun, getReasoningTrace, saveProjectSetting, taskBasePath } from "../../../storage";
import { parseReadFirstHints } from "../../../tasks";
import { writeReplacing } from "../../../storage";
import { bestEffort } from "@lane-pilot/kit";
import type { VerifyResult } from "../../../tasks";
import { isLiveDecision, LIVE_FOLDER_RECEIPT } from "../../models/live-folder";
import { verifyAcceptanceReceiptIntegrity } from "../../../verification/server";
import { listThreadEventsRaw, THREAD_ITEM_EVENT_TYPES } from "@lane-pilot/thread-observe";
import { writerPatchFromOutput } from "../../models/writer-task";
import { hasTaskHome } from "../../../storage";
import { recordAcceptanceFiles } from "./task-home";
import type { ServerCore } from "../../../contracts/server";
/** The fields of the services bag this file reads, typed by the rooms that own them. */
/** A sandbox that refused the runner its own files: macOS python3 shim «couldn't create cache file … Operation not permitted». */

/**
 * A verification command that fails is run once more: a check that fails once and passes on a re-run (a cold cache, a
 * port still held by the previous run) is flaky, not the writer's fault. Exit 124 is a timeout (the terminal and the
 * host sandbox both report it so) and is not repeated: it would only double the wait.
 * The pass used to replace the failure, and «load» was a guess nobody measured. Now the result keeps the first failure
 * (exit code, output tail) and a machine reading taken just before each attempt (`sample`, on the host the check runs
 * on), with a verdict that names its basis: `machine_pressure` only when a reading crossed a limit, else `unexplained`.
 * A failure that failed its re-run too says `reran` and keeps that re-run (`rerun`): the post-merge check reads both and runs it no third
 * time only when both are product reds (a re-run that timed out reproduced nothing; SMA audit N-05).
 */

export function createVerifyAcceptance({ ctx, db }: { ctx: ServerCore; db: ReturnType<typeof openDatabase> }) {
  const { bb, runPolicyFor } = ctx;
  async function persistWriterAcceptance(input: {
    config:PrototypeConfig; task:TaskV2; runId:string; taskId:string; attempt:number;
    attemptId:string; pmThreadId:string; writerThreadId:string; output:string; verification:VerifyResult[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
    review?:"passed"|"not_required";
    /** Shape-only gates that did not reject (a missing expected output with green checks), and the writer's turns. */
    warnings?:string[]; turns?:number; produced?:string[];
  }): Promise<Record<string,unknown>> {
    const integrity = await verifyAcceptanceReceiptIntegrity(ctx, {
      hostId: input.config.hostId,
      projectCwd: input.task.project_cwd,
      basePath: taskBasePath(db, input.runId, input.taskId),
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      homed: hasTaskHome(db, input.taskId),
      task: input.task,
      produced: input.produced ?? [],
    });
    if (!integrity.ok && (integrity.kind !== "not_run" || input.task.verification.length > 0)) {
      throw new Error(`acceptance_refused: ${integrity.reason}`);
    }
    const reportText = bbWriterReportMarkdown(input.task, input.attempt);
    const reasoningTrace = getReasoningTrace(db, input.attemptId);
    const acceptance = buildAcceptanceV2({
      task:input.task, attempt:input.attempt,
      providerId:reasoningTrace?.providerId ?? input.config.writerProviderId,
      model:reasoningTrace?.model ?? input.config.writerModel, reportText,
      review:input.review,
    });
    const validation = validateAcceptanceV2(acceptance);
    if (!validation.ok) throw new Error(`upstream acceptance-v2 rejected generated receipt: ${validation.errors.join("; ")}`);
    const artifactDir = acceptanceArtifactDir(input.task.project_cwd, input.runId, input.taskId);
    const internalReceipt = {
      schemaVersion:1, status:"accepted", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
      attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
      ...(isLiveDecision(getAttempt(db, input.attemptId)?.workspace_decision) ? { workspace:LIVE_FOLDER_RECEIPT } : {}),
      ownsPaths:input.task.owns_paths, readFirst:parseReadFirstHints(input.task.read_first),
      output:input.output, verification:input.verification,
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)),
      reasoning:reasoningTrace ? [reasoningTrace] : [],
      emergencyFallback:input.emergencyFallback ?? null,
      ...(input.warnings?.length ? { warnings:input.warnings } : {}),
      ...(input.turns ? { turns:input.turns } : {}),
    };
    // A task with a home (docs/task-folder.md, SMA ap_run_dir): acceptance.json and receipt.json once, in the home in the base checkout, so the
    // acceptancePath the PM is shown still exists after the merge removes the worktree. The writer's real output is its attempt's report.md.
    const homed = await recordAcceptanceFiles({ bb, db, log:ctx.log }, { taskId:input.taskId, runId:input.runId, attemptId:input.attemptId, output:input.output,
      acceptance:`${JSON.stringify(acceptance, null, 2)}\n`, receipt:`${JSON.stringify(internalReceipt, null, 2)}\n` });
    for (const [name, content] of homed ? [] : [
      ["report.md", reportText],
      ["acceptance.json", `${JSON.stringify(acceptance, null, 2)}\n`],
      ["lane-pilot-receipt.json", `${JSON.stringify(internalReceipt, null, 2)}\n`],
    ] as const) {
      await writeReplacing(bb.sdk.files, {
        hostId:input.config.hostId, rootPath:input.task.project_cwd,
        path:`${artifactDir}/${name}`, content, createParents:true,
      });
      // A worktree attempt's receipts would die with the copy: the same files also land under the run's base
      // checkout, which is already git-excluded bookkeeping, so the merge is unchanged (sma wi_receipts).
      const basePath = acceptanceReceiptBase(db, input.runId, input.taskId, input.task.project_cwd);
      if (basePath) {
        await bestEffort(ctx.log, "acceptance receipt copy to base", writeReplacing(bb.sdk.files, {
          hostId:input.config.hostId, rootPath:basePath,
          path:`${acceptanceArtifactDir(basePath, input.runId, input.taskId)}/${name}`, content, createParents:true,
        }), undefined);
      }
    }
    const stored = {
      ...internalReceipt,
      acceptancePath: homed?.acceptancePath ?? `${artifactDir}/acceptance.json`,
      acceptance,
    };
    saveProjectSetting(db, input.config.projectId, "writer.lastResult", stored);
    const patch = writerPatchFromOutput(input.output);
    if (patch) saveProjectSetting(db, input.config.projectId, "writer.lastPatch", patch);
    return stored;
  }

  /** What the writer's own thread did (file edits, commands, tool calls), as one text; null when its events cannot be read. */
  async function writerTrace(threadId:string):Promise<string|null> {
    const listed = await bestEffort(bb.log, "verification writer trace", listThreadEventsRaw(bb, { threadId, types:THREAD_ITEM_EVENT_TYPES, order:"asc", limit:"12000" } as never), null);
    if (!listed || !listed.ok) return null;
    return listed.events.map((event) => {
      // Only what the writer did: edited paths, command text and tool arguments. A command's output is no touch —
      // a plain `ls` listed index.md and the writer was blamed for the PM's edit (drill 2026-10-07, 0.1.179).
      const item = (event as { data?: { item?: Record<string, unknown> } })?.data?.item;
      if (!item) return "";
      if (item.type === "fileChange") return JSON.stringify(item.changes ?? item.path ?? item);
      if (item.type === "commandExecution") return String(item.command ?? "");
      if (item.type === "toolCall") return JSON.stringify(item.arguments ?? item.input ?? "");
      return "";
    }).join("\n");
  }

  return { persistWriterAcceptance, writerTrace };
}

export function acceptanceReceiptBase(db: ReturnType<typeof openDatabase>, runId: string, _taskId: string, projectCwd: string): string | null {
  const base = getRun(db, runId)?.writer_workspace_path ?? null;
  return base && base !== projectCwd ? base : null;
}

