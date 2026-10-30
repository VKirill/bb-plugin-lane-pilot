import { gateVocabularyLines, secretShaped } from "../../tasks";
import { mountErrands, registerBrowserExecutors, runBrowserQaGraph } from "../../qa/server";
import { cancelAttemptById } from "../../runs/server";
import { LANE_PILOT_READ_NAME } from "@lane-pilot/kit";
import { taskV2Schema } from "../../contracts";
import { getRun, getRunSettingsScopes, listOpenAttempts, listStageReceipts, loadProjectSettings, loadPrototypeConfig, noteToldPmDirectly } from "../../storage";
import { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun, writerWorkspaceForPmInstructions } from "../../native-agent";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../../native-agent";
import { readGateReport } from "../../tasks/gate-report";
import { mountHandoff } from "../../relay/server";
import { mountInsights } from "../../self-repair/server";
import { mountHealth } from "../../stability/server";
import { mountCouncilTools } from "../../council/server";
import { mountSpecialists, SPECIALIST_ROLES } from "../../critique/server";
import { installEmployeeSpecialists } from "../../native-agent";
import { mountRelay, ownerLocale } from "../../relay/server";
import { ownerAnswerText } from "../owner-answer-text";
import { mountWorkflowTools } from "../../workflow/server";
import { mountSelfRepair } from "../../self-repair/server";
import { mountHookTimeoutWatch, mountServiceProjects, mountWorktreeJanitor } from "../../stability/server";
import { mountWorkflowArchitect } from "../../workflow/server";
import { mountScheduleTools } from "../../schedule/server";
import { mountToolFamilies } from "./tool-families";
import { callerPluginMetadata, registerObservedTool, ToolError } from "../../core/server";
import { compactDispatchReply, compactReceipt, stageDetail } from "../../runs/server";
import { createWriterAnswer } from "../../writer/server";
import { createWriterReassign, createWriterUpdateTask } from "../../writer/server";
import { z } from "zod";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

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

export function registerTools(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;

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
    name:"lane_pilot_dispatch_writer",
    description:"Start a task-v2 contract with the configured native BB writer and return run/attempt identity immediately.",
    instructions:"Use only from a Lane Pilot PM thread. One call per task (one page or feature). Every task carries display_title (the language the owner writes in, at most 60 characters, what changes for a person), kind (feature, fix, check, docs, refactor, research, chore) and area; the first dispatch of a run also carries objective. Without them nothing is dispatched and no attempt is spent. Tasks whose owns_paths do not overlap run in parallel; one whose owns_paths or area overlap an open task waits for it (the area's writer then continues it in its own thread); one with depends_on (task ids that must be accepted first) starts by itself once they are. Returns before the writer finishes: poll lane_pilot_wait_writer with the runId; Lane Pilot sends you the results. A task's own failure goes back to its writer as feedback turns in the same thread (up to 5 turns or 120 minutes); sending a task again while one of its family runs or is parked returns task_in_progress. A provider, limit or catalog failure moves it down the writer chain without a redispatch. quality_mode (quick, standard, full) wins over the project's setting: leave it out unless the owner asked; qa_cases are the browser checks a task owes in full mode (lane_pilot_helpers {action:\"browser_qa\"}). A reason that starts verdict_block is a critic's block: do not send the task again unchanged. Red before green: at risk medium or more at least one verification item must fail on the base commit and pass only when the work is done." + "\n" + gateVocabularyLines().join("\n"),
    parameters:z.object({ confirm:z.literal(true), plan:z.string().min(1), task:taskV2Schema.optional(), baseRef:z.string().trim().min(1).max(240).optional(),
      objective:z.string().trim().min(1).max(2000).describe("Required on the first dispatch of a run (later ones may omit it): what this whole run is for, one phrase in the language the owner writes in. Lane Pilot keeps the first one in the run's record.").optional() }).strict(),
    execute: async (params, context) => {
      // Rails by default: the owner's heavy request is a phase, and its pieces are issued by the phase, not by hand.
      const refusal = await services.phaseIntake.dispatchRefusal(context.threadId);
      if (refusal) throw new ToolError(refusal, { code:"phase_rails", retryable:false, sideEffects:"none" });
      return JSON.stringify(
        compactDispatchReply(await services.dispatchWriter({ threadId:context.threadId, projectId:context.projectId, task:params.task, plan:params.plan, baseRef:params.baseRef, objective:params.objective, requireObjective:true })),
      );
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_cancel_task",
    description:"Cancel tasks of this PM's run that are no longer wanted: a queued one at once, a running one once its writer stops.",
    instructions:"Use only from a Lane Pilot PM thread, for tasks a newer task supersedes or the owner dropped. Name the task ids you sent; tasks that depend on a canceled one stop waiting for it. Cancel does not undo work already merged into main. To replan queued tasks do not cancel and resend them: hold them (lane_pilot_queue hold), correct with lane_pilot_update_task, then release; a canceled queued task sent again unchanged gets its task and attempt back.",
    parameters:z.object({ taskIds:z.array(z.string().min(1)).min(1).max(50), words:z.string().trim().min(1).max(1000).describe("Closed in words: why these tasks end here; kept on the task.").optional() }).strict(),
    execute: async (params, context) => {
      const metadata = await callerPluginMetadata(bb, context);
      const runId = typeof (metadata as Record<string, unknown> | null)?.lanePilotRunId === "string" ? String((metadata as Record<string, unknown>).lanePilotRunId) : null;
      if ((metadata as Record<string, unknown> | null)?.role !== "pm" || !runId) {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      const open = listOpenAttempts(db).filter((row) => row.run_id === runId);
      const results = [];
      for (const taskId of params.taskIds) {
        const attempts = open.filter((row) => row.task_id === taskId);
        if (!attempts.length) { results.push({ taskId, ok:false, state:"not_open", reason:"no open attempt of this task in this run" }); continue; }
        const why = params.words?.trim() ? `PM canceled: ${params.words.trim()}` : "PM canceled the task";
        for (const attempt of attempts) results.push({ taskId, attemptId:attempt.id, ...await cancelAttemptById(ctx, attempt.id, services.rollback, why, "owner_cancel") });
        // The PM canceled it: its «canceled» is no news for the batched results.
        noteToldPmDirectly(context.threadId, taskId, Date.now() + 5 * 60_000);
        if (params.words) db.prepare("UPDATE lane_pilot_task SET closed_words=? WHERE id=?").run(params.words, taskId);
      }
      return JSON.stringify({ runId, results });
    },
  });

  const { updateTask } = createWriterUpdateTask(ctx, services);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_update_task",
    description:"Update the contract or plan of a task in place under the same id: a queued task that has not started yet, or a blocked task whose writer stopped with a question.",
    instructions:"Use only from a Lane Pilot PM thread to correct a task. A queued task keeps its id, queue position and depends_on edges, gets a rewritten PLAN.md, and reruns pm-read and plan critique. A blocked task whose writer stopped with a needs_human question (lane_pilot_wait_writer shows it): send the whole task with the corrected verification, acceptance, expected_outputs, owns_paths or never_touch (and plan). The same attempt reopens in the same writer thread and worktree, no attempt is charged, and the writer gets a turn naming each changed field with its old and new value. Any other field of a blocked task (id, objective, project_cwd, area, depends_on, ...) returns redispatch_required: cancel the task and dispatch it again. A running task returns task_started and is not changed. With satisfied:true (no task or plan) a BLOCKED task whose work you verified yourself counts as done for the tasks that depend on it, so they start without a dummy follow-up task; the task itself stays blocked in the record.",
    parameters:z.object({
      taskId:z.string().min(1),
      task:taskV2Schema.optional(),
      plan:z.string().min(1).optional(),
      satisfied:z.boolean().optional(),
    }).strict(),
    execute: async (params, context) => {
      const metadata = await callerPluginMetadata(bb, context);
      const runId = typeof (metadata as Record<string, unknown> | null)?.lanePilotRunId === "string" ? String((metadata as Record<string, unknown>).lanePilotRunId) : null;
      if ((metadata as Record<string, unknown> | null)?.role !== "pm" || !runId) {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      return JSON.stringify(
        await updateTask({
          projectId:context.projectId,
          runId,
          pmThreadId:context.threadId,
          taskId:params.taskId,
          task:params.task,
          plan:params.plan,
          satisfied:params.satisfied,
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
      const metadata = await callerPluginMetadata(bb, context);
      const runId = typeof (metadata as Record<string, unknown> | null)?.lanePilotRunId === "string" ? String((metadata as Record<string, unknown>).lanePilotRunId) : null;
      if ((metadata as Record<string, unknown> | null)?.role !== "pm" || !runId) {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      return JSON.stringify(await reassignTask({ projectId:context.projectId, runId, taskId:params.taskId, providerId:params.providerId,
        model:params.model, reasoningEffort:params.reasoningEffort, reason:params.reason }), null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_wait_writer",
    description:"Wait up to 240 seconds for a Lane Pilot writer run and return its persisted receipt or running state.",
    instructions:"Use only from the same Lane Pilot PM thread that dispatched the run. If state is running, call again with the same runId. The reply is a receipt: one line per stage; pass stage (and taskId) to read one stage's full stored result.",
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
      const ended = db.prepare(`SELECT DISTINCT task_id AS taskId FROM lane_pilot_attempt a WHERE run_id=? AND state IN ('accepted','blocked','canceled')
        AND attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)`).all(params.runId) as Array<{ taskId:string }>;
      for (const row of ended) noteToldPmDirectly(context.threadId, row.taskId);
      return JSON.stringify(compactWaitResult(waited));
    },
  });

  // The answer service reads the shared bag at call time, so it is mounted here instead of the composition root.
  const { answerWriter } = createWriterAnswer(ctx, services);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_answer_writer",
    description:"Answer a writer's NEEDS_HUMAN question: the same attempt continues in the same writer thread without spending one.",
    instructions:"Use only from the matching Lane Pilot PM thread, and only when the task's latest attempt is blocked with needs_human. The answer is delivered into the writer's own thread and its normal wait → validate → accept cycle follows: poll lane_pilot_wait_writer with the same runId. Any other case returns not_answerable — redispatch the task instead. It never changes the contract: a question about the checks, acceptance or paths is fixed with lane_pilot_update_task under the same id (the same attempt reopens in the same thread), and any other contract change needs a redispatch.",
    parameters:z.object({ taskId:z.string().min(1), answer:z.string().min(1).max(8000) }).strict(),
    execute: async (params, context) => {
      const metadata = await callerPluginMetadata(bb, context);
      const runId = typeof (metadata as Record<string, unknown> | null)?.lanePilotRunId === "string" ? String((metadata as Record<string, unknown>).lanePilotRunId) : null;
      if ((metadata as Record<string, unknown> | null)?.role !== "pm" || !runId) {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
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
      "Use instead of writing the question in your reply when only the owner can decide: a writer's needs_human question you cannot settle from the code or docs, money, access, deleting data, a product choice. Put the whole question in one call: only one form can be open in a chat.",
      "`question`: one self-contained sentence the owner can answer from the phone (it is the push text); `detail` carries the context. `options`: up to 6 short answers the owner can tap; without them the owner types a reply.",
      "After the call, end your turn or continue other work: the answer arrives as a message («the owner answered …»). Then act on it, for a writer's question with lane_pilot_answer_writer.",
      "If the result says owner_question_unavailable, ask in your reply text instead.",
    ].join("\n"),
    parameters:z.object({
      question:z.string().trim().min(1).max(2000),
      detail:z.string().trim().max(4000).optional(),
      options:z.array(z.string().trim().min(1).max(120)).max(6).optional(),
      allowText:z.boolean().default(true),
      timeoutMin:z.number().int().min(1).max(60).default(30),
    }).strict(),
    execute: async (params, context) => {
      const metadata = await callerPluginMetadata(bb, context);
      if ((metadata as Record<string, unknown> | null)?.role !== "pm") {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      const answer = await ctx.ownerAsk.ask(context.threadId, { source:"pm", question:params.question, detail:params.detail, options:params.options, allowText:params.allowText },
        { timeoutMs:params.timeoutMin * 60_000, signal:context.signal });
      if (answer.outcome === "unavailable") {
        throw new ToolError(`owner_question_unavailable: ${answer.reason}`, { code:"owner_question_unavailable", retryable:false, sideEffects:"none", next:"ask the owner in your reply text" });
      }
      // Readable text, not JSON: BB shows a delivered result to the owner as markdown (owner-answer-text.ts).
      const locale = await ownerLocale(bb).catch(() => "ru" as const);
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
    name:"lane_pilot_gate_report",
    description:"Read a bounded project-local report of Lane Pilot gate evaluations or stage history.",
    instructions:"Use only from the matching Lane Pilot PM thread. Gate categories are owns-paths, validate, accept, and verification, recorded as separate append-only events; this reads Lane Pilot's own ledgers and never reads or modifies upstream ~/.agents gate logs. Choose a period from 1 to 365 days and optionally one gate category or one exact stage ID. Results contain counts and receipt hashes, not task content.",
    parameters:z.object({days:z.number().int().min(1).max(365).default(7),stageId:z.enum(["pm-read","plan-critique","specialist-review","writer-agent","verification","code-critique","acceptance-receipt","browser-qa","docs-maintenance","onboarding-preview","onboarding-apply","memory-maintenance","project-life","night-review","night-fix","workspace-status","opencode-telemetry","gate-triage"]).optional(),gate:z.enum(["owns-paths","validate","accept","verification"]).optional()}).strict(),
    execute:async(params,context)=>JSON.stringify(readGateReport(db,{projectId:context.projectId,days:params.days,stageId:params.stageId,gate:params.gate}),null,2),
  });

  // Modules register their tools after the core ones so the PM tool order follows NATIVE_LP_BRIDGE_TOOLS.
  mountHandoff(ctx);
  mountInsights(ctx);
  mountHealth(ctx, services);
  mountCouncilTools(ctx, services.council, (threadId) => services.phaseIntake.launchRefusal(threadId));
  // ponytail: specialists.ts is owned by the critics branch. Push until that file lists the new ids.
  installEmployeeSpecialists(SPECIALIST_ROLES as unknown as string[]);
  mountSpecialists(ctx, services);
  services.errands = mountErrands(ctx, services);
  // The browser step and the browser check of an accepted task (graphs browser-step and lp.browser-qa), next to the errand graph:
  // registered from the qa side so the workflow room does not import qa (an import cycle through the errand graph).
  registerBrowserExecutors(services.workflowEngine, ctx, services);
  mountRelay(ctx);
  mountWorkflowTools(ctx, services);
  mountSelfRepair(ctx, services);
  mountHookTimeoutWatch(ctx);
  mountServiceProjects(ctx);
  mountWorktreeJanitor(ctx);
  mountWorkflowArchitect(ctx, services);
  mountScheduleTools(ctx, services);
  mountToolFamilies(ctx);

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
      instructions: waiting
        ? `Lane Pilot PM ${resolvedRunId} is waiting for the native environment to attach. Lane Pilot tools are already bound to this chat; do not dispatch writers until the workspace is frozen.`
        : writerLabel && writerWorkspace
        ? `Lane Pilot PM ${resolvedRunId}. Writer=${writerLabel}; writer workspace=${writerWorkspace}. Every task-v2 project_cwd must equal this writer workspace; a mismatch is rejected before dispatch. The workspace is fixed for this run even if project settings change later. The writer tool is available only in this PM thread; never put wrapper or system instructions into plan. If pm_read is enabled, task.read_first is read by the bounded PM-read stage before critique and its summary goes to critique and writer. Report each stage's state and reason to the owner, not the raw receipts. When you report the run's progress, add the line ::lane-run{id="${resolvedRunId}"} on its own; the owner sees it as a live card of the run's tasks.`
        : `Lane Pilot PM ${resolvedRunId}, but project configuration is missing.`,
    };
  });
}
