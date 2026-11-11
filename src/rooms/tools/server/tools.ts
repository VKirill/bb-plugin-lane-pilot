import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { secretShaped } from "../../tasks";
import type { BacklogApi } from "../../backlog/server";
import type { VerificationGatePort } from "../../contracts/integration-gate";
import type { IsTaskSatisfied } from "../../contracts";
import type { StageHelperSettings, WorkflowEngineApi, WorkflowTriggersApi } from "../../platform/server";
import { gateVocabularyLines } from "../../contracts";
import { registerBrowserExecutors, runBrowserQaGraph } from "../../qa/server";
import { cancelAttemptById, cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees, closeEndedAttempt } from "../../runs/server";
import { bestEffort, LANE_PILOT_READ_NAME } from "@lane-pilot/kit";
import { taskV2Schema, TASK_KINDS } from "../../contracts";
import { getRun, getRunSettingsScopes, listAttemptsForTask, listEndedTaskIds, listOpenAttempts, listStageReceipts, loadProjectSettings, loadPrototypeConfig, markCancelCode, noteToldPmDirectly, setTaskClosedWords, transitionAttempt } from "../../storage";
import { FAILED_ATTEMPT_STATES } from "../../contracts";
import { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun, writerWorkspaceForPmInstructions } from "../../native-agent";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../../native-agent";
import { readGateReport } from "../../tasks/gate-report";
import { historySearch } from "../../memory-tiers/server";
import { mountHandoff } from "../../relay/server";
import { mountInsights } from "../../self-repair/server";
import { mountHealth } from "../../stability/server";
import { mountCouncilTools } from "../../council/server";
import { mountSpecialists, SPECIALIST_ROLES } from "../../critique/server";
import { installEmployeeSpecialists } from "../../contracts/employee-manifest";
import { mountRelay, ownerLocale } from "../../relay/server";
import { ownerAnswerText } from "../owner-answer-text";
import { mountWorkflowTools } from "../../workflow/server";
import { mountSelfRepair } from "../../self-repair/server";
import { mountHookTimeoutWatch, mountPmTurnWatch, mountServiceProjects, mountWorktreeJanitor } from "../../stability/server";
import { mountWorkflowArchitect } from "../../workflow/server";
import { mountLeadTool } from "../../lead/server";
import { mountScheduleTools } from "../../schedule/server";
import { mountToolFamilies } from "./tool-families";
import { CURRICULUM_KV_KEY, runCurriculumWeekly } from "./self-improve";
import { createFromDraft, dispatchChecked, getDraft, proposeDraft } from "../../tasks/server";
import { registerObservedTool, requirePmThread, requirePmThreadRun, scheduleIsolated, workStartRefusal } from "../../platform/server";
import { selfRepairDeps } from "../../self-repair/server";
import { ToolError } from "../../contracts/server";
import { compactDispatchReply, compactReceipt, stageDetail } from "../../runs/server";
import { createWriterAnswer } from "../../writer/server";
import { createWriterReassign, createWriterUpdateTask } from "../../writer/server";
import { z } from "zod";
import type { ServerCore } from "../../contracts/server";

import type { CouncilApi } from "../../council/server/council";
import type { MemoryStageApi } from "../../memory/server/memory";
import type { NightStagesApi } from "../../night/server/night";
import type { PhaseIntake } from "../../phase/server/intake";
import type { QaStagesApi } from "../../qa/server/qa";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { StabilityPort } from "../../contracts";
import type { WriterDispatchApi } from "../../writer/server/dispatch";

import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { LeadApi } from "../../lead/server/service";
import type { PhaseApi } from "../../phase/server/driver";
import type { ScheduleService } from "../../schedule/server/schedule-service";
import type { WriterStateApi } from "../../writer/server/state";

import type { BaselineApi } from "../../baseline/server/baseline";
import type { WriterSpawnApi } from "../../writer/server/spawn";

import type { WriterStartApi } from "../../writer/server/start";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  backlog: BacklogApi;
  stageHelperSettings: StageHelperSettings;
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  council: CouncilApi;
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  docsPlaces: DocsNightlyApi["docsPlaces"];
  ingestOpenCodeTelemetry: QaStagesApi["ingestOpenCodeTelemetry"];
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  isTaskSatisfied: IsTaskSatisfied;
  lead: LeadApi;
  phaseIntake: PhaseIntake;
  phases: PhaseApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  readWriterWorkspaceFile: WriterDispatchApi["readWriterWorkspaceFile"];
  rollback: RollbackApi;
  runBrowserQa: QaStagesApi["runBrowserQa"];
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runBudgets: WriterStateApi["runBudgets"];
  runMemoryContext: MemoryStageApi["runMemoryContext"];
  runWorkspaceStatus: NightStagesApi["runWorkspaceStatus"];
  schedules: ScheduleService;
  stability: StabilityPort;
  resolveIntegrationGate: VerificationGatePort;
  startWriterTask: WriterStartApi["startWriterTask"];
  waitWriter: WriterDispatchApi["waitWriter"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}


/**
 * What the PM gets back from lane_pilot_wait_writer: per stage only task, stage, state and reason, and strings cut
 * short. The full receipts of a long run went over 1 MB and overflowed the PM's context on every poll (SelfyStudio).
 */
export function compactWaitResult(result: unknown): unknown {
  const clip = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") return value.length > 1500 ? `${value.slice(0, 1500)}… [${value.length - 1500} more chars]` : value;
    if (Array.isArray(value)) return value.length > 40 ? [...value.slice(-40).map((v) => clip(v, depth + 1)), `… ${value.length - 40} earlier items`] : value.map((v) => clip(v, depth + 1));
    if (value && typeof value === "object") {
      if (depth > 6) return "[nested]";
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clip(v, depth + 1)]));
    }
    return value;
  };
  if (!result || typeof result !== "object") return result;
  if ((result as { ok?: unknown }).ok === false) return result;
  const row = result as Record<string, unknown>;
  const stages = Array.isArray(row.stages) ? (row.stages as Array<Record<string, unknown>>) : null;
  return clip({
    ...row,
    ...("receipt" in row ? { receipt: compactReceipt(row.receipt) } : {}),
    ...(stages ? { stages: stages.map((stage) => ({ taskId: stage.taskId, stageId: stage.stageId, state: stage.state,
      ...(typeof stage.reason === "string" && stage.reason ? { reason: stage.reason.slice(0, 400) } : {}) })) } : {}),
  });
}

/** The per-run instructions a PM session gets from `bb.agents.configure`, as text — exported so tests check the
 * words the PM actually sees instead of scanning this file. */
export function pmRunInstructions(args: { runId: string; writerLabel: string | null; writerWorkspace: string | null; waiting: boolean }): string {
  const { runId, writerLabel, writerWorkspace, waiting } = args;
  return waiting
    ? `Lane Pilot PM ${runId} is waiting for the native environment to attach. Lane Pilot tools are already bound to this chat; do not dispatch writers until the workspace is frozen.`
    : writerLabel && writerWorkspace
    ? `Lane Pilot PM ${runId}. Writer=${writerLabel}; writer workspace=${writerWorkspace}. Every task-v2 project_cwd must equal this writer workspace; a mismatch is rejected before dispatch. The workspace is fixed for this run even if project settings change later. The writer tool is available only in this PM thread; never put wrapper or system instructions into plan. If pm_read is enabled, task.read_first is read by the bounded PM-read stage before critique and its summary goes to critique and writer. Report each stage's state and reason to the owner, not the raw receipts. When you report the run's progress, add the line ::lane-run{id="${runId}"} on its own; the owner sees it as a live card of the run's tasks.`
    : `Lane Pilot PM ${runId}, but project configuration is missing.`;
}

export function registerTools(ctx: ServerCore, services: Services, familyContributors: readonly (() => void)[] = []) {
  const { bb, db } = ctx;

  // The weekly weak-spots brief (SMA k_v_curriculum): every Monday the four miss sources (each limited to the last 7 days and
  // 5000 rows) are clustered into at most ten imperative lines at lp.curriculum.latest; `bb lane-pilot curriculum --brief`
  // prints them. Nothing injects the brief into a PM's or a writer's context. Off unless the global setting
  // curriculum.weekly is `on`: a default install runs no new job. registerTools runs once, in the plugin server on the hub
  // (server.ts), where the one data.db lives; the named schedule skips an overlapping run.
  scheduleIsolated(bb, "curriculum-weekly", "0 9 * * 1", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const lines = await runCurriculumWeekly(db, bb.storage.kv as { set(key: string, value: unknown): Promise<unknown> }, loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID));
    if (lines !== null) ctx.log(`curriculum weekly: ${lines} weak-spot line(s) at ${CURRICULUM_KV_KEY}`);
  }, { timeoutMs: 10 * 60_000 });

  registerObservedTool(bb.agents, {
    name:LANE_PILOT_READ_NAME,
    description:"Read a bounded UTF-8 slice of a file inside the current run's writer workspace.",
    instructions:"Use only from the matching Lane Pilot PM thread. path is relative to the frozen writer workspace. offset is a 0-based line index. maxLines is the maximum number of lines returned. Paths that leave the workspace, including .. segments and absolute paths, are rejected. This is not the pm_read stage.",
    parameters:z.object({
      path:z.string().min(1).max(1024),
      offset:z.number().int().min(0).default(0),
      maxLines:z.number().int().min(1).max(2000).default(200),
    }).strict(),
    execute: async (params, context) => JSON.stringify(await services.readWriterWorkspaceFile({
      threadId:context.threadId, projectId:context.projectId, path:params.path, offset:params.offset, maxLines:params.maxLines,
    }), null, 2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_dispatch_writer", startsWork: true,
    description:"Start a task-v2 contract with the configured native BB writer and return run/attempt identity immediately.",
    instructions:"Use only from a Lane Pilot PM thread. One call per task (one page or feature). Every task carries display_title (the language the owner writes in, at most 60 characters, what changes for a person), kind (" + TASK_KINDS.join(", ") + ") and area; the first dispatch of a run also carries objective. Overlapping owns_paths or area wait for the open task; depends_on starts once those tasks are accepted. fixes_regressions: ids of the regression rows the task fixes (their quarantine skips it). Returns at once; Lane Pilot sends you the results; a task sent again while its family runs returns task_in_progress. risk is what breaks if the writer errs: low — a prototype, mock, static page, copy, layout, docs, tests; medium — behaviour people rely on; high — payments, auth, data, migrations, deploy. quality_mode wins over the project's: quick for a prototype or a page nobody ships yet (no critics, the checks still run), full when the owner asks for a thorough check, unset = standard by risk; qa_cases (full mode) run in the task's own graph after acceptance, give qa_url with them. A reason that starts verdict_block is a critic's block: do not send the task again unchanged. Red before green: at risk medium or more at least one verification item must fail on the base commit and pass only when the work is done." + "\n" + gateVocabularyLines().join("\n"),
    parameters:z.object({ confirm:z.literal(true), plan:z.string().min(1), task:taskV2Schema.optional(), baseRef:z.string().trim().min(1).max(240).optional(),
      objective:z.string().trim().min(1).max(2000).describe("Required on the first dispatch of a run (later ones may omit it): what this whole run is for, one phrase in the language the owner writes in. Lane Pilot keeps the first one in the run's record.").optional() }).strict(),
    execute: async (params, context) => {
      // Rails by default, then the writer dispatch with its gates: one function, shared with the task drafts (tasks/server/draft.ts).
      return JSON.stringify(
        compactDispatchReply(await dispatchChecked({ dispatchRefusal: (threadId) => services.phaseIntake.dispatchRefusal(threadId), dispatchWriter: services.dispatchWriter as never },
          { threadId:context.threadId, projectId:context.projectId, task:params.task, plan:params.plan, baseRef:params.baseRef, objective:params.objective })),
      );
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_propose", startsWork: false,
    description:"Propose a task-v2 (or a batch of them) to the owner without starting it: stores a draft, prints its card, and starts nothing until the owner says so.",
    instructions:"Use only from a Lane Pilot PM thread when the owner asked what you would do, not to do it. Send task for one draft or tasks for a batch; nothing is enqueued. When the owner answers «да», call this tool again with draftId and create:true — that is the same enqueue path as the card's «Создать» button, so a task is never enqueued twice.",
    parameters:z.object({
      task:taskV2Schema.optional(), tasks:z.array(taskV2Schema).min(1).max(50).optional(), plan:z.string().optional(), objective:z.string().trim().min(1).max(2000).optional(),
      draftId:z.string().optional(), create:z.literal(true).optional(),
    }).strict(),
    execute: async (params, context) => {
      if (params.draftId) {
        if (!params.create) return JSON.stringify({ error:`draftId without create:true does nothing` });
        // Creating starts work: the same owner-turn gate lane_pilot_dispatch_writer passes (startsWork), then the same dispatch function per contract.
        const turnRefusal = await workStartRefusal(context, "lane_pilot_dispatch_writer");
        if (turnRefusal) throw new ToolError(turnRefusal, { code:"not_owner_turn", retryable:false, sideEffects:"none" });
        const draft = getDraft(db, params.draftId);
        // A draft of another project or another chat is not this PM's to create.
        if (!draft || draft.projectId !== context.projectId) return JSON.stringify({ error:`draft ${params.draftId} does not exist` });
        return JSON.stringify(await createFromDraft(db, draft.id, async (contract) => compactDispatchReply(await dispatchChecked(
          { dispatchRefusal: (threadId) => services.phaseIntake.dispatchRefusal(threadId), dispatchWriter: services.dispatchWriter as never },
          { threadId: draft.threadId ?? context.threadId, projectId: draft.projectId, task: contract, plan: draft.plan ?? undefined, objective: draft.objective ?? undefined })), { projectId: context.projectId }));
      }
      const contracts = params.tasks ?? (params.task ? [params.task] : []);
      if (!contracts.length) throw new ToolError("propose names task or tasks", { code:"bad_input", retryable:false, sideEffects:"none" });
      const runId = await requirePmThreadRun(bb, context);
      const draft = proposeDraft(db, { runId, projectId: context.projectId, threadId: context.threadId,
        kind: params.tasks ? "batch" : "task", contracts, objective: params.objective ?? null, plan: params.plan ?? null });
      return `Предлагаю ${draft.kind === "batch" ? `пачку из ${draft.contracts.length} задач` : "задачу"}. Создать?\n\n::lane-draft{id="${draft.id}"}`;
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_cancel_task",
    description:"Cancel tasks of this PM's run that are no longer wanted: a queued one at once, a running one once its writer stops, a blocked one is closed.",
    instructions:"Use only from a Lane Pilot PM thread, for tasks a newer task supersedes or the owner dropped. Name the task ids you sent; tasks that depend on a canceled one stop waiting for it, and a canceled task frees its area. Cancel does not undo work already merged into main. To replan queued tasks do not cancel and resend them: hold them (lane_pilot_queue hold), correct with lane_pilot_update_task, then release; a canceled queued task sent again unchanged gets its task and attempt back.",
    parameters:z.object({ taskIds:z.array(z.string().min(1)).min(1).max(50), words:z.string().trim().min(1).max(1000).describe("Closed in words: why these tasks end here; kept on the task.").optional() }).strict(),
    execute: async (params, context) => {
      const runId = await requirePmThreadRun(bb, context);
      const open = listOpenAttempts(db).filter((row) => row.run_id === runId);
      const results = [];
      for (const taskId of params.taskIds) {
        const attempts = open.filter((row) => row.task_id === taskId);
        if (!attempts.length) {
          // Parked for a restart (no open attempt, a ticket in the stability room): the cancel drops the ticket, so the task does not come back.
          const unparked = await services.stability.dropParked((row) => row.runId === runId && row.taskId === taskId);
          if (unparked.length) { results.push({ taskId, ok:true, state:"unparked", reason:"it was parked for a restart; the restart ticket is dropped and it does not restart" }); continue; }
          // Ended without acceptance (blocked, failed): the PM closes it, so it leaves the board and holds no task behind it. feed-gen 2026-11-10:
          // «cancel is not legal from blocked» left four superseded tasks on the board and one of them holding its area as the pilot.
          const newest = listAttemptsForTask(db, runId, taskId).at(-1);
          const closed = newest ? closeEndedAttempt(db, { ...newest, run_id:runId, task_id:taskId }, params.words?.trim() ? `PM canceled: ${params.words.trim()}` : `PM canceled the task (it had ended ${newest.state})`, "owner_cancel") : null;
          if (newest && closed) {
            if (params.words) setTaskClosedWords(db, taskId, params.words);
            results.push({ taskId, attemptId:newest.id, ...closed });
            continue;
          }
          results.push({ taskId, ok:false, state:newest?.state ?? "not_open", reason:newest ? `its last attempt is ${newest.state}: nothing to cancel` : "no attempt of this task in this run" });
          continue;
        }
        const why = params.words?.trim() ? `PM canceled: ${params.words.trim()}` : "PM canceled the task";
        for (const attempt of attempts) results.push({ taskId, attemptId:attempt.id, ...await cancelAttemptById(ctx, attempt.id, services.rollback, why, "owner_cancel") });
        // The PM canceled it: its «canceled» is no news for the batched results.
        noteToldPmDirectly(db, context.threadId, taskId, Date.now() + 5 * 60_000);
        if (params.words) setTaskClosedWords(db, taskId, params.words);
      }
      return JSON.stringify({ runId, results });
    },
  });

  const { updateTask } = createWriterUpdateTask(ctx, services);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_update_task",
    description:"Update the contract or plan of a task in place under the same id: a queued task that has not started yet, or a blocked task whose writer stopped with a question.",
    instructions:"Use only from a Lane Pilot PM thread to correct a task. A queued task, or one blocked by the plan critique or validation before any writer, keeps its id, queue position and depends_on edges, gets a rewritten PLAN.md, and reruns pm-read and plan critique; no attempt is spent. A blocked task whose writer stopped with a needs_human question: send the whole task with the corrected verification, acceptance, expected_outputs, owns_paths or never_touch (and plan); the same attempt reopens in the same writer thread and worktree, no attempt is charged, and the writer gets a turn naming each changed field with its old and new value. Any other field of a blocked task (id, objective, project_cwd, area, depends_on, ...) returns redispatch_required: cancel the task and dispatch it again. A running task returns task_started for contract changes but takes a bare note (see note/when). With satisfied:true (no task or plan) a BLOCKED task whose work you verified yourself counts as done for the tasks that depend on it, so they start without a dummy follow-up task; the task itself stays blocked in the record.",
    parameters:z.object({
      taskId:z.string().min(1),
      task:taskV2Schema.optional(),
      plan:z.string().min(1).optional(),
      satisfied:z.boolean().optional(),
      note:z.string().min(1).max(4000).optional().describe("A word for a running writer: now steers the live turn, next_turn queues, task rides the next attempt."),
      when:z.enum(["now","next_turn","task"]).optional(),
      allowTestEdits:z.literal(true).optional().describe("On a test_edit_hold block: allows the recorded edits and finishes the hand-in."),
    }).strict(),
    execute: async (params, context) => {
      const runId = await requirePmThreadRun(bb, context);
      return JSON.stringify(
        await updateTask({
          projectId:context.projectId,
          runId,
          pmThreadId:context.threadId,
          taskId:params.taskId,
          task:params.task,
          plan:params.plan,
          satisfied:params.satisfied,
          note:params.note,
          when:params.when,
          allowTestEdits:params.allowTestEdits,
        }),
        null,
        2,
      );
    },
  });

  const { reassignTask } = createWriterReassign(ctx);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_reassign_task",
    description:"Move a running task to a fresh writer thread in the same worktree, on the requested model or the current writer settings. The task keeps its id and dependents; no attempt is spent.",
    instructions:"Use only from a Lane Pilot PM thread, when a task's writer is stuck on a dead provider or the owner wants the task on another model. Only a running task can move: a queued one starts with the current settings, and a finished or parked one returns not_reassignable with its state. Give model (and providerId when it is another provider), or leave both out for the current writer settings. The old writer stops, its edits in the worktree carry over, and the new writer starts from a handoff brief. newThreadId null means the new writer has not started yet; it starts once the old one has stopped. reasoningEffort sets the new writer's effort; the service tier is the project's default.",
    parameters:z.object({
      taskId:z.string().min(1),
      providerId:z.string().min(1).max(200).optional(),
      model:z.string().min(1).max(200).optional(),
      reasoningEffort:z.string().min(1).max(40).optional(),
      reason:z.string().min(1).max(300).optional(),
    }).strict(),
    execute: async (params, context) => {
      const runId = await requirePmThreadRun(bb, context);
      return JSON.stringify(await reassignTask({ projectId:context.projectId, runId, taskId:params.taskId, providerId:params.providerId,
        model:params.model, reasoningEffort:params.reasoningEffort, reason:params.reason }), null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_wait_writer",
    description:"Wait up to 240 seconds for a Lane Pilot writer run and return its persisted receipt or running state.",
    instructions:"Use only from the same Lane Pilot PM thread that dispatched the run. Prefer ending your turn: Lane Pilot sends you the result. If state is running, call again with the same runId. The reply is a receipt: one line per stage; pass stage (and taskId) to read one stage's full stored result.",
    parameters:z.object({ runId:z.string().min(1), timeoutSec:z.number().int().min(1).max(240).default(60),
      stage:z.string().min(1).max(40).optional().describe("A stage id (plan-critique, pm-read, specialist-review, acceptance-receipt...): returns that stage's stored result at once, without waiting. Replies carry one line per stage only."),
      taskId:z.string().min(1).optional().describe("With stage: only this task's receipt.") }).strict(),
    execute: async (params, context) => {
      if (params.stage) {
        const run = getRun(db, params.runId);
        if (!run || run.project_id !== context.projectId || run.pm_thread_id !== context.threadId) {
          throw new ToolError("run does not belong to this PM thread and project", { code: "not_pm_run", retryable: false, sideEffects: "none" });
        }
        return JSON.stringify(stageDetail(params.runId, params.stage, listStageReceipts(db, params.runId, params.taskId)));
      }
      const waited = await services.waitWriter({ threadId:context.threadId, projectId:context.projectId, runId:params.runId, timeoutSec:params.timeoutSec });
      // The receipt shows the PM every task's state: those already ended are no news for the batched results.
      for (const taskId of listEndedTaskIds(db, params.runId)) noteToldPmDirectly(db, context.threadId, taskId);
      return JSON.stringify(compactWaitResult(waited));
    },
  });

  // The answer service reads the shared bag at call time, so it is mounted here instead of the composition root.
  const { answerWriter } = createWriterAnswer(ctx, services);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_answer_writer",
    description:"Answer a writer's NEEDS_HUMAN question: the same attempt continues in the same writer thread without spending one.",
    instructions:"Use only from the matching Lane Pilot PM thread, and only when the task's latest attempt is blocked with needs_human. The answer is delivered into the writer's own thread and its normal wait → validate → accept cycle follows: poll lane_pilot_wait_writer with the same runId. Any other case returns not_answerable — redispatch the task instead. It never changes the contract: lane_pilot_update_task does that under the same id.",
    parameters:z.object({ taskId:z.string().min(1), answer:z.string().min(1).max(8000) }).strict(),
    execute: async (params, context) => {
      const runId = await requirePmThreadRun(bb, context);
      // Secret-shaped answer refused: a key or a password never goes into a writer's thread; the check gets it from Env Catalog by name.
      if (secretShaped(params.answer)) throw new ToolError("the answer looks like it carries a secret (a key, a token or a password); never send a secret to a writer: save it in Env Catalog (env_set) and name it in the check's secrets", { code:"secret_shaped_answer", retryable:false, sideEffects:"none" });
      return JSON.stringify(
        await answerWriter({ projectId:context.projectId, runId, pmThreadId:context.threadId, taskId:params.taskId, answer:params.answer }),
        null,
        2,
      );
    },
  });

  // A question to the owner as a BB form: it sits in this chat, reaches the owner's phone as a push, and the answer comes
  // back as a message. Called from a tool, BB answers the call at once with a waiting notice, so the PM is not held.
  registerObservedTool(bb.agents, {
    name:"lane_pilot_ask_owner",
    description:"Ask the owner a question as a form in this chat (the owner's phone gets a push). The answer comes back into this chat as a message.",
    instructions:[
      "Use instead of writing the question in your reply when only the owner can decide — the ask-the-owner list of your session's «When to act», or a writer's needs_human question you cannot settle from the code or docs. Put the whole question in one call: only one form can be open in a chat.",
      "`question`: one self-contained sentence the owner can answer from the phone (it is the push text); `detail` carries the context. `options`: up to 6 short answers the owner can tap; without them the owner types a reply.",
      "After the call, end your turn or continue other work: the answer arrives as a message («the owner answered …»). Then act on it, for a writer's question with lane_pilot_answer_writer.",
      "If the result says owner_question_unavailable, ask in your reply text instead.",
    ].join("\n"),
    parameters:z.object({
      question:z.string().trim().min(1).max(2000),
      detail:z.string().trim().max(4000).optional(),
      options:z.array(z.string().trim().min(1).max(120)).max(6).optional(),
      /** Which of the five kinds of stop this is (SMA: Five question kinds): decision by default, worker when it relays a writer's needs_human. The kind decides whether free text is allowed. */
      kind:z.enum(["checkpoint", "budget", "pause", "decision", "worker"]).default("decision"),
      timeoutMin:z.number().int().min(1).max(60).default(30),
    }).strict(),
    execute: async (params, context) => {
      await requirePmThread(bb, context);
      const answer = await ctx.ownerAsk.ask(context.threadId, { source:"pm", kind:params.kind, question:params.question, detail:params.detail, options:params.options },
        { timeoutMs:params.timeoutMin * 60_000, signal:context.signal });
      if (answer.outcome === "unavailable") {
        throw new ToolError(`owner_question_unavailable: ${answer.reason}`, { code:"owner_question_unavailable", retryable:false, sideEffects:"none", next:"ask the owner in your reply text" });
      }
      // Readable text, not JSON: BB shows a delivered result to the owner as markdown (owner-answer-text.ts).
      const locale = await bestEffort(bb.log, "owner question locale", ownerLocale(bb), "ru" as const);
      if (answer.outcome === "cancelled") return ownerAnswerText({ answered:false, reason:answer.reason }, locale);
      return ownerAnswerText({ answered:true, choice:answer.choice?.label ?? null, text:answer.text }, locale);
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_browser_qa",
    description:"Start the `lp.browser-qa` graph on an accepted task: a child thread drives the BB browser on the project's Browser QA machine (the Mac mini) and returns a verdict per case and viewport.",
    instructions:"A task that carries qa_cases and qa_url gets this check from its own graph right after acceptance, so do not call it for such a task. Use it by hand only from the matching Lane Pilot PM thread and only after lane_pilot_wait_writer returned an accepted receipt. runId is this PM thread's Lane Pilot run id (lprun_…; the dispatch and wait receipts carry it) and taskId the accepted task's id. envClass says what the URL is: local (localhost or a dev server), staging, preview (a per-branch deploy), production (a live site) or unknown; production and unknown need authorized=true. The check runs in a child thread that opens the BB browser on the Browser QA machine (the Mac mini), even when this chat runs elsewhere; a localhost target on another machine is opened at that machine's private VPN address. When the target is a dev server that is not running, pass its start command in devServer (e.g. npm -w @app/web run dev -- --port 5173): the check starts it in a BB terminal of its thread and closes it afterwards. Supply concrete browser-ui cases and the exact target URL; viewports are CSS widths (default 375,768,1280). Production, unknown, or stateful side-effect cases require authorized=true. Authorization follows the owner's goal, as in your instructions. A case that needs a sign-in starts with `login: NAME` (an Env Catalog entry of kind login that the owner allowed in the setting secrets.allow): the check thread then reads only that login. If the login is missing or not allowed, nothing starts and the answer says what to do (env_request for a missing one); call again afterwards. Show the owner the returned @thread link. A verdict is passed only when every case passed on every viewport.",
    parameters:z.object({
      runId:z.string().min(1), taskId:z.string().min(1), url:z.string().url(),
      cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
      envClass:z.enum(["local","staging","preview","production","unknown"]),
      viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/).default("375,768,1280"),
      authorized:z.boolean().default(false),
      devServer:z.string().min(1).max(500).optional(),
    }).strict(),
    // The graph `lp.browser-qa` runs the check (qa/server/browser-graphs.ts); the receipts and the reply are runBrowserQa's.
    execute:async (params,context) => {
      if (!context.threadId || !context.projectId) throw new Error("browser_qa_needs_pm_thread: call this from the Lane Pilot PM chat of the run");
      return JSON.stringify(await runBrowserQaGraph(ctx,{
        pmThreadId:context.threadId, projectId:context.projectId, runId:params.runId, taskId:params.taskId,
        url:params.url, cases:params.cases, envClass:params.envClass, viewports:params.viewports, authorized:params.authorized, devServer:params.devServer,
      }),null,2);
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_ingest_opencode_telemetry",
    description:"Read a bounded task-local OpenCode tool hook JSONL file, correlate by session and task key, and persist a sanitized stage receipt.",
    instructions:"Use only from the matching PM thread after an accepted writer receipt. Supply the exact OpenCode session ID, the task-file basename written by LANE_TASK_FILE (without .yml/.yaml), and a project-relative JSONL path. The host rejects paths outside the immutable task workspace, symlinks, malformed UTF-8, and oversized logs. The receipt stores only event metadata and hashes, never tool arguments/output. Current OpenCode hook input emits tool.execute.after budget events; session.compacted has no producer and is explicitly reported unavailable.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),sessionId:z.string().min(1).max(256),taskFile:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),sourcePath:z.string().min(1).max(512)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.ingestOpenCodeTelemetry({threadId:context.threadId,projectId:context.projectId,
      runId:params.runId,taskId:params.taskId,sessionId:params.sessionId,taskFile:params.taskFile,sourcePath:params.sourcePath}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_workspace_status",
    description:"Capture the read-only status and diff of the run's BB-managed workspace and persist a bounded receipt.",
    instructions:"Use from the matching Lane Pilot PM thread after dispatch. This tool reads only the immutable run-bound managed worktree status/diff; it does not write, commit, merge, cancel, or inspect another environment.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runWorkspaceStatus({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_memory_context",
    description:"Search bounded project memory for the configured audience and return a provenance-bearing context packet.",
    instructions:"Use only from the matching active Lane Pilot PM thread. The configured audience is enforced exactly: subagent records are automatically injected only into future writer prompts, owner/export records are available here only to the PM. Treat returned memory as contextual evidence and validate against current project state. When the packet says nothingRelevant, memory holds nothing on that query: do not assume a project fact, read the code or ask the owner.",
    parameters:z.object({runId:z.string().min(1),query:z.string().min(1).max(4000)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runMemoryContext({threadId:context.threadId,projectId:context.projectId,runId:params.runId,query:params.query}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_memory_history",
    description:"Search the project's history — journal tasks, execution outcomes, message transcripts, learned lessons and the work books — every fragment masked for credentials and clipped.",
    instructions:"Use only from the matching active Lane Pilot PM thread. Returns fragments labeled by source (tasks, execution, transcripts, lessons, books); cite a transcript by its id. Optional `source` limits the search to one book.",
    parameters:z.object({query:z.string().min(1).max(2000),source:z.enum(["tasks","execution","transcripts","lessons","books"]).optional()}).strict(),
    execute:async(params,context)=>JSON.stringify({fragments:historySearch(db,context.projectId,params.query,{sources:params.source?[params.source]:undefined})},null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_gate_report",
    description:"Read a bounded project-local report of Lane Pilot gate evaluations or stage history.",
    instructions:"Use only from the matching Lane Pilot PM thread. Gate categories are owns-paths, validate, accept, and verification, recorded as separate append-only events; this reads Lane Pilot's own ledgers and never reads or modifies upstream ~/.agents gate logs. Choose a period from 1 to 365 days and optionally one gate category or one exact stage ID. Results contain counts and receipt hashes, not task content.",
    parameters:z.object({days:z.number().int().min(1).max(365).default(7),stageId:z.enum(["pm-read","plan-critique","specialist-review","writer-agent","verification","code-critique","acceptance-receipt","browser-qa","docs-maintenance","onboarding-preview","onboarding-apply","memory-maintenance","project-life","night-review","night-fix","workspace-status","opencode-telemetry","gate-triage"]).optional(),gate:z.enum(["owns-paths","validate","accept","verification"]).optional()}).strict(),
    execute:async(params,context)=>JSON.stringify(await readGateReport(db,{projectId:context.projectId,days:params.days,stageId:params.stageId,gate:params.gate},bb.storage.kv as never),null,2),
  });

  // Modules register their tools after the core ones so the PM tool order follows NATIVE_LP_BRIDGE_TOOLS.
  mountHandoff(ctx);
  mountInsights(ctx, selfRepairDeps());
  mountHealth(ctx, services);
  mountCouncilTools(ctx, services.council, (threadId) => services.phaseIntake.launchRefusal(threadId));
  // ponytail: specialists.ts is owned by the critics branch. Push until that file lists the new ids.
  installEmployeeSpecialists(SPECIALIST_ROLES as unknown as string[]);
  mountSpecialists(ctx, services);
  // The browser step and the browser check of an accepted task (graphs browser-step and lp.browser-qa), next to the errand graph:
  // registered from the qa side so the workflow room does not import qa (an import cycle through the errand graph).
  registerBrowserExecutors(services.workflowEngine, ctx, services);
  mountRelay(ctx);
  mountWorkflowTools(ctx, services);
  mountSelfRepair(ctx, services, selfRepairDeps());
  mountHookTimeoutWatch(ctx);
  mountPmTurnWatch(ctx);
  mountServiceProjects(ctx);
  mountWorktreeJanitor(ctx, { cleanupStickyLaneWorktrees, cleanupFinishedAttemptEnvironments });
  mountWorkflowArchitect(ctx, services);
  mountLeadTool(ctx, services);
  mountScheduleTools(ctx, services);
  mountToolFamilies(ctx, familyContributors);

  bb.agents.configure((context) => {
    const role = context.pluginMetadata.role;
    const runId = context.pluginMetadata.lanePilotRunId;
    const legacyOrigin = context.origin.pluginId === "lane-pilot" && role === "pm" && typeof runId === "string";
    const threadId = context.thread?.id;
    const projectId = context.project?.id;
    const native = typeof runId === "string" && threadId && projectId
      ? ownedNativePmRun(db, { runId, threadId, projectId, role })
      : null;
    if (!legacyOrigin && !native) return { tools:[], skills:[] };
    const resolvedRunId = typeof runId === "string" ? runId : native!.id;
    if (native && context.environment?.id && context.environment.path && context.host?.id) {
      finalizeNativeLaneBinding({
        db,
        runId: resolvedRunId,
        hostId: context.host.id,
        workspacePath: context.environment.path,
        environmentId: context.environment.id,
      });
    }
    const run = getRun(db, resolvedRunId);
    const nativeRun = run?.kind === "cli";
    // A native run describes its own writer and workspace, never a stale prototype config.
    const config = nativeRun ? null : loadPrototypeConfig(db, context.project.id);
    const projectSettings = nativeRun && run ? loadProjectSettings(db, context.project.id, getRunSettingsScopes(db, run.id)) : {};
    const settingText = (key:string) => typeof projectSettings[key] === "string" && projectSettings[key] ? projectSettings[key] as string : null;
    const writerLabel = nativeRun
      ? (settingText("writer.provider") && settingText("writer.model") ? `${settingText("writer.provider")}/${settingText("writer.model")}` : "the writer set in Lane Pilot settings")
      : config ? `${config.writerProviderId}/${config.writerModel}` : "";
    const writerWorkspace = writerWorkspaceForPmInstructions(run, config?.writerWorkspacePath);
    const waiting = Boolean(native && run?.kind === "cli" && !nativeRunReady(db, resolvedRunId));
    return {
      tools: [...NATIVE_LP_BRIDGE_PM_TOOLS],
      skills:[],
      instructions: pmRunInstructions({ runId: resolvedRunId, writerLabel, writerWorkspace, waiting }),
    };
  });
}
