import { mountErrands } from "./errands";
import { cancelAttemptById } from "./cancel";
import { LANE_PILOT_READ_NAME } from "../bounded-read";
import { taskV2Schema } from "../contracts";
import { getRun, getRunSettingsScopes, listOpenAttempts, loadProjectSettings, loadPrototypeConfig } from "../database";
import { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun, writerWorkspaceForPmInstructions } from "../native-run";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../native-session-hooks";
import { readGateReport } from "../stages/gate-report";
import { mountHandoff } from "./handoff";
import { mountInsights } from "./insights";
import { mountHealth } from "./health";
import { mountMemorySync } from "./memory-sync";
import { mountCouncilTools } from "./council";
import { mountSpecialists } from "./specialists";
import { mountRelay } from "./relay";
import { mountSelfRepair } from "./self-repair";
import { mountHookTimeoutWatch } from "./hook-timeouts";
import { registerObservedTool, ToolError } from "./tool-result";
import { createWriterAnswer } from "./writer/answer";
import { createWriterUpdateTask } from "./writer/update-task";
import { z } from "zod";
import type { ServerCore } from "./core";
import type { Services } from "./services";

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
    instructions:"Use only from a Lane Pilot PM thread. Send every task of the plan now, each in its own call: one task per page or feature, with its area field; tasks whose owns_paths do not overlap run in parallel, a task whose owns_paths or area overlap an open task's waits for it (the area's writer then continues it in its own thread), and a task with depends_on (task ids that must be accepted first) starts by itself once they are — do not hold tasks back in waves. Returns before writer completion: poll lane_pilot_wait_writer with the returned runId, or end your turn with lane_pilot_remind on the task ids. A task's own failure goes back to its writer as feedback turns in the same thread (up to 5 turns or 120 minutes); sending a task again while one of its family runs or is parked returns task_in_progress. A provider, limit or catalog failure moves it down the writer chain (writer model, fallback 1, fallback 2, then the PM's model) without a redispatch.",
    parameters:z.object({ confirm:z.literal(true), plan:z.string().min(1), task:taskV2Schema.optional(), baseRef:z.string().trim().min(1).max(240).optional() }).strict(),
    execute: async (params, context) => JSON.stringify(
      await services.dispatchWriter({ threadId:context.threadId, projectId:context.projectId, task:params.task, plan:params.plan, baseRef:params.baseRef }),
      null,
      2,
    ),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_cancel_task",
    description:"Cancel tasks of this PM's run that are no longer wanted: a queued one at once, a running one once its writer stops.",
    instructions:"Use only from a Lane Pilot PM thread, for tasks a newer task supersedes or the owner dropped. Name the task ids you sent; tasks that depend on a canceled one stop waiting for it. Cancel does not undo work already merged into main.",
    parameters:z.object({ taskIds:z.array(z.string().min(1)).min(1).max(50) }).strict(),
    execute: async (params, context) => {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:context.threadId });
      const runId = typeof (metadata as Record<string, unknown> | null)?.lanePilotRunId === "string" ? String((metadata as Record<string, unknown>).lanePilotRunId) : null;
      if ((metadata as Record<string, unknown> | null)?.role !== "pm" || !runId) {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      const open = listOpenAttempts(db).filter((row) => row.run_id === runId);
      const results = [];
      for (const taskId of params.taskIds) {
        const attempts = open.filter((row) => row.task_id === taskId);
        if (!attempts.length) { results.push({ taskId, ok:false, state:"not_open", reason:"no open attempt of this task in this run" }); continue; }
        for (const attempt of attempts) results.push({ taskId, attemptId:attempt.id, ...await cancelAttemptById(ctx, attempt.id) });
      }
      return JSON.stringify({ runId, results });
    },
  });

  const { updateTask } = createWriterUpdateTask(ctx, services);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_update_task",
    description:"Update the contract or plan of a queued task that has not started yet in place under the same id.",
    instructions:"Use only from a Lane Pilot PM thread to correct a task before its writer begins. Keeps the task id, queue position and depends_on edges, rewrites PLAN.md, and reruns pm-read and plan critique. If the task has already started, returns task_started (use lane_pilot_answer_writer if it stopped with a question, or cancel and redispatch). With satisfied:true (no task or plan) a BLOCKED task whose work you verified yourself counts as done for the tasks that depend on it, so they start without a dummy follow-up task; the task itself stays blocked in the record.",
    parameters:z.object({
      taskId:z.string().min(1),
      task:taskV2Schema.optional(),
      plan:z.string().min(1).optional(),
      satisfied:z.boolean().optional(),
    }).strict(),
    execute: async (params, context) => {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:context.threadId });
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

  registerObservedTool(bb.agents, {
    name:"lane_pilot_wait_writer",
    description:"Wait up to 240 seconds for a Lane Pilot writer run and return its persisted receipt or running state.",
    instructions:"Use only from the same Lane Pilot PM thread that dispatched the run. If state is running, call again with the same runId.",
    parameters:z.object({ runId:z.string().min(1), timeoutSec:z.number().int().min(1).max(240).default(60) }).strict(),
    execute: async (params, context) => JSON.stringify(
      compactWaitResult(await services.waitWriter({ threadId:context.threadId, projectId:context.projectId, runId:params.runId, timeoutSec:params.timeoutSec })),
    ),
  });

  // The answer service reads the shared bag at call time, so it is mounted here instead of the composition root.
  const { answerWriter } = createWriterAnswer(ctx, services);
  registerObservedTool(bb.agents, {
    name:"lane_pilot_answer_writer",
    description:"Answer a writer's NEEDS_HUMAN question: the same attempt continues in the same writer thread without spending one.",
    instructions:"Use only from the matching Lane Pilot PM thread, and only when the task's latest attempt is blocked with needs_human. The answer is delivered into the writer's own thread and its normal wait → validate → accept cycle follows: poll lane_pilot_wait_writer with the same runId. Any other case returns not_answerable — dispatch the task again instead. Never use it to change the contract: redispatch for that.",
    parameters:z.object({ taskId:z.string().min(1), answer:z.string().min(1).max(8000) }).strict(),
    execute: async (params, context) => {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:context.threadId });
      const runId = typeof (metadata as Record<string, unknown> | null)?.lanePilotRunId === "string" ? String((metadata as Record<string, unknown>).lanePilotRunId) : null;
      if ((metadata as Record<string, unknown> | null)?.role !== "pm" || !runId) {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      return JSON.stringify(
        await answerWriter({ projectId:context.projectId, runId, pmThreadId:context.threadId, taskId:params.taskId, answer:params.answer }),
        null,
        2,
      );
    },
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_dispatch_cli",
    description:"Dispatch a CLI writer through run-controller or lane-ctl on the project host worker.",
    instructions:"Use only from a Lane Pilot PM thread. Do not mix with a BB writer run. Receipt lists settings that have no runtime channel.",
    parameters:z.object({
      confirm:z.literal(true),
      binary:z.enum(["run-controller","lane-ctl"]).optional(),
      subcommand:z.string().min(1).optional(),
      taskFile:z.string().min(1).optional(),
      taskId:z.string().min(1).optional(),
    }).strict(),
    execute: async (params, context) => JSON.stringify(
      await services.dispatchCli({
        threadId:context.threadId,
        projectId:context.projectId,
        binary:params.binary,
        subcommand:params.subcommand,
        taskFile:params.taskFile,
        taskId:params.taskId,
      }),
      null,
      2,
    ),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_browser_qa",
    description:"Check an accepted task in a browser: a child thread drives the BB browser on the project's Browser QA machine (the Mac mini) and returns a verdict per case and viewport.",
    instructions:"Use only from the matching Lane Pilot PM thread and only after lane_pilot_wait_writer returned an accepted receipt. The check runs in a child thread that opens the BB browser on the Browser QA machine (the Mac mini), even when this chat runs elsewhere; a localhost target on another machine is opened at that machine's private VPN address. When the target is a dev server that is not running, pass its start command in devServer (e.g. npm -w @app/web run dev -- --port 5173): the check starts it in a BB terminal of its thread and closes it afterwards. Supply concrete browser-ui cases and the exact target URL; viewports are CSS widths (default 375,768,1280). Production, unknown, or stateful side-effect cases require authorized=true. Authorization follows the owner's goal: every reversible step needed for the approved outcome inside the owner's accounts is authorized without asking step by step; ask the owner once up front only for destructive, paid, outgoing, permission or irreversible steps. Show the owner the returned @thread link. A verdict is passed only when every case passed on every viewport.",
    parameters:z.object({
      runId:z.string().min(1), taskId:z.string().min(1), url:z.string().url(),
      cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
      envClass:z.enum(["local","staging","preview","production","unknown"]),
      viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/).default("375,768,1280"),
      authorized:z.boolean().default(false),
      devServer:z.string().min(1).max(500).optional(),
    }).strict(),
    execute:async (params,context) => JSON.stringify(await services.runBrowserQa({
      threadId:context.threadId, projectId:context.projectId, runId:params.runId, taskId:params.taskId,
      url:params.url, cases:params.cases, envClass:params.envClass, viewports:params.viewports, authorized:params.authorized, devServer:params.devServer,
    }),null,2),
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
    name:"lane_pilot_docs_maintain",
    description:"Dispatch or poll bounded documentation maintenance and return a stage receipt or running child id.",
    instructions:"Use only from the matching Lane Pilot PM thread and only after lane_pilot_wait_writer returned an accepted receipt. First call returns running with threadId if the child is not yet terminal. Call again with the same runId and taskId; do not start another writer. Observation timeout is not a product failure. Reads and writes only markdown beneath docs/ and apps/ with per-file SHA compare-and-swap.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),timeoutSec:z.number().int().min(1).max(240).default(60)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runDocsMaintenance({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId,timeoutSec:params.timeoutSec}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_onboarding_preview",
    description:"Dispatch or poll a bounded onboarding preview from an accepted task and persisted Markdown inventory; this stage does not write files.",
    instructions:"Use only from the matching Lane Pilot PM thread after an accepted writer receipt. First call returns running with threadId if the child is not yet terminal. Call again with the same runId and taskId; do not start another child. Observation timeout is not a product failure. Show the returned summary, paths, expected hashes, and content for review. Writes are never automatic; use lane_pilot_onboarding_apply only after separate explicit confirmation and with this exact previewSha256.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),timeoutSec:z.number().int().min(1).max(240).default(60)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runOnboardingPreview({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId,timeoutSec:params.timeoutSec}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_onboarding_apply",
    description:"Apply a previously reviewed onboarding preview through the task host with explicit confirmation and exact SHA compare-and-swap.",
    instructions:"Use only from the matching Lane Pilot PM thread. Require the user to review the complete preview first, then pass confirm=true and the exact previewSha256 returned by lane_pilot_onboarding_preview. The host rejects out-of-scope paths, symlinks, stale hashes, and mismatched preview content; return its write/readback receipt verbatim.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.applyOnboardingPreview({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId,previewSha256:params.previewSha256,confirm:params.confirm}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_memory_maintain",
    description:"Dispatch or poll project memory maintenance from an accepted Lane Pilot task and return a stage receipt or running child id.",
    instructions:"Use only from the matching Lane Pilot PM thread and only after lane_pilot_wait_writer returned an accepted receipt. First call returns running with threadId if the child is not yet terminal. Call again with the same runId and taskId; do not start another child. Observation timeout is not a product failure. Memory is project-scoped; credentials are rejected; audience and aggregate token budgets are enforced from the persisted snapshot.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),timeoutSec:z.number().int().min(1).max(240).default(60)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runMemoryMaintenance({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId,timeoutSec:params.timeoutSec}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_night_review",
    description:"Dispatch or poll the configured bounded night reviewer after an accepted writer receipt and persist its findings as a stage receipt or running child id.",
    instructions:"Use only from the matching Lane Pilot PM thread and only after lane_pilot_wait_writer returned an accepted receipt. First call returns running with threadId if the child is not yet terminal. Call again with the same runId and taskId; do not start another child. Observation timeout is not a product failure. This stage is read-only: it reports bounded findings and never edits or merges. A blocking finding stops progression until a separately authorized bounded fix is verified.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),timeoutSec:z.number().int().min(1).max(240).default(60)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runNightReview({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId,timeoutSec:params.timeoutSec}),null,2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_night_fix",
    description:"Apply only night-review findings inside task-owned paths, run task verification, and merge an approved managed-worktree PR only when explicitly enabled.",
    instructions:"Use only from the matching Lane Pilot PM thread after lane_pilot_night_review reported findings. Fixes are bounded to finding paths intersecting owns_paths; verification must pass. Merge is disabled unless night_review.auto_merge is explicitly true and the managed worktree PR is open, approved, passing checks, ready, and mergeable.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1)}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runNightFix({threadId:context.threadId,projectId:context.projectId,runId:params.runId,taskId:params.taskId}),null,2),
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
    instructions:"Use only from the matching active Lane Pilot PM thread. The configured audience is enforced exactly: subagent records are automatically injected only into future writer prompts, owner/export records are available here only to the PM. Treat returned memory as contextual evidence and validate against current project state.",
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

  registerObservedTool(bb.agents, {
    name:"lane_pilot_gate_triage",
    description:"Run a read-only model analysis of bounded, project-local Lane Pilot gate history and return a persisted triage receipt.",
    instructions:"Use only from the matching active Lane Pilot PM thread and provide its current runId/taskId. This stage sees only aggregate stage IDs, states, counts, timestamps, and opaque run/task IDs. It does not read upstream ~/.agents logs or task/source content and never edits, repairs, merges, or executes commands. Set days to 1-365; optional provider/model/reasoningEffort must be available on the configured host.",
    parameters:z.object({runId:z.string().min(1),taskId:z.string().min(1),days:z.number().int().min(1).max(365).default(7),providerId:z.string().min(1).optional(),model:z.string().min(1).optional(),reasoningEffort:z.enum(["low","medium","high","xhigh","max"]).optional()}).strict(),
    execute:async(params,context)=>JSON.stringify(await services.runGateTriage({threadId:context.threadId,projectId:context.projectId,...params}),null,2),
  });

  // Modules register their tools after the core ones so the PM tool order follows NATIVE_LP_BRIDGE_TOOLS.
  mountHandoff(ctx);
  mountInsights(ctx);
  mountHealth(ctx, services);
  mountMemorySync(ctx);
  mountCouncilTools(ctx, services.council);
  mountSpecialists(ctx);
  mountErrands(ctx);
  mountRelay(ctx);
  mountSelfRepair(ctx);
  mountHookTimeoutWatch(ctx);

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
        ? `Lane Pilot PM ${resolvedRunId}. Writer=${writerLabel}; writer workspace=${writerWorkspace}. Every task-v2 project_cwd must equal this writer workspace; a mismatch is rejected before dispatch. The workspace is fixed for this run even if project settings change later. The writer tool is available only in this PM thread; never put wrapper or system instructions into plan. If pm_read is enabled, task.read_first is read by the bounded PM-read stage before critique and its summary goes to critique and writer. Report each stage's state and reason to the owner, not the raw receipts.`
        : `Lane Pilot PM ${resolvedRunId}, but project configuration is missing.`,
    };
  });
}
