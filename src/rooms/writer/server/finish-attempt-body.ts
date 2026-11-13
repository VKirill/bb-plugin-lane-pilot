import { breakerKey } from "@lane-pilot/resilience";
import { writerLeftWorktree } from "./left-worktree";
import { countAttempts, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTask, listStageReceipts, loadProjectSettings, noteAttemptStream, priorAttemptStates, transitionAttempt, taskBasePath, failureFieldsOf } from "../../storage";
import {providerLimitNotice} from "@lane-pilot/models";
import { actionableFindings, parseCodeCritiqueSettings, repairLedgerFromResult } from "../../critique";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode, withReferenceTestCritic } from "../../contracts/quality-mode";
import { loadCriticCodeDefault } from "./critic-override";
import { runPlanFactStage } from "./plan-fact";
import { headSides } from "../../critique/server";
import { recordGateEvaluation } from "../../runs/server";
import {bestEffort, outputText, sha256Hex, stringAt} from "@lane-pilot/kit";
import { wasAnsweredByDefault } from "./question-default";
import { appendTaskQa } from "./reopen-attempt";
import {needsHumanQuestion, providerStreamError, WRITER_STREAM_ERROR} from "./writer-task";
import { conventionGateHits, type ConventionGate } from "../../session-hooks";
import { OWNER_WORD_WAIT_MS, TASK_WORDS_KEY, TEST_PATH, acceptanceArtifactDir, acceptanceProofGap, landingWordGap, landingWordAsked, ownerWordsMode, questionsFromFile, checkScriptEdits, recordTaskApproach, recordTaskQuestions, referenceTestEdits, shapeFlags, taskWordKey, TEST_EDIT_HOLD_ITEM, testEditAllowance, testEditHoldKey, testFitFindings, testOwnedImports, writerMarkers } from "../../tasks";
import type { TaskWord } from "../../tasks";
import type { StageId } from "../../tasks";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { resolve } from "node:path";
import type { ServerCore } from "../../contracts/server";

import { taskFamily } from "@lane-pilot/contracts";
import { sendServiceMessage } from "../../relay/server";
import { taskWordItemPrefix } from "../../contracts";
import { closeOwnerItemsByPrefix, postOwnerItem, rpcLine } from "../../owner-waiting";
import { runOnHost } from "@lane-pilot/host-calls";
import type { AttemptFinished } from "./attempt-finished";
import { progressJournal } from "../progress-journal";
import { mountVerificationAttemptFinished } from "./verification";
import { executionChecklist } from "./execution-checklist";

import type { FinishInput, Services } from "./finish-types";
import { runCodeCritiqueGate } from "./critique-gate";
import { mergeAcceptedAttempt } from "./finish-merge";
import { watchWriterRun } from "./watch-writer";


export async function finishWriterAttemptBody(ctx: ServerCore, services: Services, verification: ReturnType<typeof mountVerificationAttemptFinished>, input: FinishInput, facts: Pick<AttemptFinished, "writerStopped">): Promise<Record<string,unknown>> {
  const { bb, db, getThreadBounded, host } = ctx;
    // The PM's stop and a failure can land together: an attempt whose stop was requested ends canceled whatever failed
    // (cancel_requested has only canceled, blocked and accepted to go to, and the owner asked for the stop).
    const endedByStop = (reason:string, threadId = input.writerThreadId):Record<string,unknown>|null => {
      if (getAttempt(db, input.attemptId)?.state !== "cancel_requested") return null;
      transitionAttempt(db, input.attemptId, "canceled", { threadId, reason:`writer stop observed after: ${reason}`.slice(0, 500) });
      return { status:"canceled", attemptId:input.attemptId, writerThreadId:threadId };
    };
    // The PM's stop can land after validation passed (cab-unslop-kit.2, 2026-10-31: canceled 8 s after its validate gate). The row was
    // canceled by cancel.ts while this finish went on: it ran the critics, told the PM «passed its checks, waits for the owner's word»,
    // held the task's files for 32 min (start.ts `admitted`, so the sibling task queued behind it), and after the word died on the
    // removed worktree and parked a canceled task. Every stage boundary after validation reads the row first.
    const stoppedMeanwhile = (where:string, threadId = input.writerThreadId):Record<string,unknown>|null => {
      const state = getAttempt(db, input.attemptId)?.state;
      if (state === "cancel_requested") return endedByStop(where, threadId);
      return state === "canceled" ? { status:"canceled", attemptId:input.attemptId, writerThreadId:threadId } : null;
    };
    const providerFailed = (reason:string) => {
      const stopped = endedByStop(reason);
      if (stopped) return stopped;
      transitionAttempt(db, input.attemptId, "provider_error", { reason });
      return { status:"provider_error", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
    };
    // A provider limit the OpenCode log named holds the writer's provider/model open until its reset time (else the cooldown).
    const holdProviderLimit = (until?:number) => {
      const trace = getReasoningTrace(db, input.attemptId);
      if (trace) services.providerBreaker.record(breakerKey(trace.providerId, trace.model), "exhausted", Date.now(), until);
    };
    let endMerge = () => undefined as void;
    try {
      const watched = await watchWriterRun({ ctx, services, input, facts, providerFailed, holdProviderLimit });
      if (watched) return watched;
      const currentAttempt = getAttempt(db, input.attemptId);
      if (currentAttempt?.state === "cancel_requested" || currentAttempt?.state === "canceled") {
        if (currentAttempt.state === "cancel_requested") transitionAttempt(db, input.attemptId, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed before validation" });
        return { status:"canceled", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      // A writer that moved its thread out of its worktree did its work elsewhere (maybe the main checkout): nothing to
      // validate here and no retry in place; the PM learns where the edits went.
      const left = await writerLeftWorktree(bb.sdk as never, input.writerThreadId, currentAttempt?.workspace_path ?? input.config.writerWorkspacePath);
      if (left) {
        const reason = `writer_left_worktree: the writer thread moved to ${left}; its edits there are not this task's — check that folder and redispatch`;
        bb.log.warn(`Lane Pilot ${input.taskId}: ${reason}`);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      // A writer that stopped to ask the owner is not a failed attempt: no retry, no fallback, the question goes to the PM.
      const answer = outputText(await bb.sdk.threads.output({ threadId:input.writerThreadId }).catch((cause: unknown) => { ctx.log(`writer ${input.taskId}: thread output unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return ""; }));
      // The run's stream on the attempt dossier (SMA ar_run_dir): hashed and excerpted, kept on the trace.
      // A dossier note is never a reason to fail the finish: a database or parse error is logged and the finish goes on.
      try { noteAttemptStream(db, input.attemptId, answer); }
      catch (cause) { ctx.log(`writer ${input.taskId}: stream note not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
      // The provider's own limit notice instead of a report: the task never ran, so another model takes it, uncharged.
      const limit = providerLimitNotice(answer);
      if (limit) {
        const reason = `writer_provider_limit: ${limit}`;
        return providerFailed(reason);
      }
      // The provider cut the turn off mid-work: no answer to check yet; the same writer continues in place (sticky.ts).
      const dropped = providerStreamError(answer);
      if (dropped) return providerFailed(`${WRITER_STREAM_ERROR}: ${dropped}`);
      const question = needsHumanQuestion(answer);
      if (question) {
        // Asked again after the machine's default answer (question-timeout.ts): nobody is coming, the attempt ends and frees the task.
        const askedAgain = await wasAnsweredByDefault(bb.storage.kv as never, input.runId, input.taskId);
        const reason = askedAgain ? `verdict_block: question_unanswered: the writer asked again after the default answer. It asked: ${question}` : `needs_human: ${question}`;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"skipped",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{reason:"needs_human"}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        // The parked question is a file in the task folder, not only attempt.reason: a person, the next session or a
        // reload sees what the writer waits for; a CHECKPOINT.md the writer left is kept with it (sma m_q_exec_ckpt).
        const parkedWorkspace = getAttempt(db, input.attemptId)?.workspace_path ?? input.config.writerWorkspacePath;
        if (parkedWorkspace) {
          await appendTaskQa(bb, { hostId:input.config.hostId, workspacePath:parkedWorkspace, taskId:input.taskId, question });
          const checkpoint = await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:parkedWorkspace,
            relativePath:`.agents/plans/items/${input.taskId}/CHECKPOINT.md`, offset:0, maxLines:200 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null);
          if (checkpoint) await bestEffort(ctx.log, "writer questions record", recordTaskQuestions(bb.storage.kv, input.runId, input.taskId,
            { questions:[{ kind:"open", question }], checkpoint:checkpoint.slice(0, 2000), at:Date.now() }), undefined);
        }
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const checked = await services.validateWriterResult({
        config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:input.writerThreadId, attemptId:input.attemptId,
        dirtBefore:input.dirtBefore,
      });
      if (checked.status !== "accepted") {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:checked.status}});
        const stopped = endedByStop(checked.reason ?? checked.status);
        if (stopped) return stopped;
        transitionAttempt(db, input.attemptId, checked.status, { reason:checked.reason, ...failureFieldsOf(checked) });
        return { ...checked, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      { const stopped = stoppedMeanwhile("validation"); if (stopped) return stopped; }
      let candidate = checked;
      let writerThreadId = input.writerThreadId;
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
      // ponytail: the first 400 lines only. A deletion past that line is missed; raise the cap if a real test file is longer.
      const readFit = (cwd:string | null | undefined, path:string) => cwd
        ? host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:cwd, relativePath:path, offset:0, maxLines:400 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null)
        : Promise.resolve(null);
      const editedTests = referenceTestEdits((candidate.produced ?? []).map((path) => ({ path, status:"M" }))).slice(0, 20);
      const editedScripts = checkScriptEdits(candidate.produced ?? [], input.task.verification.map((row) => row.command)).slice(0, 10);
      const fitConfigs = (candidate.produced ?? []).filter((path) => /(^|\/)package\.json$|\.(?:sh|ya?ml)$/.test(path)).slice(0, 10);
      // An attempt that worked in the project folder itself has no base copy: the «before» is git's, see headSides.
      const workedAt = fitAttempt?.workspace_path;
      const inPlace = !!workedAt && [basePathForTests, getRun(db, input.runId)?.writer_workspace_path].some((path) => !!path && resolve(path) === resolve(workedAt));
      const atHead = inPlace
        ? await headSides(bb, db, { runId:input.runId, taskId:input.taskId, hostId:input.config.hostId, cwd:workedAt, paths:[...new Set([...editedTests, ...editedScripts, ...fitConfigs])] })
        : new Map<string, string | null>();
      const readBefore = (path:string) => {
        const head = atHead.get(path);
        // Cut like readFit cuts the «after», or every assertion past its line 400 would read as removed.
        return head === undefined ? readFit(basePathForTests, path) : Promise.resolve(head === null ? null : head.split("\n").slice(0, 400).join("\n"));
      };
      const referenceBefore = new Map<string, string>();
      for (const path of editedTests) {
        const before = await readBefore(path);
        if (before !== null) referenceBefore.set(path, before);
      }
      const referenceTests = [...referenceBefore.keys()];
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
      const g: import("./critique-gate").CritiqueGateState = {
        candidate, writerThreadId, review, repairRound, previousFindings, lastArtifact, approvedArtifact:"",
        frozenPolicy, repeatSkipChecked:false, lastPatches, criticNotes,
      };
      const gateEnd = await runCodeCritiqueGate({ ctx, services, input, endedByStop, existingCritique, storedLedger,
        liveCritiquePolicy, projectSettings, taskCriticDefault, yardstick, priorCriticApprovals, baselineHashes }, g);
      if (gateEnd) return gateEnd;
      candidate = g.candidate; writerThreadId = g.writerThreadId; review = g.review; lastPatches = g.lastPatches; criticNotes = g.criticNotes;
      { const stopped = stoppedMeanwhile("the code critique", writerThreadId); if (stopped) return stopped; }
      // The plan against the fact: code checks the writer's evidence per acceptance item against the diff, never its prose. It records
      // its stage whatever the outcome; only plan_fact.mode=gate sends an item with no evidence that holds back to the writer.
      const planFact = await runPlanFactStage(ctx, { projectId:input.projectId, runId:input.runId, taskId:input.taskId, attempt:countAttempts(db,input.runId,input.taskId),
        hostId:input.config.hostId, task:input.task, answers:[candidate.output, answer], produced:candidate.produced ?? [], verification:candidate.verification ?? [] })
        .catch((cause:unknown) => { ctx.log(`plan-fact: ${input.taskId} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (planFact?.refusal) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"plan_fact_unproven",reason:planFact.refusal}});
        const stopped = endedByStop(planFact.refusal, writerThreadId);
        if (stopped) return stopped;
        transitionAttempt(db, input.attemptId, "validation_failed", { reason:planFact.refusal });
        return { status:"validation_failed", reason:planFact.refusal, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
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
          return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
        }
        if (gateHits.warnings.length) candidate.warnings = [...(candidate.warnings ?? []), ...gateHits.warnings.map((hit) => `convention_gate: ${hit}`)];
      }
      // Approach and lesson markers warn. A weakened test (test_fit) blocks acceptance; any other edit of a test that already existed stays a warning.
      const markers = writerMarkers(`${candidate.output ?? ""}\n${answer}`);
      const testEdits = referenceTests;
      const fitFiles: Array<{ path:string; before:string | null; after:string | null }> = [];
      for (const [path, before] of referenceBefore) fitFiles.push({ path, before, after: await readFit(fitAttempt?.workspace_path, path) });
      for (const path of fitConfigs) {
        fitFiles.push({ path, before: await readBefore(path), after: await readFit(fitAttempt?.workspace_path, path) });
      }
      const fitHits = testFitFindings(fitFiles, input.task.test_removals ?? []);
      // A hit a person already allowed for this very content passes (sma av_test_edit_hold). The rest: where the owner's
      // word is asked for this task, the hand-in is held for him — blocked, worktree kept — until that exact edit is
      // allowed; elsewhere the writer gets the finding back as before and restores the test in its next turn, so a
      // weakened test does not stop a task nobody is waiting to decide on.
      const afterShaOf = (path:string) => sha256Hex(fitFiles.find((file) => file.path === path)?.after ?? "missing");
      const allowance = fitHits.length ? await testEditAllowance(bb.storage.kv as never, input.attemptId) : [];
      const heldHits = fitHits.filter((hit) => !allowance.some((row) => row.path === hit.path && row.afterSha256 === afterShaOf(hit.path)));
      const holdForOwner = heldHits.length > 0 && landingWordAsked(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)), input.task.risk);
      if (heldHits.length && !holdForOwner) {
        // The refusal names the door: a removal that is the task's purpose goes into the contract's test_removals, and the PM dispatches again.
        const reason = `test_fit: ${heldHits.slice(0, 5).map((hit) => `${hit.path}: ${hit.evidence}`).join("; ")} (if removing these tests is the task, name the files in the contract's test_removals)`.slice(0, 500);
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"test_fit",reason}});
        transitionAttempt(db, input.attemptId, "validation_failed", { reason });
        return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      if (heldHits.length) {
        const paths = heldHits.slice(0, 5).map((hit) => hit.path);
        const reason = `test_edit_hold: ${paths.join(", ")} (weakened reference tests wait for the owner's allow of that exact edit: ask him, then lane_pilot_update_task {taskId, allowTestEdits:true}; a removal that is the task goes into the contract's test_removals)`.slice(0, 500);
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"test_edit_hold",reason}});
        await bestEffort(ctx.log, "test edit hold record", bb.storage.kv.set(testEditHoldKey(input.attemptId),
          heldHits.map((hit) => ({ path:hit.path, afterSha256:afterShaOf(hit.path) })) as never), undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        postOwnerItem(db as never, { key:`${TEST_EDIT_HOLD_ITEM}${input.attemptId}`, source:"writer", kind:"test_edit_hold", projectId:input.projectId, wake:false,
          what:`Исполнитель ослабил проверочный тест (${paths.join(", ")}) — сдача ждёт вашего разрешения`, why:reason.slice(0, 600) });
        await bestEffort(ctx.log, "test edit hold notice", sendServiceMessage(bb, { threadId:input.pmThreadId,
          text:`Lane Pilot: task ${input.taskId} weakened reference tests (${paths.join(", ")}) and its hand-in waits for the owner. Ask him; on his yes allow that exact edit with lane_pilot_update_task {taskId:"${input.taskId}", allowTestEdits:true}, or redispatch with the files in test_removals if removing them is the task.` }), undefined);
        return { status:"blocked", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      const markerWarnings = [
        ...(!markers.approach ? ["the report has no APPROACH line"] : []),
        ...(!markers.lesson && !markers.noLessonReason ? ["the report has no LESSON line (a lesson, or none with the reason)"] : []),
        ...(testEdits.length ? [`the writer changed tests that existed before the attempt (reference tests): ${testEdits.join(", ")} — the code critic reviews them in gate mode`] : []),
      ];
      if (criticNotes) {
        markerWarnings.push(criticNotes);
        void bestEffort(ctx.log, "writer critic notes notice", sendServiceMessage(bb, { threadId: writerThreadId, senderThreadId: input.pmThreadId, text: criticNotes }), undefined);
      }
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
        if (journalWorkspace) {
          const journalEvents = await bestEffort(ctx.log, "progress journal events", Promise.resolve().then(() => listThreadEventsRaw(bb, { threadId: input.writerThreadId, order: "asc", limit: "500" } as never)), null);
          await bestEffort(ctx.log, "progress journal write", Promise.resolve().then(() => bb.sdk.files.write({ hostId:input.config.hostId, rootPath:journalWorkspace,
            path:`${acceptanceArtifactDir(journalWorkspace, input.runId, input.taskId)}/PROGRESS.md`,
            content:progressJournal({ attemptId: input.attemptId, taskId: input.taskId, produced: candidate.produced ?? [], events: (journalEvents as { events?: Array<Record<string, unknown>> } | null)?.events ?? [],
              truncated: ((journalEvents as { events?: Array<Record<string, unknown>> } | null)?.events ?? []).length >= 500 }),
            contentEncoding:"utf8", createParents:true, expectedSha256:null })), undefined);
        }
      }
      if (markerWarnings.length) candidate.warnings = [...(candidate.warnings ?? []), ...markerWarnings];
      // The approach note the window's task screen shows (the gate keeps only the hash of its summary).
      await bestEffort(ctx.log, "writer approach record", recordTaskApproach(bb.storage.kv, input.runId, input.taskId, { approach:markers.approach, lesson:markers.lesson, noLessonReason:markers.noLessonReason, referenceTestEdits:testEdits, at:Date.now() }), undefined);
      // Stage questions from files and the execution checkpoint: the task folder's QUESTIONS.md and CHECKPOINT.md, read from the attempt's copy.
      const attemptRow = fitAttempt;
      const folderOf = (name:string) => `.agents/plans/items/${input.taskId}/${name}`;
      const readTaskFile = async (name:string) => attemptRow?.workspace_path ? await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:attemptRow.workspace_path, relativePath:folderOf(name), offset:0, maxLines:200 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null) : null;
      const questionsText = await readTaskFile("QUESTIONS.md");
      const checkpoint = await readTaskFile("CHECKPOINT.md");
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
        return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
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
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
      }
      const proofGap = acceptanceProofGap(provenBy);
      if (proofGap) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"no_code_proof",reason:proofGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:proofGap });
        return { status:"blocked", reason:proofGap, attemptId:input.attemptId, writerThreadId };
      }
      // The owner's word before landing (SMA: Approving, Authorized by a person): with owner.words on, a verified task waits here,
      // in place and with its worktree, for the owner's yes the PM records (lane_pilot_queue word); a no or six silent hours block it.
      // On owner.words=risky (the default) only a task of risk high waits; a low or medium one lands by itself.
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
      // in the landing word. Only on owner.words=on, where every landing waits for him anyway: on the default (risky) a
      // new test that imports through an alias, or any Python or Go test, would hold an ordinary task for six hours.
      const shape = ownerWordsMode(wordSettings) === "on" ? await attemptShapeFlags() : [];
      const ownerWords = landingWordAsked(wordSettings, input.task.risk) || shape.length > 0;
      const wordsOf = async () => ((await bb.storage.kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null)?.[taskWordKey(input.runId, taskFamily(input.taskId))];
      { const stopped = stoppedMeanwhile("the plan-fact check", writerThreadId); if (stopped) return stopped; }
      let wordGap = landingWordGap(ownerWords, await wordsOf(), input.attemptId);
      if (wordGap && !wordGap.includes("said no")) {
        // The lead's journal: the question opens here and the prediction is written before the owner answers (src/rooms/lead).
        void services.taskWords.ask(db, { runId:input.runId, projectId:input.projectId, family:taskFamily(input.taskId), task:input.task }, loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)) as Record<string, unknown>);
        // The wait is a row on «Ждут владельца» with да / нет (Astra F-004, Gemini F-008: the screen that promises to show what waits did not
        // show this); the word closes it (answerTaskWord), the end of the wait below closes it too.
        try {
          const wordInput = (decision:"yes"|"no") => ({ runId:input.runId, taskId:input.taskId, decision, text: decision === "yes" ? "Да, сливайте" : "Нет, не сливать" });
          postOwnerItem(db as never, { key:`${taskWordItemPrefix(input.runId, taskFamily(input.taskId))}${input.attemptId}`, source:"writer", kind:"task_word", projectId:input.projectId, wake:false,
            what:`Задача проверена и ждёт вашего слова перед слиянием: ${input.task.title}`,
            why:`Риск задачи ${input.task.risk}: по вашему правилу такая работа не сливается без вашего «да».${shape.length ? ` Форма работы: ${shape.join(", ")}.` : ""} Без ответа за ${Math.round(OWNER_WORD_WAIT_MS / 3_600_000)} часов она остановится, и её можно будет отправить снова.`,
            evidence:[{ kind:"attempt", ref:input.attemptId }, { kind:"task", ref:input.taskId }],
            actions:[{ id:"yes", label:"Да, сливать", cli:rpcLine("task_word", wordInput("yes")), rpc:{ method:"task_word", input:wordInput("yes") } },
              { id:"no", label:"Нет", cli:rpcLine("task_word", wordInput("no")), rpc:{ method:"task_word", input:wordInput("no") } }] });
        } catch { /* the list is a mirror; the wait itself goes on */ }
        void bestEffort(ctx.log, "writer owner word notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
          text:`Lane Pilot: task ${input.taskId} passed its checks and waits for the owner's word before it lands on main (owner.words asks it for this task: risk ${input.task.risk}). Ask him with lane_pilot_ask_owner, then record his answer with lane_pilot_queue {action:"word", taskId:"${input.taskId}", decision:"yes"|"no", text}. It waits up to 6 hours; no need to resend it.` }), undefined);
        // Up to six hours of waiting held a writer seat of the pool for nothing (Gemini F-008.2): the seat goes back now; `admitted` and the
        // live key stay, they protect the task's files until the word lands or the wait ends.
        input.releaseSlot?.();
        const since = Date.now();
        while (wordGap && !wordGap.includes("said no") && Date.now() - since < OWNER_WORD_WAIT_MS && !ctx.isDisposed()) {
          await new Promise((wake) => setTimeout(wake, 60_000));
          const stopped = stoppedMeanwhile("the owner's word", writerThreadId);
          if (stopped) { closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(input.runId, taskFamily(input.taskId)), "stopped:attempt"); return stopped; }
          wordGap = landingWordGap(ownerWords, await wordsOf(), input.attemptId);
        }
        closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(input.runId, taskFamily(input.taskId)), wordGap ? "closed:wait over" : "closed:answered");
      }
      if (wordGap) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"owner_word",reason:wordGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:wordGap });
        return { status:"blocked", reason:wordGap, attemptId:input.attemptId, writerThreadId };
      }
      { const stopped = stoppedMeanwhile("the acceptance", writerThreadId); if (stopped) return stopped; }
      return await mergeAcceptedAttempt({ ctx, services, input, candidate, writerThreadId, review, checklist, verification,
        endedByStop, setEndMerge:(end) => { endMerge = end; } });
    } catch (cause) {
      const thread = await getThreadBounded(input.writerThreadId);
      if (stringAt(thread, "status") === "error") {
        return providerFailed(cause instanceof Error ? cause.message : String(cause));
      }
      throw cause;
    } finally { endMerge(); }
}
