import { resolve } from "node:path";
import { taskFamily } from "@lane-pilot/contracts";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort, BOUNDED_READ_MAX_FILE_BYTES, sha256Hex } from "@lane-pilot/kit";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode, withReferenceTestCritic } from "../../../contracts/quality-mode";
import type { ServerCore } from "../../../contracts/server";
import { taskWordItemPrefix } from "../../../contracts";
import { actionableFindings, parseCodeCritiqueSettings, repairLedgerFromResult } from "../../../critique";
import { headSides } from "../../../critique/server";
import { closeOwnerItemsByPrefix, postOwnerItem, rpcLine } from "../../../owner-waiting";
import { sendServiceMessage } from "../../../relay/server";
import { recordGateEvaluation } from "../../../runs/server";
import { conventionGateHits, type ConventionGate } from "../../../session-hooks";
import {
  countAttempts, getAttempt, getRun, getRunSettingsScopes, getTask, hasTaskHome, listStageReceipts,
  listUnreportedTaskOutcomes, loadProjectSettings, markTaskOutcomesReported, noteToldPmDirectly,
  priorAttemptStates, taskBasePath, transitionAttempt, writeReplacing,
} from "../../../storage";
import {
  OWNER_WORD_WAIT_MS, TASK_WORDS_KEY, TEST_EDIT_HOLD_ITEM, TEST_PATH,
  acceptanceArtifactDir, acceptanceProofGap, checkScriptEdits, landingWordAsked, landingWordGap,
  ownerWordsMode, questionsFromFile,
  referenceTestEdits, sensitiveHits, shapeFlags, taskStepEvidence, taskWordKey,
  testEditHoldKey, testFitFindings, testOwnedImports, writerMarkers,
  type StageId, type TaskWord,
} from "../../../tasks";
import { recordTaskApproach, recordTaskQuestions, testEditAllowance } from "../../../tasks/server";
import { isLiveDecision } from "../../models/live-folder";
import { progressJournal } from "../../models/progress-journal";
import { runCodeCritiqueGate, type CritiqueGateState } from "./critique-gate";
import { loadCriticCodeDefault } from "../repositories/critic-override";
import { executionChecklist } from "../../models/execution-checklist";
import type { FinishInput, Services } from "./finish-types";
import { readLiveBefore, resolveLiveBackupId } from "./live-backup-evidence";
import { runPlanFactStage } from "./plan-fact";
import { keepWriterNotes, recordTaskHomeFile, recordWriterReport, writerNotePath } from "./task-home";

/** The owner-facing name of each class the landing word is asked for on owner.words=sensitive. */
const SENSITIVE_RU = { money: "деньги", data: "базу данных (миграции, схему или удаление данных)", deploy: "выкат в боевую среду" } as const;

export type PostValidationOutcome =
  | { kind: "terminal"; result: Record<string, unknown> }
  | { kind: "wait_owner_word"; candidate: Awaited<ReturnType<Services["validateWriterResult"]>>; writerThreadId: string }
  | { kind: "passed"; candidate: Awaited<ReturnType<Services["validateWriterResult"]>>; writerThreadId: string; review: "passed" | "not_required"; checklist: Record<string, unknown> };

/** Post-validation gates shared between `finishWriterAttemptBody` and `lp.attempt-critique`: code critique, plan-fact, convention gates, test-fit, notes/checkpoints, proof, and owner landing word. */
export async function runPostValidationGates(params: {
  ctx: ServerCore;
  services: Services;
  input: FinishInput;
  candidate: Awaited<ReturnType<Services["validateWriterResult"]>>;
  writerThreadId: string;
  answer: string;
  parkOwnerWord?: boolean;
  endedByStop: (reason: string, threadId?: string) => Record<string, unknown> | null;
  stoppedMeanwhile: (where: string, threadId?: string) => Record<string, unknown> | null;
}): Promise<PostValidationOutcome> {
  const { ctx, services, input, answer, endedByStop, stoppedMeanwhile } = params;
  const { bb, db, host } = ctx;
      let candidate = params.candidate;
      let writerThreadId = params.writerThreadId;
      let review:"passed"|"not_required" = "not_required";
      const existingCritique = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
      const storedLedger = repairLedgerFromResult(existingCritique?.result);
      let repairRound = storedLedger?.repairRound ?? 0;
      let previousFindings:ReturnType<typeof actionableFindings> = storedLedger?.findings?.length
        ? storedLedger.findings.filter((row) => row.severity === "blocking")
        : [];
      let lastArtifact = storedLedger?.artifactRevisionSha256 ?? "";
      let frozenPolicy = storedLedger?.policy;
      const projectSettings = loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
      // quality_mode (task, else project, else standard) switches the code critic off (quick) or on (full); in standard mode the task's
      // risk may switch it on (critic.code.default_for_risk, or the value the dispatch carried).
      const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
      const taskCriticDefault = await loadCriticCodeDefault(bb.storage.kv as never, input.taskId);
      const criticDefault = resolveCodeCriticDefault(projectSettings[CODE_CRITIC_DEFAULT_SETTING], taskCriticDefault);
      // Tests that existed on the base and that the writer changed: read once here, so the critic is switched on for them, and below for test_fit.
      const fitAttempt = getAttempt(db, input.attemptId);
      const basePathForTests = taskBasePath(db, input.runId, input.taskId);
      const readFit = async (cwd:string | null | undefined, path:string):Promise<string|null> => {
        if (!cwd) return null;
        const parts:string[] = [];
        let offset = 0, bytes = 0, sha:string|undefined;
        for (;;) {
          const file = await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:cwd, relativePath:path, offset, maxLines:2000 }, { hostId:input.config.hostId, timeoutMs:10_000 })
            .catch((cause) => { if (offset === 0) return null; throw cause; });
          if (!file) return null;
          // Never approve a partial file or stitch together two editions of a test.
          if (parts.length && sha !== file.sha256) throw new Error(`test_fit_read: ${path} changed during the read`);
          bytes += Buffer.byteLength(file.content, "utf8") + (parts.length ? 1 : 0);
          if (bytes > BOUNDED_READ_MAX_FILE_BYTES) throw new Error(`test_fit_read: ${path} exceeds 8 MiB`);
          parts.push(file.content);
          if (file.lineEnd > 100000) throw new Error(`test_fit_read: ${path} could not be read completely`);
          if (!file.truncated) return parts.join("\n");
          if (!Number.isInteger(file.lineEnd) || file.lineEnd <= offset) throw new Error(`test_fit_read: ${path} could not be read completely`);
          offset = file.lineEnd;
          sha = file.sha256;
        }
      };
      const editedTests = referenceTestEdits((candidate.produced ?? []).map((path) => ({ path, status:"M" }))).slice(0, 20);
      const editedScripts = checkScriptEdits(candidate.produced ?? [], input.task.verification.map((row) => row.command)).slice(0, 10);
      const fitConfigs = (candidate.produced ?? []).filter((path) => /(^|\/)package\.json$|\.(?:sh|ya?ml)$/.test(path)).slice(0, 10);
      // An attempt that worked in the project folder itself has no base copy: the «before» is git's, see headSides.
      const workedAt = fitAttempt?.workspace_path;
      const inPlace = !!workedAt && [basePathForTests, getRun(db, input.runId)?.writer_workspace_path].some((path) => !!path && resolve(path) === resolve(workedAt));
      const liveFolder = isLiveDecision(fitAttempt?.workspace_decision);
      // One observation per path: a transient failure cannot disappear between the yardstick, critic and test_fit.
      const liveBaselines = new Map<string, ReturnType<typeof readLiveBefore>>();
      const liveBackup = liveFolder && workedAt ? resolveLiveBackupId(bb.storage.kv as never, input.attemptId) : undefined;
      const liveBefore = liveFolder && workedAt ? (path:string) => {
        let saved = liveBaselines.get(path);
        if (!saved) {
          saved = (liveBackup ?? Promise.resolve({ reason:"workspace_unavailable" as const })).then((binding) =>
            "backupId" in binding
              ? readLiveBefore(host, input.config.hostId, workedAt, binding.backupId, path)
              : { state:"unknown" as const, reason:binding.reason });
          liveBaselines.set(path, saved);
        }
        return saved;
      } : undefined;
      const atHead = inPlace && !liveFolder
        ? await headSides(bb, db, { runId:input.runId, taskId:input.taskId, hostId:input.config.hostId, cwd:workedAt, paths:[...new Set([...editedTests, ...editedScripts, ...fitConfigs])] })
        : new Map<string, string | null>();
      const readBefore = async (path:string):Promise<string | null | undefined> => {
        if (liveFolder) {
          const saved = await liveBefore?.(path);
          return saved?.state === "bytes" ? saved.content : undefined;
        }
        const head = atHead.get(path);
        if (head !== undefined && head !== null && (Buffer.byteLength(head, "utf8") > BOUNDED_READ_MAX_FILE_BYTES || head.split("\n").length > 100000)) {
          throw new Error(`test_fit_read: ${path} HEAD exceeds the complete-read limit`);
        }
        return head === undefined ? readFit(basePathForTests, path) : head;
      };
      const referenceBefore = new Map<string, string>();
      const referenceTests: string[] = [];
      for (const path of editedTests) {
        const before = await readBefore(path);
        if (before !== null) referenceTests.push(path);
        if (typeof before === "string") referenceBefore.set(path, before);
      }
      const checkScripts: string[] = [];
      for (const path of editedScripts) {
        if (await readBefore(path) !== null) checkScripts.push(path);
      }
      const yardstick = [...referenceTests, ...checkScripts];
      const liveCritiquePolicy = frozenPolicy ?? parseCodeCritiqueSettings(withReferenceTestCritic(applyCodeCriticDefault(applyQualityMode(projectSettings,qualityMode),qualityMode,input.task.risk,criticDefault), yardstick));
      // Other tasks of this run whose code critique passed «approve»: the repeat skip below reads their freshness and owns_paths.
      const priorCriticApprovals = listStageReceipts(db, input.runId)
        .filter((row) => row.stageId === "code-critique" && row.taskId !== input.taskId)
        .map((row) => {
          const owns = (getTask(db, row.taskId)?.contract as { owns_paths?: unknown } | undefined)?.owns_paths;
          return { taskId:row.taskId, ownsPaths:Array.isArray(owns) ? owns as string[] : [], state:row.state,
            decision:(row.result as { decision?: unknown } | null)?.decision, updatedAt:row.updatedAt };
        });
      const baselineHashes = Object.fromEntries(input.dirtBefore.map((row) => [row.path, row.sha256 || null]));
      let lastPatches: Record<string, string> | undefined;
      let criticNotes = "";
      // The code critic's gate: evidence, repair rounds and the barrier archive live in critique-gate.ts; its shared
      // locals ride the g bag and are read back below.
      const g: CritiqueGateState = {
        candidate, writerThreadId, review, repairRound, previousFindings, lastArtifact, approvedArtifact:"",
        frozenPolicy, repeatSkipChecked:false, lastPatches, criticNotes,
      };
      const gateEnd = await runCodeCritiqueGate({ ctx, services, input, endedByStop, existingCritique, storedLedger,
        liveCritiquePolicy, projectSettings, taskCriticDefault, yardstick, priorCriticApprovals, baselineHashes, liveBefore }, g);
      if (gateEnd) return { kind: "terminal", result: gateEnd };
      if (liveFolder) {
        for (const path of g.candidate.produced ?? []) {
          const saved = await liveBefore?.(path);
          if (!saved || saved.state === "unknown") {
            const reason = `live_backup_before_unknown: ${path}: ${saved?.reason ?? "workspace_unavailable"}`.slice(0, 500);
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { kind: "terminal", result: { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:g.writerThreadId } };
          }
        }
      }
      candidate = g.candidate; writerThreadId = g.writerThreadId; review = g.review; lastPatches = g.lastPatches; criticNotes = g.criticNotes;
      { const stopped = stoppedMeanwhile("the code critique", writerThreadId); if (stopped) return { kind: "terminal", result: stopped }; }
      // The plan against the fact: code checks the writer's evidence per acceptance item against the diff, never its prose.
      if (candidate.output?.trim() && candidate.output !== answer) await recordWriterReport(ctx, input, candidate.output);
      const planFact = await runPlanFactStage(ctx, { projectId:input.projectId, runId:input.runId, taskId:input.taskId, attempt:countAttempts(db,input.runId,input.taskId),
        hostId:input.config.hostId, task:input.task, answers:[candidate.output, answer], attemptId:input.attemptId, produced:candidate.produced ?? [], verification:candidate.verification ?? [] })
        .catch((cause:unknown) => { ctx.log(`plan-fact: ${input.taskId} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      const refusal = planFact?.refusal ?? null;
      if (refusal) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"plan_fact_unproven",reason:refusal}});
        const stopped = endedByStop(refusal, writerThreadId);
        if (stopped) return { kind: "terminal", result: stopped };
        transitionAttempt(db, input.attemptId, "validation_failed", { reason:refusal });
        return { kind: "terminal", result: { status:"validation_failed", reason:refusal, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId } };
      }
      // Checkable conventions (SMA k_lib_gates): rules.gates on the project, a warning on the card by default and a
      // refusal only where a rule says block. Hits land on lines the diff added in matching paths.
      const conventionGates = (projectSettings["rules.gates"] ?? []) as ConventionGate[];
      if (Array.isArray(conventionGates) && conventionGates.length) {
        const gateHits = conventionGateHits(conventionGates, lastPatches ?? {});
        if (gateHits.blocks.length) {
          const reason = `convention_gate: ${gateHits.blocks.join("; ")}`.slice(0, 500);
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"convention_gate",reason}});
          transitionAttempt(db, input.attemptId, "validation_failed", { reason });
          return { kind: "terminal", result: { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId } };
        }
        if (gateHits.warnings.length) candidate.warnings = [...(candidate.warnings ?? []), ...gateHits.warnings.map((hit) => `convention_gate: ${hit}`)];
      }
      // Approach and lesson markers warn. A weakened test (test_fit) blocks acceptance; any other edit of a test that already existed stays a warning.
      const markers = writerMarkers(`${candidate.output ?? ""}\n${answer}`);
      const testEdits = referenceTests;
      const fitFiles: Array<{ path:string; before:string | null; after:string | null }> = [];
      for (const [path, before] of referenceBefore) fitFiles.push({ path, before, after: await readFit(fitAttempt?.workspace_path, path) });
      for (const path of fitConfigs) {
        const before = await readBefore(path);
        if (before !== undefined) fitFiles.push({ path, before, after: await readFit(fitAttempt?.workspace_path, path) });
      }
      const fitHits = testFitFindings(fitFiles, input.task.test_removals ?? []);
      // A hit a person already allowed for this very content passes (sma av_test_edit_hold). The rest: where the owner's
      // word is asked for this task, the hand-in is held for him — blocked, worktree kept — until that exact edit is
      // allowed; elsewhere the writer gets the finding back as before and restores the test in its next turn, so a
      // weakened test does not stop a task nobody is waiting to decide on.
      const afterShaOf = (path:string) => sha256Hex(fitFiles.find((file) => file.path === path)?.after ?? "missing");
      const allowance = fitHits.length ? await testEditAllowance(bb.storage.kv as never, input.attemptId) : [];
      const heldHits = fitHits.filter((hit) => !allowance.some((row) => row.path === hit.path && row.afterSha256 === afterShaOf(hit.path)));
      const holdForOwner = heldHits.length > 0 && landingWordAsked(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)), input.task.risk, taskStepEvidence(input.task, candidate.produced));
      if (heldHits.length && !holdForOwner) {
        // The refusal names the door: a removal that is the task's purpose goes into the contract's test_removals, and the PM dispatches again.
        const reason = `test_fit: ${heldHits.slice(0, 5).map((hit) => `${hit.path}: ${hit.evidence}`).join("; ")} (if removing these tests is the task, name the files in the contract's test_removals)`.slice(0, 500);
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"test_fit",reason}});
        transitionAttempt(db, input.attemptId, "validation_failed", { reason });
        return { kind: "terminal", result: { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId } };
      }
      if (heldHits.length) {
        const paths = heldHits.slice(0, 5).map((hit) => hit.path);
        const reason = `test_edit_hold: ${paths.join(", ")} (weakened reference tests wait for the owner's allow of that exact edit: ask him, then lane_pilot_update_task {taskId, allowTestEdits:true}; a removal that is the task goes into the contract's test_removals)`.slice(0, 500);
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"test_edit_hold",reason}});
        await bestEffort(ctx.log, "test edit hold record", bb.storage.kv.set(testEditHoldKey(input.attemptId),
          heldHits.map((hit) => ({ path:hit.path, afterSha256:afterShaOf(hit.path) })) as never), undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        noteToldPmDirectly(db, input.pmThreadId, input.taskId);
        const holdOutcomes = listUnreportedTaskOutcomes(db, 0).filter((o) => o.pmThreadId === input.pmThreadId && o.taskId === input.taskId);
        if (holdOutcomes.length > 0) markTaskOutcomesReported(db, holdOutcomes, Date.now());
        postOwnerItem(db as never, { key:`${TEST_EDIT_HOLD_ITEM}${input.attemptId}`, source:"writer", kind:"test_edit_hold", reason:"decision", projectId:input.projectId, wake:false,
          what:`Исполнитель ослабил проверочный тест (${paths.join(", ")}) — сдача ждёт вашего разрешения`, why:reason.slice(0, 600) });
        await bestEffort(ctx.log, "test edit hold notice", sendServiceMessage(bb, { threadId:input.pmThreadId,
          text:`Lane Pilot: task ${input.taskId} weakened reference tests (${paths.join(", ")}) and its hand-in waits for the owner. Ask him; on his yes allow that exact edit with lane_pilot_update_task {taskId:"${input.taskId}", allowTestEdits:true}, or redispatch with the files in test_removals if removing them is the task.` }), undefined);
        return { kind: "terminal", result: { status:"blocked", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId } };
      }
      const markerWarnings = [
        ...(!markers.approach ? ["the report has no APPROACH line"] : []),
        ...(!markers.lesson && !markers.noLessonReason ? ["the report has no LESSON line (a lesson, or none with the reason)"] : []),
        ...(testEdits.length ? [`the writer changed tests that existed before the attempt (reference tests): ${testEdits.join(", ")} — the code critic reviews them in gate mode`] : []),
        ...(criticNotes ? [criticNotes] : []),
      ];
      // The execution checklist, one row on the attempt (sma ag_checklist): the promise flags, the stagnation
      // (prior turns that ended on the same failure key), the scope reads and the reference-test edits, together —
      // they ride the attempt's one accept row (recorded at the acceptance below), so the gate list shows them in one place.
      const checklist = executionChecklist({ markers, planFact,
        priorReasons: priorAttemptStates(db, input.runId, input.taskId, input.attemptId).map((row) => row.reason).filter((r): r is string => typeof r === "string"),
        produced: candidate.produced ?? [], ownsPaths: input.task.owns_paths ?? [], referenceTestEdits: testEdits });
      // The diagnostic progress journal beside QA.md (sma k_lib_workerprog): files touched and commands run,
      // every cut marked. Kept in the run's bookkeeping folder beside the task's receipts, never in the attempt's checkout:
      // a worktree is removed with the attempt, and the journal went with it (0 journals for 66 accepted tasks, 2026-11-11).
      {
        const journalWorkspace = getRun(db, input.runId)?.writer_workspace_path ?? input.task.project_cwd;
        const homed = hasTaskHome(db, input.taskId);
        if (journalWorkspace || homed) {
          const journalEvents = await bestEffort(ctx.log, "progress journal events", Promise.resolve().then(() => listThreadEventsRaw(bb, { threadId: input.writerThreadId, order: "asc", limit: "500" } as never)), null);
          const journal = progressJournal({ attemptId: input.attemptId, taskId: input.taskId, produced: candidate.produced ?? [], events: (journalEvents as { events?: Array<Record<string, unknown>> } | null)?.events ?? [],
            truncated: ((journalEvents as { events?: Array<Record<string, unknown>> } | null)?.events ?? []).length >= 500 });
          // A task with a home keeps its journal in the attempt's folder there (docs/task-folder.md), not in the run's shared artifacts.
          if (homed) await bestEffort(ctx.log, "progress journal record", recordTaskHomeFile(ctx, { taskId:input.taskId, kind:"progress", name:`attempts/${input.attemptId}/PROGRESS.md`, content:journal,
            attemptId:input.attemptId, producer:{ node:"finish", graph:"lp-task-pipeline", stage_id:"writer-agent", run_id:input.runId, attempt_id:input.attemptId }, readers:["lessons"] }), null);
          else if (journalWorkspace) await bestEffort(ctx.log, "progress journal write", writeReplacing(bb.sdk.files, { hostId:input.config.hostId, rootPath:journalWorkspace,
            path:`${acceptanceArtifactDir(journalWorkspace, input.runId, input.taskId)}/PROGRESS.md`,
            content:journal, createParents:true }), undefined);
        }
      }
      if (markerWarnings.length) candidate.warnings = [...(candidate.warnings ?? []), ...markerWarnings];
      // The approach note the window's task screen shows (the gate keeps only the hash of its summary).
      await bestEffort(ctx.log, "writer approach record", recordTaskApproach(bb.storage.kv, input.runId, input.taskId, { approach:markers.approach, lesson:markers.lesson, noLessonReason:markers.noLessonReason, referenceTestEdits:testEdits, at:Date.now() }), undefined);
      // Stage questions from files and the execution checkpoint: the task folder's QUESTIONS.md and CHECKPOINT.md, read from the attempt's copy.
      const attemptRow = fitAttempt;
      const folderOf = (name:"QUESTIONS.md"|"CHECKPOINT.md") => writerNotePath(db, input.taskId, input.attemptId, name);
      const readTaskFile = async (name:"QUESTIONS.md"|"CHECKPOINT.md") => attemptRow?.workspace_path ? await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:attemptRow.workspace_path, relativePath:folderOf(name), offset:0, maxLines:200 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null) : null;
      const questionsText = await readTaskFile("QUESTIONS.md");
      const checkpoint = await readTaskFile("CHECKPOINT.md");
      // The writer's notes come back into the task's record by plugin code: the worktree they were written in goes at the merge.
      await keepWriterNotes(ctx, input, { "QUESTIONS.md":questionsText, "CHECKPOINT.md":checkpoint });
      const fileQuestions = questionsText ? questionsFromFile(questionsText) : [];
      if (fileQuestions.length || checkpoint) {
        await bestEffort(ctx.log, "writer questions record", recordTaskQuestions(bb.storage.kv, input.runId, input.taskId, { questions:fileQuestions, checkpoint:checkpoint?.slice(0, 2000) ?? null, at:Date.now() }), undefined);
        if (fileQuestions.length) candidate.warnings = [...(candidate.warnings ?? []), `the writer left ${fileQuestions.length} question(s) in QUESTIONS.md: ${fileQuestions.map((row) => `[${row.kind}] ${row.question}`).join("; ").slice(0, 600)}`];
      }
      // Drawing unchanged: the drawing a task follows is its input, not its output; a writer that edited it changed the yardstick.
      const drawingTouched = (input.task.drawing ?? []).filter((path) => (candidate.produced ?? []).some((changed) => changed.replace(/^\.\//, "") === path.replace(/^\.\//, "")));
      if (drawingTouched.length) {
        const reason = `drawing_changed: the task follows the drawing ${drawingTouched.join(", ")} and must not change it; undo those edits (the drawing is changed in the phase's design stage)`;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"drawing_changed",reason}});
        transitionAttempt(db, input.attemptId, "validation_failed", { reason });
        return { kind: "terminal", result: { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId } };
      }
      // A model's opinion alone never accepts a task: some stage decided by code (the ownership and output gates, the checks)
      // must have passed for this candidate. The code critic's «passed» is advisory (STAGE_PROOF).
      const provenBy:StageId[] = [];
      if (candidate.status === "accepted") provenBy.push("writer-agent");
      const checks = candidate.verification ?? [];
      if (checks.length > 0 && checks.every((row) => row.exitCode === 0)) provenBy.push("verification");
      if (review === "passed") provenBy.push("code-critique");
      // Challenge gate (SMA): with critic.challenge_high on, a task of high or critical risk is accepted only after the code critic passed it.
      const challengeOn = String(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))["critic.challenge_high"] ?? "off") === "on";
      if (challengeOn && (input.task.risk === "high" || input.task.risk === "critical") && review !== "passed") {
        const reason = `challenge_gate: a ${input.task.risk}-risk task needs the code critic's pass before acceptance (critic.challenge_high is on); the critic ${review ?? "did not run"}`;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"challenge_gate",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { kind: "terminal", result: { status:"blocked", reason, attemptId:input.attemptId, writerThreadId } };
      }
      const proofGap = acceptanceProofGap(provenBy);
      if (proofGap) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"no_code_proof",reason:proofGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:proofGap });
        return { kind: "terminal", result: { status:"blocked", reason:proofGap, attemptId:input.attemptId, writerThreadId } };
      }
      // The owner's word before landing (SMA: Approving, Authorized by a person): with owner.words on, a verified task waits here,
      // in place and with its worktree, for the owner's yes the PM records (lane_pilot_queue word); a no or six silent hours block it.
      // On owner.words=risky only a task of risk high waits; on sensitive (the default) only a task in the money / data / production-deploy classes (tasks/sensitive.ts).
      // What of the work's shape a person must see: top-level folders the base did not have, and test files the base
      // did not have that import none of the task's own files. Reads are bounded; a failure flags nothing.
      const attemptShapeFlags = async ():Promise<string[]> => {
        try {
          const produced = (candidate.produced ?? []).map((path) => path.replace(/^\.\//, ""));
          if (!produced.length || !basePathForTests) return [];
          const listed = await runOnHost(host, { hostId:input.config.hostId, cwd:basePathForTests, command:"git ls-tree --name-only HEAD 2>/dev/null || ls -1A", timeoutSec:20, timeoutMs:25_000 });
          if (listed.exitCode !== 0 || typeof listed.stdout !== "string") return [];
          const baseTopLevel = new Set(listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
          const newTests: Array<{ path:string; imports:string[] }> = [];
          for (const path of produced) {
            if (!TEST_PATH.test(path) || await readBefore(path) !== null) continue;
            const content = await readFit(workedAt ?? input.task.project_cwd, path);
            newTests.push({ path, imports:content ? testOwnedImports(path, content, input.task.owns_paths) : [] });
          }
          return shapeFlags({ changedPaths:produced, baseTopLevel, newTests });
        } catch { return []; }
      };
      const wordSettings = loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId));
      // Shape of the work (SMA ag_shape): a new top-level folder or a test that only tests itself is named to the person
      // in the landing word. Only on owner.words=on, where every landing waits for him anyway: on risky and sensitive a
      // new test that imports through an alias, or any Python or Go test, would hold an ordinary task for six hours.
      const shape = ownerWordsMode(wordSettings) === "on" ? await attemptShapeFlags() : [];
      const sensitive = ownerWordsMode(wordSettings) === "sensitive" ? sensitiveHits(taskStepEvidence(input.task, candidate.produced)) : [];
      const ownerWords = landingWordAsked(wordSettings, input.task.risk, taskStepEvidence(input.task, candidate.produced)) || shape.length > 0;
      const wordsOf = async () => ((await bb.storage.kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null)?.[taskWordKey(input.runId, taskFamily(input.taskId))];
      { const stopped = stoppedMeanwhile("the plan-fact check", writerThreadId); if (stopped) return { kind: "terminal", result: stopped }; }
      let wordGap = landingWordGap(ownerWords, await wordsOf(), input.attemptId);
      if (wordGap && !wordGap.includes("said no")) {
        // The lead's journal: the question opens here and the prediction is written before the owner answers (src/rooms/lead).
        void services.taskWords.ask(db, { runId:input.runId, projectId:input.projectId, family:taskFamily(input.taskId), task:input.task }, loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)) as Record<string, unknown>);
        // The wait is a row on «Ждут владельца» with да / нет (Astra F-004, Gemini F-008: the screen that promises to show what waits did not
        // show this); the word closes it (answerTaskWord), the end of the wait below closes it too.
        try {
          const wordInput = (decision:"yes"|"no") => ({ runId:input.runId, taskId:input.taskId, decision, text: decision === "yes" ? "Да, сливайте" : "Нет, не сливать" });
          postOwnerItem(db as never, { key:`${taskWordItemPrefix(input.runId, taskFamily(input.taskId))}${input.attemptId}`, source:"writer", kind:"task_word", reason:"decision", projectId:input.projectId, wake:false,
            what:`Задача проверена и ждёт вашего слова перед слиянием: ${input.task.title}`,
            why:`${sensitive.length ? `Задача затрагивает ${sensitive.map((hit) => SENSITIVE_RU[hit.cls]).join(", ")} (${sensitive[0]!.evidence.slice(0, 120)})` : `Риск задачи ${input.task.risk}`}: по вашему правилу такая работа не сливается без вашего «да».${shape.length ? ` Форма работы: ${shape.join(", ")}.` : ""} Без ответа за ${Math.round(OWNER_WORD_WAIT_MS / 3_600_000)} часов она остановится, и её можно будет отправить снова.`,
            evidence:[{ kind:"attempt", ref:input.attemptId }, { kind:"task", ref:input.taskId }],
            actions:[{ id:"yes", label:"Да, сливать", cli:rpcLine("task_word", wordInput("yes")), rpc:{ method:"task_word", input:wordInput("yes") } },
              { id:"no", label:"Нет", cli:rpcLine("task_word", wordInput("no")), rpc:{ method:"task_word", input:wordInput("no") } }] });
        } catch { /* the list is a mirror; the wait itself goes on */ }
        void bestEffort(ctx.log, "writer owner word notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
          text:`Lane Pilot: task ${input.taskId} passed its checks and waits for the owner's word before it lands on main (owner.words asks it for this task: ${sensitive.length ? `${sensitive.map((hit) => hit.cls).join("+")} — ${sensitive[0]!.evidence}` : `risk ${input.task.risk}`}). Ask him with lane_pilot_ask_owner, then record his answer with lane_pilot_queue {action:"word", taskId:"${input.taskId}", decision:"yes"|"no", text}. It waits up to 6 hours; no need to resend it.` }), undefined);
        if (params.parkOwnerWord) {
          return { kind: "wait_owner_word", candidate, writerThreadId };
        }
        // Up to six hours of waiting held a writer seat of the pool for nothing (Gemini F-008.2): the seat goes back now; `admitted` and the
        // live key stay, they protect the task's files until the word lands or the wait ends.
        input.releaseSlot?.();
        const since = Date.now();
        while (wordGap && !wordGap.includes("said no") && Date.now() - since < OWNER_WORD_WAIT_MS && !ctx.isDisposed()) {
          await new Promise((wake) => setTimeout(wake, 60_000));
          const stopped = stoppedMeanwhile("the owner's word", writerThreadId);
          if (stopped) { closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(input.runId, taskFamily(input.taskId)), "stopped:attempt"); return { kind: "terminal", result: stopped }; }
          wordGap = landingWordGap(ownerWords, await wordsOf(), input.attemptId);
        }
        closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(input.runId, taskFamily(input.taskId)), wordGap ? "closed:wait over" : "closed:answered");
      }
      if (wordGap) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"owner_word",reason:wordGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:wordGap });
        return { kind: "terminal", result: { status:"blocked", reason:wordGap, attemptId:input.attemptId, writerThreadId } };
      }
      { const stopped = stoppedMeanwhile("the acceptance", writerThreadId); if (stopped) return { kind: "terminal", result: stopped }; }
      return { kind: "passed", candidate, writerThreadId, review, checklist };
}
