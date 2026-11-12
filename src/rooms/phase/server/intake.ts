import { bestEffort, isNotFound, orMiss, parseJsonOr, stringAt, withoutCredentials, withoutSelectionMarkers } from "@lane-pilot/kit";
import { getRun, getRunSettingsScopes, openIntakeTaskRows, finishedIntakeTaskRows, openIntakeAttemptRows } from "../../storage";
import { type ServerCore } from "../../contracts/server";
import { cancelAttemptById, isRunHalted, isRunPaused } from "../../runs/server";
import { pathClassByRules } from "@lane-pilot/workflow-engine";
import type { PathRisk, PathSize } from "@lane-pilot/workflow-engine";
import { intakeByRules, intakeTitle, isMachineMessage, processHint, publishedHint, railsRefusal, type IntakeKind, type ServiceKind } from "../intake";
import { OPEN_ATTEMPT_STATES } from "../../contracts/state-machine";
import { sendServiceMessage } from "../../relay/server";
import type { Phase } from "../logic";

/** What the intake needs of the phase driver (its own type, so the driver can build the intake without a type cycle). */
export type IntakePhases = {
  open(input: { projectId: string; pmThreadId: string; title: string; goal: string; rails?: boolean }): Promise<Phase>;
  tick(): Promise<{ moved: number; idle: string | null }>;
  list(filter: { pmThreadId?: string; live?: boolean }): Phase[];
  status(phaseId: string): { next: { text: string } };
};

/** The last owner request of a PM chat as the intake read it. */
export type IntakeRecord = { requestId: string; kind: IntakeKind; by: "rules" | "jev"; phaseId: string | null; at: number; hinted?: boolean;
  /** The small-task graph the machine started for the request (issue-quick): the PM does not dispatch it by hand. */
  wfRunId?: string;
  /** The workflow architect's chat the machine started to build a process the request described. */
  architectThreadId?: string;
  /** A published graph the request matched: the PM is told to run it, and no architect builds a second one. */
  hint?: { graphId: string; confidence: number } };

/** The machine's start of the small-task graph for a request, and the state of a run it started (src/rooms/phase/server/driver.ts wires them). */
export type IntakeTrain = {
  start(input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch" | "heavy" | "full"; path?: { size: PathSize; risk: PathRisk } }): string | null;
  status(wfRunId: string): string | null;
  /** The workflow architect, started with the owner's process as its order; resolves to its chat. */
  startProcess?(input: { projectId: string; pmThreadId: string; text: string }): Promise<string | null>;
  /** The published graph (the project's, global or built-in) the router sends this text to, on a sure route; null when none. */
  findPublished?(input: { projectId: string; text: string }): Promise<{ graphId: string; name: string; confidence: number } | null>;
};
const KEY = (threadId: string) => `phase-intake:${threadId}`;
/**
 * A heavy goal runs as the full-lifecycle graph (setting phase.road, «graph» by default); «phase» keeps the older phase machine. Since
 * 2026-10-01 the hub's five phases finished none of their goals, all at the seams between its stages, while the task graph accepted 120
 * tasks (owner, 2026-10-31: «work goes by graphs, stable»).
 */
const railsOn = (settings: Record<string, unknown>) => String(settings["phase.rails"] ?? "off") === "on";
const graphRoad = (settings: Record<string, unknown>) => String(settings["phase.road"] ?? "graph") !== "phase";
/** What a hand-over key started, kept for good: the key maps to the phase or graph run whether it is alive or finished. */
const HANDOVER_KEY = (projectId: string, key: string) => `phase-handover:${projectId}:${key}`;
type HandOverStarted = { started: true; via: "phase" | "issue-quick" | "issue-batch" | "issue-full" | "full-lifecycle"; id: string };
type HandOverResult = HandOverStarted | { started: false; kind: IntakeKind | null; reason: string };

type Deps = Pick<ServerCore, "bb" | "db" | "effectiveProjectSettings" | "log" | "cancelQueuedAttempt">;

/**
 * Rails by default: when a turn starts in a PM chat, the owner's newest message is read before the PM acts on it. A heavy goal
 * opens a phase (or joins the live one) and the driver wakes the PM with the stage's one step; the dispatch tool then refuses to
 * hand out that request's work by hand. Small jobs, batches, questions and consents keep their own roads. `phase.rails off`
 * turns it off for a project.
 */

export function createPhaseIntake(ctx: Deps, phases: IntakePhases, train?: IntakeTrain) {
  const { bb, db } = ctx;
  const pending = new Map<string, Promise<IntakeRecord | null>>();

  /** The rules' reading of a message: its kind (a consent, a question, a service line, small or heavy by length) and the size and risk of its change. No model is asked. */
  function classifyBundle(text: string): { kind: IntakeKind; path: { size: PathSize; risk: PathRisk }; by: "rules"; service?: ServiceKind } {
    const kindRules = intakeByRules(text);
    const pathRules = pathClassByRules(text);
    return { kind: kindRules.kind, path: { size: pathRules.size, risk: pathRules.risk }, by: "rules", ...(kindRules.service ? { service: kindRules.service } : {}) };
  }

  /** The PM's last message in the chat, or null: the judgment reads the owner's message against it. */
  async function lastPmMessage(threadId: string): Promise<string | null> {
    const events = await bestEffort(ctx.log, "phase intake PM events", bb.sdk.threads.events.list({ threadId, types: ["item/completed"], order: "desc", limit: "40" }), []);
    for (const event of Array.isArray(events) ? events as unknown as Array<Record<string, unknown>> : []) {
      const item = ((event.data as Record<string, unknown> | undefined)?.item ?? (event as Record<string, unknown>).item) as { type?: string; text?: string } | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) return item.text;
    }
    return null;
  }

  async function read(threadId: string): Promise<IntakeRecord | null> {
    const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound) as Record<string, unknown> | null;
    if (metadata?.role !== "pm" || typeof metadata.lanePilotRunId !== "string") return null;
    const run = getRun(db, metadata.lanePilotRunId);
    if (!run) return null;
    const settings = await ctx.effectiveProjectSettings(run.project_id, getRunSettingsScopes(db, run.id)).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    // Off by default: the PM reads the owner's message itself and starts the graph it needs (owner, 2026-10-31: «I ask the agent a
    // question; the agent must understand what text it gets»). A machine reading in front of it opened a ten-hour phase for a question.
    if (!railsOn(settings)) return null;
    const listed = await bestEffort(ctx.log, "phase intake turn request", bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "1" }), []);
    const event = (Array.isArray(listed) ? listed[0] : null) as { data?: Record<string, unknown> } & Record<string, unknown> | null;
    const data = (event?.data ?? event ?? {}) as Record<string, unknown>;
    const requestId = typeof data.requestId === "string" ? data.requestId : null;
    const input = Array.isArray(data.input) ? data.input as Array<{ type?: string; text?: string }> : typeof data.input === "string" ? [{ type: "text", text: data.input }] : [];
    // No credential leaves the PM chat: not to the classifier, not to a phase (its goal goes into files of the repository and helper prompts).
    const text = withoutCredentials(withoutSelectionMarkers(input.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")));
    if (!requestId || !text || data.initiator === "agent" || isMachineMessage(text)) return null;
    const known = await bb.storage.kv.get(KEY(threadId)) as IntakeRecord | null;
    if (known?.requestId === requestId) return known;
    const classified = classifyBundle(text);
    const { kind, by, path } = classified;
    // A run the owner stopped or paused starts nothing on the machine's own (no phase, graph or architect): the PM reads the
    // message instead (live 2026-10-26, Vampirism Fire: work was stopped and issue-quick still built and merged wcebffdb8-T1).
    const stopped = await isRunHalted(bb.storage.kv as never, run.id) || await isRunPaused(bb.storage.kv as never, run.id);
    let phaseId: string | null = null;
    let heavyRunId: string | undefined;
    // №6: a service request is answered from the LP store, the heavy PM stays asleep. Anything ambiguous falls
    // back to `question` — the PM reads the message as before.
    if (kind === "service" && !stopped) {
      const answered = await serviceAnswer({ run, threadId, text, service: classified.service ?? null });
      if (answered !== null) {
        await bestEffort(ctx.log, "phase intake service answer", bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: answered, mentions: [] }] } as never), undefined);
        const rec: IntakeRecord = { requestId, kind: "service", by, phaseId: null, at: Date.now() };
        await bb.storage.kv.set(KEY(threadId), rec);
        return rec;
      }
    }
    if (kind === "heavy") {
      const live = phases.list({ pmThreadId: threadId, live: true })[0];
      if (live) {
        // A new heavy message while a phase runs is the owner's correction of it (SMA: the owner may return 4 → 1); the PM reads it
        // in this very turn, and the dispatch refusal names the phase if it tries to hand the work out.
        phaseId = live.id;
      } else if (!stopped && graphRoad(settings) && train) {
        heavyRunId = train.start({ projectId: run.project_id, pmThreadId: threadId, runId: run.id, requestId, text, kind: "heavy" }) ?? undefined;
        if (heavyRunId) ctx.log(`phase intake: ${threadId} — the owner's request is heavy (${by}); full-lifecycle ${heavyRunId} started`);
      } else if (!stopped) {
        const phase = await phases.open({ projectId: run.project_id, pmThreadId: threadId, title: intakeTitle(text), goal: text, rails: true });
        phaseId = phase.id;
        ctx.log(`phase intake: ${threadId} — the owner's request is heavy (${by}); phase ${phase.id} opened`);
        // The phase is booked now; the PM gets the discussion's step once its turn ends (the driver pokes an idle PM only).
        await bestEffort(ctx.log, "phase intake tick", phases.tick(), { moved: 0, idle: null });
      }
    }
    // The rules never read a small job, a batch or a process: only the owner's word or the PM starts those graphs.
    const record: IntakeRecord = { requestId, kind, by, phaseId, at: Date.now(), ...(heavyRunId ? { wfRunId: heavyRunId } : {}) };
    await bb.storage.kv.set(KEY(threadId), record);
    return record;
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

  /**
   * Work found by something other than the owner's message (a scheduled agent that concluded the project needs a change) goes down the same
   * road a request typed in the PM chat takes: it is classified the same way, a heavy goal opens a phase, a small job or a batch starts
   * issue-quick / issue-batch. Nothing is written as a contract here; the road does that. The text carries its origin, `key` makes a repeated
   * call the same start. Not started (and why) when the run is stopped, rails or the train are off, a phase is already live for the chat, or the
   * text is no work (a question, a process, a consent). The agent's text is a declared piece of work, so the rules' reading of its size
   * is enough where an owner's short line would wait for the judgment.
   */
  const handingOver = new Map<string, Promise<HandOverResult>>();
  /**
   * One start per key, whatever the state of what it started (RECHECK-341 F7): a repeat of a key that started something returns that very
   * phase or run, live or finished, before anything is classified or opened; a repeat racing the first call waits for it. Only a start is
   * remembered: a refusal may be lifted later (the run resumed, the live phase closed) and the key then starts once.
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
    // A lead branch (key lead:<road>) is work already decided — by the owner's «да» or the lead's own right: read as a reply, question or
    // process («Найти причину…») it started nothing and sat «hand-over blocked» (2026-11-03). Only its size is read. A scheduled
    // agent's hand-over is still judged whole: its question is no work.
    const decided = input.key.startsWith("lead:");
    const kind = decided && read.kind !== "heavy" && read.kind !== "batch" ? "small" : read.kind;
    // The work comes first: the run's title and its goal are read from the first line, and the origin line made them «Opened by the lead…»
    // on every hand-over (hub, 2026-11-04: the goal audit then judged that sentence).
    const text = `${input.text}\n\n${input.origin}`;
    const trainOn = !!train && String(settings["phase.train"] ?? "on") !== "off";
    // Decided heavy work in a project without phase rails had nowhere to go: the «да» was recorded «accepted» and the work never started
    // (two lead branches of BB-сервис, 2026-11-10; `phase.rails` is off by default). It goes down issue-full, as large decided work does.
    const downFull = decided && kind === "heavy" && !railsOn(settings) && trainOn;
    if (kind === "heavy" && !downFull) {
      if (!railsOn(settings)) return { started: false, kind, reason: "phase rails are off" };
      const live = phases.list({ pmThreadId: input.pmThreadId, live: true })[0];
      if (live) return { started: false, kind, reason: `phase ${live.id} is already live in the PM chat` };
      if (graphRoad(settings) && train) {
        const id = train.start({ projectId: run.project_id, pmThreadId: input.pmThreadId, runId: run.id, requestId: input.key, text, kind: "heavy" });
        if (id) { ctx.log(`phase intake: hand-over (${input.origin.slice(0, 80)}) is heavy (${by}); full-lifecycle ${id} started`); return { started: true, via: "full-lifecycle", id }; }
        return { started: false, kind, reason: "the full-lifecycle graph did not start" };
      }
      const phase = await phases.open({ projectId: run.project_id, pmThreadId: input.pmThreadId, title: intakeTitle(input.text), goal: text, rails: true });
      ctx.log(`phase intake: hand-over (${input.origin.slice(0, 80)}) is heavy (${by}); phase ${phase.id} opened`);
      await bestEffort(ctx.log, "phase handover tick", phases.tick(), { moved: 0, idle: null });
      return { started: true, via: "phase", id: phase.id };
    }
    if ((kind === "small" || kind === "batch" || downFull) && train && trainOn) {
      // Decided work the size reads as large or risky would stop at issue-quick's «proposed to the full path», which nobody takes up for a
      // hand-over: all four such lead runs of a month ended blocked there (hub, 2026-11-06). It goes down issue-full itself.
      const full = downFull || (decided && kind === "small" && (path.size === "large" || path.risk === "high"));
      const via = full ? "issue-full" : kind === "batch" ? "issue-batch" : "issue-quick";
      const id = train.start({ projectId: run.project_id, pmThreadId: input.pmThreadId, runId: run.id, requestId: input.key, text, kind: full ? "full" : kind, ...(kind === "small" ? { path } : {}) });
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
   * Why the PM may not dispatch by hand now, or null: the owner's newest request was heavy and its phase is not closed. The reading of the newest message is finished first, so a quick dispatch cannot slip past it.
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
    if (record?.kind !== "heavy" || !record.phaseId) return null;
    const phase = phases.list({ pmThreadId: threadId, live: true }).find((row) => row.id === record.phaseId);
    // A paused or stopped phase still holds the request: only a closed one releases it.
    if (!phase || phase.state === "closed") return null;
    return railsRefusal(phase, phases.status(phase.id).next.text);
  }

  return { take, dispatchRefusal, launchRefusal, classify: async (text: string) => { const { kind, by } = classifyBundle(text); return { kind, by }; }, handOver };
}
export type PhaseIntake = ReturnType<typeof createPhaseIntake>;

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
