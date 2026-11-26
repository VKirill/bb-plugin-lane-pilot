import { bestEffort, isNotFound, orMiss, parseJsonOr, stringAt, withoutCredentials, withoutSelectionMarkers } from "@lane-pilot/kit";
import { pathClassByRules, preflightRefusal, routeIntent, type PathRisk, type PathSize } from "@lane-pilot/workflow-engine";
import { OPEN_ATTEMPT_STATES, type HandOverResult, type HandOverStarted, type IntakeRecord, type PhaseIntake } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { sendServiceMessage } from "../../../relay/server";
import { cancelAttemptById, isRunHalted, isRunPaused } from "../../../runs/server";
import { finishedIntakeTaskRows, getRun, getRunSettingsScopes, loadProjectSettings, openIntakeAttemptRows, openIntakeTaskRows } from "../../../storage";
import type { ArchitectApi, WorkflowLibraryApi } from "../../../platform/server";
import type { WorkflowEngineApi } from "./workflow";
import type { WorkflowTriggersApi } from "./workflow-triggers-live";
import { PHASE_RAILS_KEY, PHASE_TRAIN_KEY } from "../../settings";
import { intakeByRules, intakeRunGoals, isMachineMessage, processHint, type IntakeKind, type ServiceKind } from "../../models/intake";

/** The fields of the services bag this file reads, typed locally so workflow does not depend on @services. */
interface Services {
  architect: Pick<ArchitectApi, "startOrder">;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowLibrary?: Pick<WorkflowLibraryApi, "issueQuickWorkflowId" | "prepareWorkflow" | "loadStore">;
  workflowTriggers: Pick<WorkflowTriggersApi["workflowTriggers"], "preflight">;
}

/** A sure route only: the hint takes a request away from the architect (the errand's api-recon bar, 0.1.412). */
const PUBLISHED_HINT_CONFIDENCE = 85;

export type { HandOverResult, HandOverStarted, IntakeRecord, PhaseIntake };

/** The machine's start of the small-task graph for a request, and the state of a run it started. */
export type IntakeTrain = {
  start(input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch" | "heavy" | "full"; path?: { size: PathSize; risk: PathRisk } }): string | null | Promise<string | null>;
  status(wfRunId: string): string | null;
  /** The workflow architect, started with the owner's process as its order; resolves to its chat. */
  startProcess?(input: { projectId: string; pmThreadId: string; text: string }): Promise<string | null>;
  /** The published graph (the project's, global or built-in) the router sends this text to, on a sure route; null when none. */
  findPublished?(input: { projectId: string; text: string }): Promise<{ graphId: string; name: string; confidence: number } | null>;
};
const KEY = (threadId: string) => `phase-intake:${threadId}`;
/**
 * A heavy goal runs as the full-lifecycle graph only: the older phase machine (`phase.road=phase`) is retired.
 * Without the train a heavy request gets an explicit unavailable notice.
 */
const railsOn = (settings: Record<string, unknown>) => String(settings[PHASE_RAILS_KEY] ?? "off") === "on";
/** What a hand-over key started, kept for good: the key maps to the graph run whether it is alive or finished. */
const HANDOVER_KEY = (projectId: string, key: string) => `phase-handover:${projectId}:${key}`;

type Deps = Pick<ServerCore, "bb" | "db" | "effectiveProjectSettings" | "log" | "cancelQueuedAttempt">;

/** Builds the intake train (issue-quick / issue-batch / issue-full / full-lifecycle, workflow architect, published-graph router) from workflow services. */
export function createIntakeTrain(ctx: ServerCore, services: Services): IntakeTrain {
  const { db } = ctx;
  return {
    start: async (input) => {
      const settings = loadProjectSettings(db, input.projectId);
      const library = services.workflowLibrary;
      const workflowId = input.kind === "heavy" ? "full-lifecycle" : input.kind === "batch" ? "issue-batch" : input.kind === "full" ? "issue-full" : library?.issueQuickWorkflowId?.(settings) ?? "issue-quick";
      const workflow = services.workflowEngine.resolveWorkflow(workflowId);
      if (!workflow) return null;
      const title = input.text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "Owner's request";
      try {
        const inputs = input.kind === "heavy" ? { goal: input.text.slice(0, 8000) } : { title, text: input.text.slice(0, 8000), ...(input.kind === "small" && input.path ? { size: input.path.size, risk: input.path.risk } : {}) };
        const prepared = library && typeof library.prepareWorkflow === "function" ? await library.prepareWorkflow(input.projectId, workflow) : { workflow, resolve: services.workflowEngine.resolveWorkflow, composed: false };
        const selected = prepared.composed ? prepared : { workflow, resolve: services.workflowEngine.resolveWorkflow };
        if (prepared.composed) {
          const admission = await services.workflowTriggers.preflight(selected.workflow, { projectId: input.projectId, threadId: input.pmThreadId });
          if (!admission.ok) throw new Error(preflightRefusal(admission));
        }
        const started = services.workflowEngine.start({ workflow: selected.workflow, resolve: selected.resolve, inputs, goals: intakeRunGoals(input.text), key: `intake:${input.pmThreadId}:${input.requestId}`,
          runtime: { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId }, link: { projectId: input.projectId, runId: input.runId } });
        started.done.catch((cause: unknown) => ctx.log(`intake: ${workflow.id} ${started.runId} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
        return started.runId;
      } catch (cause) {
        ctx.log(`intake: ${workflow.id} did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    },
    status: (wfRunId: string) => services.workflowEngine.get(wfRunId)?.status ?? null,
    startProcess: async (input) => (await services.architect.startOrder(input)).threadId,
    findPublished: async (input) => {
      const library = services.workflowLibrary;
      const fallbackStore = async () => await Promise.resolve(services.workflowCatalog.store());
      const store = library && typeof library.loadStore === "function"
        ? await library.loadStore(input.projectId).then((loaded) => loaded.store, fallbackStore)
        : await fallbackStore();
      const routed = await routeIntent({ intent: input.text, workflows: store.list().map((item) => item.workflow), model: null });
      if (routed.decision !== "route" || !routed.workflowId || routed.confidence < PUBLISHED_HINT_CONFIDENCE) return null;
      const name = routed.candidates.find((card) => card.id === routed.workflowId)?.name ?? routed.workflowId;
      return { graphId: routed.workflowId, name, confidence: routed.confidence };
    },
  };
}

/**
 * Rails by default: when a turn starts in a PM chat, the owner's newest message is read before the PM acts on it. A heavy goal
 * starts the full-lifecycle graph; the dispatch tool then refuses to hand out that request's work by hand. Small jobs, batches,
 * questions and consents keep their own roads. `phase.rails off` turns it off for a project.
 */
export function createPhaseIntake(ctx: Deps, train?: IntakeTrain): PhaseIntake {
  const { bb, db } = ctx;
  const pending = new Map<string, Promise<IntakeRecord | null>>();

  /** The rules' reading of a message: its kind (a consent, a question, a service line, small or heavy by length) and the size and risk of its change. No model is asked. */
  function classifyBundle(text: string): { kind: IntakeKind; path: { size: PathSize; risk: PathRisk }; by: "rules"; service?: ServiceKind } {
    const kindRules = intakeByRules(text);
    const pathRules = pathClassByRules(text);
    return { kind: kindRules.kind, path: { size: pathRules.size, risk: pathRules.risk }, by: "rules", ...(kindRules.service ? { service: kindRules.service } : {}) };
  }

  async function read(threadId: string): Promise<IntakeRecord | null> {
    const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound) as Record<string, unknown> | null;
    if (metadata?.role !== "pm" || typeof metadata.lanePilotRunId !== "string") return null;
    const run = getRun(db, metadata.lanePilotRunId);
    if (!run) return null;
    const settings = await ctx.effectiveProjectSettings(run.project_id, getRunSettingsScopes(db, run.id)).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    // Off by default: the PM reads the owner's message itself and starts the graph it needs.
    if (!railsOn(settings)) return null;
    const listed = await bestEffort(ctx.log, "phase intake turn request", bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "1" }), []);
    const event = (Array.isArray(listed) ? listed[0] : null) as { data?: Record<string, unknown> } & Record<string, unknown> | null;
    const data = (event?.data ?? event ?? {}) as Record<string, unknown>;
    const requestId = typeof data.requestId === "string" ? data.requestId : null;
    const input = Array.isArray(data.input) ? data.input as Array<{ type?: string; text?: string }> : typeof data.input === "string" ? [{ type: "text", text: data.input }] : [];
    // No credential leaves the PM chat: not to the classifier, not to helper prompts.
    const text = withoutCredentials(withoutSelectionMarkers(input.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")));
    // Only the owner's own words are intake: an agent's message and BB's system notices (initiator "system") are not.
    if (!requestId || !text || data.initiator === "agent" || data.initiator === "system" || isMachineMessage(text)) return null;
    const known = await bb.storage.kv.get(KEY(threadId)) as IntakeRecord | null;
    if (known?.requestId === requestId) return known;
    const classified = classifyBundle(text);
    const { kind, by } = classified;
    // A run the owner stopped or paused starts nothing on the machine's own: the PM reads the message instead.
    const stopped = await isRunHalted(bb.storage.kv as never, run.id) || await isRunPaused(bb.storage.kv as never, run.id);
    let heavyRunId: string | undefined;
    // №6: a service request is answered from the LP store, the heavy PM stays asleep.
    if (kind === "service" && !stopped) {
      const answered = await serviceAnswer({ run, threadId, text, service: classified.service ?? null });
      if (answered !== null) {
        await bestEffort(ctx.log, "phase intake service answer", sendServiceMessage(bb as never, { threadId, mode: "queue-if-active", text: answered }), undefined);
        const rec: IntakeRecord = { requestId, kind: "service", by, phaseId: null, at: Date.now() };
        await bb.storage.kv.set(KEY(threadId), rec);
        return rec;
      }
    }
    if (kind === "heavy") {
      if (!stopped && train) {
        heavyRunId = (await train.start({ projectId: run.project_id, pmThreadId: threadId, runId: run.id, requestId, text, kind: "heavy" })) ?? undefined;
        if (heavyRunId) ctx.log(`phase intake: ${threadId} — the owner's request is heavy (${by}); full-lifecycle ${heavyRunId} started`);
        else await heavyUnavailable(threadId, "the full-lifecycle graph did not start");
      } else if (!stopped) {
        await heavyUnavailable(threadId, "the full-lifecycle graph is unavailable");
      }
    }
    const record: IntakeRecord = { requestId, kind, by, phaseId: null, at: Date.now(), ...(heavyRunId ? { wfRunId: heavyRunId } : {}) };
    await bb.storage.kv.set(KEY(threadId), record);
    return record;
  }

  /** A heavy request with no graph to carry it is said out loud. */
  async function heavyUnavailable(threadId: string, reason: string): Promise<void> {
    ctx.log(`phase intake: ${threadId} — heavy request not started: ${reason}`);
    await bestEffort(ctx.log, "phase intake unavailable notice",
      sendServiceMessage(bb as never, { threadId, text: `Тяжёлая задача не запущена: ${reason}. Phase machine retired — the full-lifecycle graph is the only road; retry when it is available.` }), undefined);
  }

  /** №6: the one-line answer the LP store itself gives a service request, in Russian, with @thread links where they help. */
  async function serviceAnswer(input: { run: { id: string; project_id: string }; threadId: string; text: string; service: ServiceKind | null }): Promise<string | null> {
    const { run, text, service } = input;
    if (!service) return null;
    if (service === "status" || service === "current") {
      const rows = openIntakeTaskRows(db, run.id, OPEN_ATTEMPT_STATES);
      if (!rows.length) return service === "current" ? "Сейчас ничего не идёт: открытых задач нет." : `Ран ${run.id}: открытых задач нет.`;
      const titles = rows.map((row) => { try { const c = JSON.parse(row.contract_json) as { title?: unknown; display_title?: unknown }; return String(c.display_title || c.title || row.task_id); } catch { return row.task_id; } });
      return service === "current" ? `Сейчас идёт: ${titles.slice(0, 3).join("; ")}${titles.length > 3 ? ` и ещё ${titles.length - 3}` : ""}.` : `Ран ${run.id}: ${titles.length} задач(и) в работе — ${titles.slice(0, 3).join("; ")}.`;
    }
    if (service === "results") {
      const rows = finishedIntakeTaskRows(db, run.id, OPEN_ATTEMPT_STATES);
      if (!rows.length) return "Завершённых задач пока нет.";
      return `Последние результаты: ${rows.map((row) => { const c = parseJsonOr(row.contract_json, null) as { title?: unknown; display_title?: unknown } | null; const t = String(c?.display_title || c?.title || "?"); const link = row.thread_id ? ` @thread:${row.thread_id}` : ""; return `${t} — ${row.state}${link}`; }).join("; ")}`;
    }
    if (service === "cancel") {
      // Only an unambiguous object: the task's id or title must match exactly one open task; else the PM reads the message.
      const open = openIntakeAttemptRows(db, run.id, OPEN_ATTEMPT_STATES);
      const idHit = /\b(\w+-T\d+)\b/.exec(text)?.[1];
      const hits = idHit ? open.filter((row) => row.contract_json.includes(idHit))
        : open.filter((row) => { try { const c = JSON.parse(row.contract_json) as { title?: unknown; display_title?: unknown }; const title = String(c.display_title || c.title || ""); return title && text.toLowerCase().includes(title.toLowerCase()); } catch { return false; } });
      if (hits.length !== 1) return null;
      const cancelled = await cancelAttemptById({ bb, db, cancelQueuedAttempt: ctx.cancelQueuedAttempt }, hits[0]!.attempt_id, undefined, `canceled: the owner asked to stop it ("${text.slice(0, 80)}")`, "owner_cancel");
      return cancelled.ok ? "Задачу остановил." : `Не смог остановить задачу: ${cancelled.reason ?? cancelled.state}.`;
    }
    return null;
  }

  const handingOver = new Map<string, Promise<HandOverResult>>();
  /**
   * One start per key, whatever the state of what it started (RECHECK-341 F7): a repeat of a key that started something returns that very
   * run, live or finished, before anything is classified or opened; a repeat racing the first call waits for it.
   */
  function handOver(input: { projectId: string; pmThreadId: string; runId: string; text: string; key: string; origin: string }): Promise<HandOverResult> {
    const slot = HANDOVER_KEY(input.projectId, input.key);
    const running = handingOver.get(slot);
    if (running) return running;
    const job = (async (): Promise<HandOverResult> => {
      const known = await bb.storage.kv.get(slot) as Partial<HandOverStarted> | null;
      if (known && typeof known.id === "string" && (known.via === "phase" || known.via === "issue-quick" || known.via === "issue-batch" || known.via === "issue-full" || known.via === "full-lifecycle")) return { started: true, via: known.via, id: known.id };
      const result = await startHandOver(input);
      if (result.started) await bb.storage.kv.set(slot, { via: result.via, id: result.id, at: Date.now() });
      return result;
    })().finally(() => handingOver.delete(slot));
    handingOver.set(slot, job);
    return job;
  }

  async function startHandOver(input: { projectId: string; pmThreadId: string; runId: string; text: string; key: string; origin: string }): Promise<HandOverResult> {
    const run = getRun(db, input.runId);
    if (!run) return { started: false, kind: null, reason: "the PM run is gone" };
    const settings = await ctx.effectiveProjectSettings(run.project_id, getRunSettingsScopes(db, run.id)).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    if (await isRunHalted(bb.storage.kv as never, run.id) || await isRunPaused(bb.storage.kv as never, run.id)) return { started: false, kind: null, reason: "the owner stopped or paused the run" };
    const read = classifyBundle(withoutCredentials(input.text));
    const { by, path } = read;
    // A lead branch (key lead:<road>) is work already decided — by the owner's «да» or the lead's own right.
    const decided = input.key.startsWith("lead:");
    const kind = decided && read.kind !== "heavy" && read.kind !== "batch" ? "small" : read.kind;
    const text = `${input.text}\n\n${input.origin}`;
    const trainOn = !!train && String(settings[PHASE_TRAIN_KEY] ?? "on") !== "off";
    const downFull = decided && kind === "heavy" && !railsOn(settings) && trainOn;
    if (kind === "heavy" && !downFull) {
      if (!railsOn(settings)) return { started: false, kind, reason: "phase rails are off" };
      if (train) {
        const id = await train.start({ projectId: run.project_id, pmThreadId: input.pmThreadId, runId: run.id, requestId: input.key, text, kind: "heavy" });
        if (id) { ctx.log(`phase intake: hand-over (${input.origin.slice(0, 80)}) is heavy (${by}); full-lifecycle ${id} started`); return { started: true, via: "full-lifecycle", id }; }
        return { started: false, kind, reason: "the full-lifecycle graph did not start" };
      }
      return { started: false, kind, reason: "the full-lifecycle graph is unavailable" };
    }
    if ((kind === "small" || kind === "batch" || downFull) && train && trainOn) {
      const full = downFull || (decided && kind === "small" && (path.size === "large" || path.risk === "high"));
      const via = full ? "issue-full" : kind === "batch" ? "issue-batch" : "issue-quick";
      const id = await train.start({ projectId: run.project_id, pmThreadId: input.pmThreadId, runId: run.id, requestId: input.key, text, kind: full ? "full" : kind, ...(kind === "small" ? { path } : {}) });
      if (id) { ctx.log(`phase intake: hand-over (${input.origin.slice(0, 80)}) is ${kind} (${by}); ${via} ${id} started`); return { started: true, via, id }; }
      return { started: false, kind, reason: "the small-task graph did not start" };
    }
    return { started: false, kind, reason: kind === "small" || kind === "batch" ? "the small-task graph is off" : `the text reads as ${kind}, not as work to build` };
  }

  /** Reads the newest owner message of a PM chat once; a second call while it runs waits for the same reading. */
  function take(threadId: string): Promise<IntakeRecord | null> {
    const running = pending.get(threadId);
    if (running) return running;
    const job = read(threadId).catch((cause: unknown) => { ctx.log(`phase intake ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`); return null; })
      .finally(() => pending.delete(threadId));
    pending.set(threadId, job);
    return job;
  }

  /** Why the PM may not start a workflow for the owner's newest request (route, run): the machine already took it. The process hint is the dispatch's alone. */
  const launchRefusal = (threadId: string) => dispatchRefusal(threadId, { hint: false });

  /**
   * Why the PM may not dispatch by hand now, or null: the owner's newest request went down a graph or to the workflow architect.
   * The reading of the newest message is finished first, so a quick dispatch cannot slip past it.
   */
  async function dispatchRefusal(threadId: string, options: { hint?: boolean } = {}): Promise<string | null> {
    const record = await take(threadId) ?? await bb.storage.kv.get(KEY(threadId)) as IntakeRecord | null;
    // A route or a run waits only while the architect builds: the chain it publishes is then run with lane_pilot_route.
    const building = record?.kind === "process" && record.architectThreadId && (options.hint !== false
      || await bb.sdk.threads.get({ threadId: record.architectThreadId }).then((info) => stringAt(info, "status") === "running", () => false));
    if (record?.kind === "process" && record.architectThreadId && building) {
      return `This request of the owner is a new process: Lane Pilot started the workflow architect (@thread:${record.architectThreadId}) to build it as a small graph — draft, validator, tests, publish — without a conversation. Do not dispatch it or start a workflow for it by hand; tell the owner it is being built and that you will run it (lane_pilot_route) once it is published.`;
    }
    if (record?.kind === "process" && !record.hinted && options.hint !== false) {
      await bb.storage.kv.set(KEY(threadId), { ...record, hinted: true });
      return processHint();
    }
    if (record?.wfRunId && ["running", "waiting"].includes(train?.status(record.wfRunId) ?? "")) {
      return `This request of the owner went down a graph: Lane Pilot runs it itself (run ${record.wfRunId}: ${record.kind === "heavy" ? "analysis, plan, build in waves, review, the owner's acceptance" : "plan, build, report"}), and the result comes to this chat. Do not dispatch it or start a workflow for it by hand; tell the owner it is under way. If the owner asks for something else, that is a new request.`;
    }
    return null;
  }

  return { take, dispatchRefusal, launchRefusal, classify: async (text: string) => { const { kind, by } = classifyBundle(text); return { kind, by }; }, handOver };
}

/** Every turn that starts in a chat is offered to the intake; it ignores chats that are not a PM's. */
export function mountPhaseIntake(ctx: Deps, intake: PhaseIntake): void {
  const events = (ctx.bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  if (!events || typeof events.on !== "function") return;
  try {
    events.on("thread.active", async (payload) => {
      const thread = (payload as { thread?: { id?: unknown } } | null)?.thread;
      if (typeof thread?.id === "string") await intake.take(thread.id);
    });
  } catch (cause) {
    ctx.log(`phase intake does not listen to thread.active: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
