import { barrierInputBody } from "./barrier-input";
import { recordCritiqueRound } from "./task-home";
import type { ServerCore } from "../../contracts/server";
import type { HelperPolicySnapshot } from "../../contracts";
import type { FinishInput, Services } from "./finish-types";
import { countAttempts, getAttempt, getReasoningTrace, getTaskGitBase, listStageReceipts, loadProjectSettings, transitionAttempt } from "../../storage";
import { actionableFindings, advisoryFeedback, buildCandidateEvidence, codeCritiqueSource, codeRepairPrompt, findingsHash, nextRepairAction, parseCodeCritiqueSettings, parseWriterRepairReply, repairLedgerFromResult, sameUnresolvedFindings, sameWriterIdentity, settingsFromFrozenPolicy, shouldRequestRepair } from "../../critique";
import type { WriterIdentity } from "../../critique";
import { candidatePatches, codeCritiqueTaskContext, runCodeCritique } from "../../critique/server";
import type { FrozenCritiquePolicy } from "../../critique";
import { failureFieldsOf } from "../../storage";
import { critiqueRepeatSkip, patchChangedLines } from "../../contracts";
import { loadCriticCodeDefault } from "./critic-override";
import { recordGateEvaluation, recordStage } from "../../runs/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { fullAccessSpawn } from "../../platform/server";
import { writerExecutionSelection } from "@lane-pilot/models";
import { writerContextBlocks, writerSetupLines } from "./writer-task";
import { isLiveDecision } from "../live-folder";
import { pipelineWriterStep, pipelineWriterTag } from "./pipeline-tag";
import { recordedWriterSkills } from "./skill-pick";
import { sendServiceMessage } from "../../relay/server";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { bestEffort, isNotFound, orMiss, sha256Hex, stringAt } from "@lane-pilot/kit";
import { runOnHost } from "@lane-pilot/host-calls";
import { bookkeepingSetting, isOwnershipNoise } from "@lane-pilot/settings-catalog";
import { writeReplacing } from "../../storage";
import { acceptanceArtifactDir } from "../../tasks";
import { resolve } from "node:path";

/** The shared locals the critique gate reads and writes; owned by the finish body. */
export interface CritiqueGateState {
  candidate: Awaited<ReturnType<Services["validateWriterResult"]>>;
  writerThreadId: string;
  review: "passed" | "not_required";
  repairRound: number;
  previousFindings: ReturnType<typeof actionableFindings>;
  lastArtifact: string;
  approvedArtifact: string;
  frozenPolicy: FrozenCritiquePolicy | undefined;
  repeatSkipChecked: boolean;
  lastPatches: Record<string, string> | undefined;
  criticNotes: string;
  /** The worktree change set the critic approved: what merge's `git add -A` would commit, noise-filtered, plus HEAD. */
  approvedRevision?: { changeSet: string | null; headSha: string | null; headKnown: boolean };
}

export interface CritiqueGateDeps {
  ctx: ServerCore;
  services: Services;
  input: FinishInput;
  endedByStop: (reason: string, threadId?: string) => Record<string, unknown> | null;
  existingCritique: ReturnType<typeof listStageReceipts>[number] | undefined;
  storedLedger: ReturnType<typeof repairLedgerFromResult>;
  liveCritiquePolicy: NonNullable<ReturnType<typeof parseCodeCritiqueSettings>> | FrozenCritiquePolicy;
  projectSettings: ReturnType<typeof loadProjectSettings>;
  taskCriticDefault: Awaited<ReturnType<typeof loadCriticCodeDefault>>;
  yardstick: string[];
  priorCriticApprovals: Parameters<typeof critiqueRepeatSkip>[0]["priorApprovals"];
  baselineHashes: Record<string, string | null>;
}

/** The code-critique gate: repair rounds until the critic passes or a block is decided. Returns the finish result, or null when the gate passed. */
export async function runCodeCritiqueGate(deps: CritiqueGateDeps, g: CritiqueGateState): Promise<Record<string, unknown> | null> {
  const { ctx, services, input, endedByStop, existingCritique, storedLedger, liveCritiquePolicy, projectSettings, taskCriticDefault, yardstick, priorCriticApprovals, baselineHashes } = deps;
  const { bb, db, host } = ctx;
      // HEAD of the attempt workspace: a critic commit leaves the dirty set, so the path snapshot alone cannot see it.
      // No git or an unborn HEAD is a definitive null; a failed probe is unknown and fails the post-approval check closed.
      const probeHead = async (): Promise<{ headSha: string | null; headKnown: boolean }> => {
        const ran = await runOnHost(host, {
          hostId:input.config.hostId, cwd:input.task.project_cwd,
          command:"git rev-parse --verify HEAD", timeoutSec:15, timeoutMs:20_000,
        }).catch(() => null);
        if (!ran) return { headSha:null, headKnown:false };
        if (ran.exitCode === 0) { const sha = ran.stdout.trim(); return { headSha:sha || null, headKnown:true }; }
        if (/not a git repository|ambiguous argument|needed a single revision|bad revision/i.test(ran.stderr)) return { headSha:null, headKnown:true };
        return { headSha:null, headKnown:false };
      };
      const captureEvidence = async () => {
        const dirt = await services.workspaceDirt(input.config, input.task.project_cwd, input.runId);
        const byPath = new Map((dirt.ok ? dirt.snapshots : []).map((row) => [row.path, row.sha256 || null]));
        const files:Array<{ path:string; content:string|null|undefined }> = [];
        for (const path of g.candidate.produced ?? []) {
          let content: string | null | undefined;
          try {
            const file = await orMiss(bb.sdk.files.read({
              hostId:input.config.hostId, rootPath:input.task.project_cwd, path:resolve(input.task.project_cwd, path),
            }), null, isNotFound);
            content = typeof file?.content === "string" ? file.content : null;
          } catch (cause) {
            // One unreadable produced file is a named hold, not a silent pass; the rest still count.
            // undefined is the read-outage outcome, distinct from null (absent).
            ctx.log(`writer ${input.taskId}: the produced file ${path} could not be read (${cause instanceof Error ? cause.message : String(cause)}); its evidence is left out`);
            content = undefined;
          }
          files.push({ path, content });
        }
        // A produced file the writer committed leaves no git-status dirt: a path absent from a successful snapshot
        // takes the sha256 of the bytes just read — the same bytes buildCandidateEvidence compares. A snapshot row
        // (hash or explicit null), a failed snapshot and an unreadable file all stay unknown.
        const contentByPath = new Map(files.map((row) => [row.path, row.content]));
        const hashes = Object.fromEntries((g.candidate.produced ?? []).map((path) => {
          if (byPath.has(path)) return [path, byPath.get(path) ?? null];
          if (!dirt.ok) return [path, null];
          const content = contentByPath.get(path);
          return [path, typeof content === "string" ? sha256Hex(content) : null];
        }));
        g.lastPatches = await candidatePatches(bb, db, { runId:input.runId, taskId:input.taskId, hostId:input.config.hostId, cwd:input.task.project_cwd, paths:g.candidate.produced ?? [] });
        // The same frozen base candidatePatches diffs against: committed work has no `git diff HEAD`, so the
        // critic's own re-read in pointer mode needs it (absent base → legacy HEAD advice).
        const gitBase = getTaskGitBase(db as never, input.taskId);
        const diffBase = gitBase?.compare_committed ? gitBase.base_sha ?? undefined : undefined;
        const evidence = buildCandidateEvidence({
          produced:g.candidate.produced ?? [],
          hashes,
          baselineHashes,
          files,
          patches:g.lastPatches,
          verification:(g.candidate.verification ?? []).map((row) => ({
            command:row.command, exitCode:row.exitCode,
            stdout:row.stdout, stderr:row.stderr,
          })),
          output:g.candidate.output,
          ownsPaths:input.task.owns_paths,
          neverTouch:input.task.never_touch,
          dirtOk:dirt.ok,
          dirtReason:dirt.ok ? undefined : dirt.reason,
          diffBase,
          workspace:input.task.project_cwd,
          referenceTestEdits:yardstick,
        });
        // The whole change set merge's `git add -A` commits — every dirty path + content hash, not only
        // produced ones; ownership noise is filtered like the ownership gates.
        const noise = bookkeepingSetting(projectSettings);
        const changeSet = dirt.ok
          ? dirt.snapshots.filter((row) => !isOwnershipNoise(row.path, noise))
              .map((row) => `${row.path}\t${row.sha256}`).sort().join("\n")
          : null;
        return { evidence, revision:{ changeSet, ...(await probeHead()) } };
      };
      const keepAdvisory = (row: { settings?: { mode?: string }; parsed?: Parameters<typeof advisoryFeedback>[0] } | undefined) => {
        if (row?.settings?.mode !== "advisory" || !row.parsed) return;
        const text = advisoryFeedback(row.parsed);
        if (text) g.criticNotes = text;
      };
  if (!liveCritiquePolicy.enabled) return null;
      // The same task-home context runCodeCritique resolves for its stage input, so the repair bookkeeping receipts hash identically.
      const taskContext = await codeCritiqueTaskContext(bb, db, input.taskId);
      // What the barrier judged, kept with the attempt: the patches, the promise, the contract and the previous
      // verdict, plus the inputSha256 the stage receipt carries (sma av_inputs). Written in the attempt's
      // workspace (the same writer as persistPlan); a failed write never fails the finish.
      const archiveBarrierInput = async (state:"passed"|"blocked"|"skipped") => {
        // Beside the task's other receipts, in the run's bookkeeping folder: the attempt's own checkout stays clean.
        const workspace = input.task.project_cwd;
        if (!workspace) return;
        const receipt = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
        const body = barrierInputBody({ state, inputSha256:receipt?.inputSha256 ?? null,
          diff:g.lastPatches ?? null, promise:input.task.promise ?? null, contract:input.task,
          priorVerdict:existingCritique?.result ?? null });
        // A task with a home (docs/task-folder.md): the input and the critic's verdict of this round in the attempt's folder there, in the base.
        if (await recordCritiqueRound({ bb, db, log:ctx.log }, { taskId:input.taskId, runId:input.runId, attemptId:input.attemptId, round:g.repairRound,
          barrierInput:body, verdict:receipt ? { state:receipt.state, result:receipt.result ?? null, inputSha256:receipt.inputSha256 ?? null } : { state } })) return;
        await bestEffort(ctx.log, "barrier input archive", writeReplacing(bb.sdk.files, { hostId:input.config.hostId, rootPath:workspace,
          path:`${acceptanceArtifactDir(workspace, input.runId, input.taskId)}/attempts/${input.attemptId}/barrier-input.json`,
          content:JSON.stringify(body, null, 2), createParents:true }), undefined);
      };
      for (;;) {
        const { evidence, revision } = await captureEvidence();
        const ledger = repairLedgerFromResult(listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique")?.result);
        if (ledger?.policy) g.frozenPolicy = ledger.policy;
        if (ledger?.repairRound) g.repairRound = Math.max(g.repairRound, ledger.repairRound);
        const disputes = g.repairRound > 0 ? parseWriterRepairReply(g.candidate.output) : null;
        if (disputes && disputes.replies.length > 0 && disputes.replies.every((row) => row.status === "disputed")) {
          const recritique = await runCodeCritique({
            stageHelperSettings: services.stageHelperSettings, bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            config:input.config, task:input.task, evidence, disputes, frozenPolicy:g.frozenPolicy, criticDefault:taskCriticDefault,
            workflow:pipelineWriterStep(db, input.runId, input.taskId) ?? undefined,
          });
          if (recritique.policy) g.frozenPolicy = recritique.policy;
          if (recritique.allowed) { keepAdvisory(recritique); g.review = recritique.review; g.approvedArtifact = evidence.artifactRevisionSha256; g.approvedRevision = revision; break; }
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason:recritique.reason},
            tree:evidence.artifactRevisionSha256,verdict:recritique.parsed?{status:String(recritique.parsed.status),summary:String(recritique.parsed.summary??"")}:null});
          transitionAttempt(db, input.attemptId, "blocked", { reason:recritique.reason });
          return { status:"blocked", reason:recritique.reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        const inflight = nextRepairAction({
          ledger, nextRound:Math.max(1, ledger?.repairRound ?? g.repairRound),
          attemptId:input.attemptId, artifactRevisionSha256:evidence.artifactRevisionSha256,
        });
        if (inflight === "unknown") {
          const reason = "code_critique_repair_unknown";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        if (inflight === "wait" && ledger?.repairThreadId) {
          g.writerThreadId = ledger.repairThreadId;
          g.repairRound = ledger.repairRound;
          g.lastArtifact = ledger.artifactRevisionSha256 || g.lastArtifact;
          await waitThreadIdle(bb,ledger.repairThreadId,"code_critique_repair_timeout",undefined,ledger.repairSentAt);
          g.candidate = await services.validateWriterResult({
            config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:ledger.repairThreadId,
            attemptId:input.attemptId, dirtBefore:input.dirtBefore,
          });
          if (g.candidate.status !== "accepted") {
            recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
              attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:g.candidate.status}});
            const stopped = endedByStop(g.candidate.reason ?? g.candidate.status, g.writerThreadId);
            if (stopped) return stopped;
            transitionAttempt(db, input.attemptId, g.candidate.status, { reason:g.candidate.reason, ...failureFieldsOf(g.candidate) });
            return { ...g.candidate, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
          }
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked",
            input:codeCritiqueSource({ evidence, task:input.task, agent:g.frozenPolicy?.agent ?? "code-critic", context:taskContext.context }),
            result:{ ...ledger, spawnAttempted:true, repairObserved:true, repairThreadId:ledger.repairThreadId, repairRound:ledger.repairRound },
            reason:"critique_changes_requested",
          });
          await archiveBarrierInput("blocked");
          continue;
        }
        if (g.lastArtifact && evidence.artifactRevisionSha256 === g.lastArtifact && g.repairRound > 0
          && !(disputes && disputes.replies.some((row) => row.status === "disputed"))) {
          const reason = "code_critique_revision_unchanged";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        // The same files a critic approved < 48 h ago and a small diff: skip the g.review, receipt says why (hub R10).
        // Only a task with no critique ledger of its own — a repair in flight always re-reviews — and only where a
        // skipped receipt is a legal stage move (no receipt yet, or a pending one a crash left behind).
        if (!g.repeatSkipChecked) {
          g.repeatSkipChecked = true;
          const patchMap = g.lastPatches ?? {};
          const producedPaths = g.candidate.produced ?? [];
          const skip = (!existingCritique || existingCritique.state === "pending") && !storedLedger && g.repairRound === 0
            && (!evidence.truncated || evidence.truncateReason === "packet_truncated")
            ? critiqueRepeatSkip({
                risk:input.task.risk, referenceTestEdits:yardstick,
                changedLines:producedPaths.length === 0 ? 0 : Object.keys(patchMap).length === 0 ? null : patchChangedLines(patchMap),
                ownsPaths:input.task.owns_paths, priorApprovals:priorCriticApprovals, now: Date.now(),
              })
            : null;
          if (skip) {
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"skipped",
              input:codeCritiqueSource({ evidence, task:input.task, agent:g.frozenPolicy?.agent ?? "code-critic", context:taskContext.context }),
              result:{ skipped:"repeat", priorTaskId:skip.priorTaskId, changedLines:patchChangedLines(patchMap) },
              reason:`repeat:${skip.priorTaskId}`,
            });
            await archiveBarrierInput("skipped");
            g.approvedArtifact = evidence.artifactRevisionSha256;
            g.approvedRevision = revision;
            break;
          }
        }
        const critique = await runCodeCritique({
          stageHelperSettings: services.stageHelperSettings, bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          config:input.config, task:input.task, evidence, frozenPolicy:g.frozenPolicy, criticDefault:taskCriticDefault,
          workflow:pipelineWriterStep(db, input.runId, input.taskId) ?? undefined,
        });
        if (critique.policy) g.frozenPolicy = critique.policy;
        if (critique.allowed) { await archiveBarrierInput("passed"); keepAdvisory(critique); g.review = critique.review; g.approvedArtifact = evidence.artifactRevisionSha256; g.approvedRevision = revision; break; }
        const parsed = critique.parsed;
        const critiqueSettings = g.frozenPolicy ? settingsFromFrozenPolicy(g.frozenPolicy) : critique.settings;
        if (!parsed || !critiqueSettings || !shouldRequestRepair({ settings:critiqueSettings, result:parsed, round:g.repairRound })) {
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason:critique.reason},
            tree:evidence.artifactRevisionSha256,verdict:parsed?{status:String(parsed.status),summary:String(parsed.summary??"")}:null});
          await archiveBarrierInput("blocked");
          transitionAttempt(db, input.attemptId, "blocked", { reason:critique.reason });
          return { status:"blocked", reason:critique.reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        const nextFindings = actionableFindings(parsed);
        if (g.previousFindings.length && sameUnresolvedFindings(g.previousFindings, nextFindings)) {
          const reason = "code_critique_repeated_finding";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        g.previousFindings = nextFindings;
        g.lastArtifact = evidence.artifactRevisionSha256;
        const nextRound = g.repairRound + 1;
        const spawnLedger = repairLedgerFromResult(critique.critique);
        const action = nextRepairAction({ ledger:spawnLedger, nextRound, attemptId:input.attemptId, artifactRevisionSha256:evidence.artifactRevisionSha256 });
        if (action === "unknown") {
          const reason = "code_critique_repair_unknown";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        const trace = getReasoningTrace(db, input.attemptId);
        const bound = getAttempt(db, input.attemptId);
        if (!trace || !bound) {
          const reason = "code_critique_writer_identity_unknown";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        const writerSnapshot:WriterIdentity = {
          attemptId:input.attemptId,
          providerId:trace.providerId,
          model:trace.model,
          reasoningLevel:trace.effectiveReasoningLevel,
          serviceTier:trace.serviceTier,
          environmentId:bound.environment_id,
          workspacePath:bound.workspace_path ?? input.task.project_cwd,
        };
        if (trace.attemptId !== input.attemptId || (spawnLedger?.writer && !sameWriterIdentity(spawnLedger.writer, writerSnapshot))) {
          const reason = "code_critique_writer_mismatch";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        const frozenFindings = spawnLedger?.findings?.length ? spawnLedger.findings : nextFindings;
        const frozenHash = spawnLedger?.findingsHash || findingsHash(frozenFindings);
        if (frozenHash !== findingsHash(nextFindings) && spawnLedger?.findingsHash) {
          const reason = "code_critique_findings_mutated";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        let repairThreadId = action === "wait" ? spawnLedger?.repairThreadId : undefined;
        let repairSentAt = action === "wait" ? spawnLedger?.repairSentAt : undefined;
        const critiqueInput = codeCritiqueSource({ evidence, task:input.task, agent:critiqueSettings.agent, context:taskContext.context });
        const ledgerBase = {
          ...parsed,
          artifactRevisionSha256:evidence.artifactRevisionSha256,
          evidenceSha256:evidence.evidenceSha256,
          revisionSha256:evidence.artifactRevisionSha256,
          findingsHash:frozenHash,
          findings:frozenFindings,
          repairRound:nextRound,
          writer:writerSnapshot,
          policy:g.frozenPolicy,
          reviewer:(critique.critique && typeof critique.critique === "object" && "reviewer" in critique.critique)
            ? (critique.critique as { reviewer?: unknown }).reviewer
            : undefined,
          mode:critiqueSettings.mode, autoFix:critiqueSettings.autoFix, maxRounds:critiqueSettings.maxRounds,
        };
        if (!repairThreadId) {
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked", input:critiqueInput,
            result:{ ...ledgerBase, spawnAttempted:true },
            reason:critique.reason ?? "critique_changes_requested",
          });
          const dispatch = trace.dispatchContext;
          if (!dispatch) {
            const reason = "code_critique_dispatch_context_missing";
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput, result:{ ...ledgerBase, spawnAttempted:true }, reason,
            });
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
          }
          let helperPolicy:HelperPolicySnapshot;
          try {
            helperPolicy = requireHelperSpawn({ bb, db, projectId:input.projectId, runId:input.runId });
          } catch (cause) {
            const reason = `code_critique_helper_policy_missing:${cause instanceof Error ? cause.message : String(cause)}`;
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
          }
          if (helperPolicy.mode !== dispatch.helperMode || (helperPolicy.policy?.required === true) !== dispatch.helperRequired) {
            const reason = "code_critique_helper_policy_mismatch";
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
          }
          const repairPrompt = [codeRepairPrompt({
            task:input.task, findings:frozenFindings, agent:dispatch.agent,
            setupLines:writerSetupLines(isLiveDecision(bound.workspace_decision)),
            contextBlocks:writerContextBlocks(input.task, dispatch.memoryText, dispatch.executionPacket, dispatch.pmReadContext, dispatch.rulesText ?? ""),
          })].filter(Boolean).join("\n\n");
          const environment = bound.environment_id
            ? { type:"reuse" as const, environmentId:bound.environment_id }
            : { type:"host" as const, hostId:input.config.hostId, workspace:{ type:"unmanaged" as const, path:writerSnapshot.workspacePath } };
          // The writer that wrote the code fixes the findings in its own thread, with its context; a new thread only
          // when that one is gone or busy.
          const writerIdle = stringAt(await orMiss(bb.sdk.threads.get({ threadId:g.writerThreadId }), null, isNotFound), "status") === "idle";
          if (writerIdle) {
            const sentAt = Date.now();
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput,
              result:{ ...ledgerBase, spawnAttempted:true, repairThreadId:g.writerThreadId, repairSentAt:sentAt },
              reason:critique.reason ?? "critique_changes_requested",
            });
            const sent = await Promise.resolve().then(() => sendServiceMessage(bb, { threadId:g.writerThreadId, text:repairPrompt, senderThreadId:input.pmThreadId })).then(() => true, () => false);
            if (sent) { repairThreadId = g.writerThreadId; repairSentAt = sentAt; }
          }
          let spawned: unknown;
          if (!repairThreadId) {
            const placement = await helperChildPlacement({
              bb, db, projectId:input.projectId, runId:input.runId, role:"writer", taskTitle:input.task.title,
            });
            try {
              spawned = await fullAccessSpawn(bb, {
                ...placement,
                ...requiredPolicyField(bb, helperPolicy, writerSnapshot.providerId, "code-repair", { skills:recordedWriterSkills(dispatch) }),
                ...writerExecutionSelection(
                  writerSnapshot.providerId,
                  writerSnapshot.model,
                  writerSnapshot.reasoningLevel,
                  writerSnapshot.serviceTier,
                ),
                prompt:repairPrompt,
                environment,
                pluginMetadata:{
                  role:"writer", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
                  attemptId:input.attemptId, repairRound:nextRound,
                  revisionSha256:evidence.revisionSha256, findingsHash:frozenHash, stageId:"writer-agent",
                  writer:writerSnapshot,
                  ...pipelineWriterTag(db, input.runId, input.taskId),
                },
              });
            } catch {
              const reason = "code_critique_repair_unknown";
              recordStage(db, {
                runId:input.runId, taskId:input.taskId, stageId:"code-critique",
                state:"blocked", input:critiqueInput,
                result:{ ...ledgerBase, spawnAttempted:true },
                reason,
              });
              transitionAttempt(db, input.attemptId, "blocked", { reason });
              return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
            }
          }
          if (!repairThreadId) repairThreadId = stringAt(spawned, "id") ?? undefined;
          if (!repairThreadId) {
            const reason = "code_critique_repair_unknown";
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput,
              result:{ ...ledgerBase, spawnAttempted:true },
              reason,
            });
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
          }
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked", input:critiqueInput,
            result:{ ...ledgerBase, spawnAttempted:true, repairThreadId, ...(repairSentAt ? { repairSentAt } : {}) },
            reason:critique.reason ?? "critique_changes_requested",
          });
        }
        g.writerThreadId = repairThreadId;
        g.repairRound = nextRound;
        await waitThreadIdle(bb,repairThreadId,"code_critique_repair_timeout",undefined,repairSentAt);
        g.candidate = await services.validateWriterResult({
          config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:repairThreadId,
          attemptId:input.attemptId, dirtBefore:input.dirtBefore,
        });
        if (g.candidate.status !== "accepted") {
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:g.candidate.status}});
          const stopped = endedByStop(g.candidate.reason ?? g.candidate.status, g.writerThreadId);
          if (stopped) return stopped;
          transitionAttempt(db, input.attemptId, g.candidate.status, { reason:g.candidate.reason, ...failureFieldsOf(g.candidate) });
          return { ...g.candidate, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
        }
        recordStage(db, {
          runId:input.runId, taskId:input.taskId, stageId:"code-critique",
          state:"blocked", input:critiqueInput,
          result:{ ...ledgerBase, spawnAttempted:true, repairObserved:true, repairThreadId, repairRound:nextRound, ...(repairSentAt ? { repairSentAt } : {}) },
          reason:critique.reason ?? "critique_changes_requested",
        });
        continue;
      }
      const { evidence: confirm, revision: confirmRevision } = await captureEvidence();
      // An unreadable packet is a skipped receipt and does not stop the writer; a moved revision does — full
      // content hashes are checked even when the packet was truncated, and an unreadable confirm is unknown.
      const approved = g.approvedRevision;
      const moved = !g.approvedArtifact || confirm.artifactRevisionSha256 !== g.approvedArtifact
        || (approved?.changeSet != null && confirmRevision.changeSet != null && confirmRevision.changeSet !== approved.changeSet)
        || (approved?.headKnown === true && confirmRevision.headKnown && confirmRevision.headSha !== approved.headSha);
      const unknown = (approved?.changeSet != null && confirmRevision.changeSet == null)
        || (approved?.headKnown === true && !confirmRevision.headKnown);
      const reason = moved ? "code_critique_stale_revision" : unknown ? "code_critique_revision_unknown" : null;
      if (reason) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId };
      }
  return null;
}
