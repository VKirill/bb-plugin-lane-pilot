import { choiceOf, jev, resolveThresholds, type JevSettings } from "@lane-pilot/jev";
import { getRun, getRunSettingsScopes } from "../../storage";
import { stringAt, type ServerCore } from "../../core/server";
import { isRunHalted, isRunPaused } from "../../runs/server";
import { pathClassByRules } from "@lane-pilot/workflow-engine";
import type { PathRisk, PathSize } from "@lane-pilot/workflow-engine";
import { intakeByRules, intakeJudgment, intakeTitle, isMachineMessage, pathClassJudgment, processHint, railsRefusal, type IntakeKind, type ServiceKind } from "../intake";
import { cancelAttemptById } from "../../runs/server";
import type { Phase } from "../logic";

/** What the intake needs of the phase driver (its own type, so the driver can build the intake without a type cycle). */
export type IntakePhases = {
  open(input: { projectId: string; pmThreadId: string; title: string; goal: string; rails?: boolean }): Promise<Phase>;
  tick(): Promise<number>;
  list(filter: { pmThreadId?: string; live?: boolean }): Phase[];
  status(phaseId: string): { next: { text: string } };
};

/** The last owner request of a PM chat as the intake read it. */
export type IntakeRecord = { requestId: string; kind: IntakeKind; by: "rules" | "jev"; phaseId: string | null; at: number; hinted?: boolean;
  /** The small-task graph the machine started for the request (issue-quick): the PM does not dispatch it by hand. */
  wfRunId?: string;
  /** The workflow architect's chat the machine started to build a process the request described. */
  architectThreadId?: string };

/** The machine's start of the small-task graph for a request, and the state of a run it started (src/rooms/phase/server/driver.ts wires them). */
export type IntakeTrain = {
  start(input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch"; path?: { size: PathSize; risk: PathRisk } }): string | null;
  status(wfRunId: string): string | null;
  /** The workflow architect, started with the owner's process as its order; resolves to its chat. */
  startProcess?(input: { projectId: string; pmThreadId: string; text: string }): Promise<string | null>;
};
const KEY = (threadId: string) => `phase-intake:${threadId}`;
/** What a hand-over key started, kept for good: the key maps to the phase or graph run whether it is alive or finished. */
const HANDOVER_KEY = (projectId: string, key: string) => `phase-handover:${projectId}:${key}`;
type HandOverStarted = { started: true; via: "phase" | "issue-quick" | "issue-batch"; id: string };
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

  /**
   * One bundled intake call (C1): kind, size and risk ride a single Jev request — the two judgments share one state, so
   * the bundle is one API call (speculative fan-out: the path questions are asked even when the kind ends up not small;
   * their answers are only read then). Confident rules skip the call for their side; an unsure verdict keeps the rules'
   * reading, and Jev down or off keeps the rules' reading of both.
   */
  async function classifyBundle(text: string, previous: string | null, projectId: string, runId: string | null, settings: Record<string, unknown>): Promise<{ kind: IntakeKind; path: { size: PathSize; risk: PathRisk }; by: "rules" | "jev" }> {
    const kindRules = intakeByRules(text);
    const pathRules = pathClassByRules(text);
    const path = { size: pathRules.size, risk: pathRules.risk };
    if (kindRules.confident && (kindRules.kind !== "small" || pathRules.confident)) return { kind: kindRules.kind, path, by: "rules" };
    const instance = jev();
    try {
      if (instance?.enabled(settings as JevSettings)) {
        const ctx = { projectId, runId, subject: "intake", settings: settings as JevSettings };
        // The bundle is one API call; a Jev without judgeBundle (a test fake, an older runtime) asks the two one by one.
        const [weight, cls] = typeof instance.judgeBundle === "function"
          ? await instance.judgeBundle([{ judgment: intakeJudgment, input: { text, previous } }, { judgment: pathClassJudgment, input: { text, previous } }], ctx)
          : await Promise.all([instance.judge(intakeJudgment, { text, previous }, ctx), instance.judge(pathClassJudgment, { text, previous }, ctx)]);
        const kind = kindRules.confident ? kindRules.kind : weight.by === "jev" ? weight.decision.kind : kindRules.kind;
        if (!pathRules.confident && cls.by === "jev") { path.size = cls.decision.size; path.risk = cls.decision.risk; }
        if (weight.by === "jev") {
          // Self-consistency on the border zone: a pick that just cleared the bar is re-asked with the options reversed;
          // a flip means the order carried it, and an unsure message starts nothing.
          const pick = choiceOf(weight.answers ?? {}, "weight");
          const minP = resolveThresholds(intakeJudgment, settings as JevSettings, null).min_p!;
          if (pick && kind !== "reply" && (pick.p < minP + 0.15 || pick.margin < 0.1)) {
            const again = await instance.judge(intakeJudgment, { text, previous, reverse: true }, ctx).catch(() => null);
            const second = again?.by === "jev" ? choiceOf(again.answers, "weight") : undefined;
            if (second && second.top !== pick.top) return { kind: "reply", path, by: "jev" };
          }
        }
        return { kind, path, by: weight.by === "jev" || cls.by === "jev" ? "jev" : "rules", ...(weight.by === "jev" && weight.decision.service ? { service: weight.decision.service, serviceP: weight.decision.service_p ?? 0 } : {}) };
      }
    } catch { /* the rules' reading stands */ }
    return { kind: kindRules.kind, path, by: "rules" };
  }

  /** The PM's last message in the chat, or null: the judgment reads the owner's message against it. */
  async function lastPmMessage(threadId: string): Promise<string | null> {
    const events = await bb.sdk.threads.events.list({ threadId, types: ["item/completed"], order: "desc", limit: "40" }).catch(() => []);
    for (const event of Array.isArray(events) ? events as Array<Record<string, unknown>> : []) {
      const item = ((event.data as Record<string, unknown> | undefined)?.item ?? (event as Record<string, unknown>).item) as { type?: string; text?: string } | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) return item.text;
    }
    return null;
  }

  async function read(threadId: string): Promise<IntakeRecord | null> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null) as Record<string, unknown> | null;
    if (metadata?.role !== "pm" || typeof metadata.lanePilotRunId !== "string") return null;
    const run = getRun(db, metadata.lanePilotRunId);
    if (!run) return null;
    const settings = await ctx.effectiveProjectSettings(run.project_id, getRunSettingsScopes(db, run.id)).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    if (String(settings["phase.rails"] ?? "on") === "off") return null;
    const listed = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "1" }).catch(() => []);
    const event = (Array.isArray(listed) ? listed[0] : null) as { data?: Record<string, unknown> } & Record<string, unknown> | null;
    const data = (event?.data ?? event ?? {}) as Record<string, unknown>;
    const requestId = typeof data.requestId === "string" ? data.requestId : null;
    const input = Array.isArray(data.input) ? data.input as Array<{ type?: string; text?: string }> : typeof data.input === "string" ? [{ type: "text", text: data.input }] : [];
    const text = input.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
    if (!requestId || !text || data.initiator === "agent" || isMachineMessage(text)) return null;
    const known = await bb.storage.kv.get(KEY(threadId)).catch(() => null) as IntakeRecord | null;
    if (known?.requestId === requestId) return known;
    const classified = await classifyBundle(text, await lastPmMessage(threadId), run.project_id, run.id, settings);
    const { kind, by, path } = classified;
    // A run the owner stopped or paused starts nothing on the machine's own (no phase, graph or architect): the PM reads the
    // message instead (live 2026-10-26, Vampirism Fire: work was stopped and issue-quick still built and merged wcebffdb8-T1).
    const stopped = await isRunHalted(bb.storage.kv as never, run.id) || await isRunPaused(bb.storage.kv as never, run.id);
    let phaseId: string | null = null;
    // №6: a service request is answered from the LP store, the heavy PM stays asleep. Anything ambiguous falls
    // back to `question` — the PM reads the message as before.
    if (kind === "service" && by === "jev" && !stopped) {
      const answered = await serviceAnswer({ run, threadId, text, service: (classified as { service?: ServiceKind }).service ?? null });
      if (answered !== null) {
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: answered, mentions: [] }] } as never).catch(() => undefined);
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
      } else if (!stopped) {
        const phase = await phases.open({ projectId: run.project_id, pmThreadId: threadId, title: intakeTitle(text), goal: text, rails: true });
        phaseId = phase.id;
        ctx.log(`phase intake: ${threadId} — the owner's request is heavy (${by}); phase ${phase.id} opened`);
        // The phase is booked now; the PM gets the discussion's step once its turn ends (the driver pokes an idle PM only).
        await phases.tick().catch(() => 0);
      }
    }
    // A small job goes down the small-task graph (issue-quick), a batch of fixes down issue-batch, started by the machine:
    // the orchestrator does not choose what runs (Matvey #31782). phase.train off leaves them to the PM as before.
    let wfRunId: string | undefined;
    // Only on the judgment's word: the length rule calls any short line «small», and a remark must not start a build.
    if ((kind === "small" || kind === "batch") && by === "jev" && train && !stopped && String(settings["phase.train"] ?? "on") !== "off") {
      wfRunId = train.start({ projectId: run.project_id, pmThreadId: threadId, runId: run.id, requestId, text, kind, ...(kind === "small" ? { path } : {}) }) ?? undefined;
      if (wfRunId) ctx.log(`phase intake: ${threadId} — the owner's request is ${kind} (${by}); ${kind === "batch" ? "issue-batch" : "issue-quick"} ${wfRunId} started`);
    }
    // A new process becomes a small graph: the workflow architect builds, tests and publishes it on the owner's words (Matvey #31916).
    let architectThreadId: string | undefined;
    if (kind === "process" && by === "jev" && train?.startProcess && !stopped && String(settings["phase.train"] ?? "on") !== "off") {
      architectThreadId = await train.startProcess({ projectId: run.project_id, pmThreadId: threadId, text }).catch(() => null) ?? undefined;
      if (architectThreadId) ctx.log(`phase intake: ${threadId} — the owner's request is a process; the workflow architect builds it in ${architectThreadId}`);
    }
    const record: IntakeRecord = { requestId, kind, by, phaseId, at: Date.now(), ...(wfRunId ? { wfRunId } : {}), ...(architectThreadId ? { architectThreadId } : {}) };
    await bb.storage.kv.set(KEY(threadId), record);
    return record;
  }

  /** №6: the one-line answer the LP store itself gives a service request, in Russian, with @thread links where they help. */
  async function serviceAnswer(input: { run: { id: string; project_id: string }; threadId: string; text: string; service: ServiceKind | null }): Promise<string | null> {
    const { run, text, service } = input;
    if (!service) return null;
    if (service === "status" || service === "current") {
      const rows = db.prepare(`SELECT t.id AS task_id, t.contract_json, a.state FROM lane_pilot_task t JOIN lane_pilot_attempt a ON a.task_id=t.id AND a.run_id=t.run_id WHERE t.run_id=? AND a.state IN ('running','queued','spawn_requested','spawn_unknown') ORDER BY a.attempt_no DESC LIMIT 10`).all(run.id) as Array<{ task_id: string; contract_json: string; state: string }>;
      if (!rows.length) return service === "current" ? "Сейчас ничего не идёт: открытых задач нет." : `Ран ${run.id}: открытых задач нет.`;
      const titles = rows.map((row) => { try { const c = JSON.parse(row.contract_json) as { title?: unknown; display_title?: unknown }; return String(c.display_title || c.title || row.task_id); } catch { return row.task_id; } });
      return service === "current" ? `Сейчас идёт: ${titles.slice(0, 3).join("; ")}${titles.length > 3 ? ` и ещё ${titles.length - 3}` : ""}.` : `Ран ${run.id}: ${titles.length} задач(и) в работе — ${titles.slice(0, 3).join("; ")}.`;
    }
    if (service === "results") {
      const rows = db.prepare(`SELECT t.contract_json, a.state, a.reason, a.thread_id FROM lane_pilot_task t JOIN lane_pilot_attempt a ON a.task_id=t.id AND a.run_id=t.run_id WHERE t.run_id=? AND a.state NOT IN ('running','queued','spawn_requested','spawn_unknown') ORDER BY a.updated_at DESC LIMIT 3`).all(run.id) as Array<{ contract_json: string; state: string; reason: string | null; thread_id: string | null }>;
      if (!rows.length) return "Завершённых задач пока нет.";
      return `Последние результаты: ${rows.map((row) => { let t = "?"; try { const c = JSON.parse(row.contract_json) as { title?: unknown; display_title?: unknown }; t = String(c.display_title || c.title || "?"); } catch { /* keep */ } const link = row.thread_id ? ` @thread:${row.thread_id}` : ""; return `${t} — ${row.state}${link}`; }).join("; ")}`;
    }
    if (service === "cancel") {
      // Only an unambiguous object: the task's id or title must match exactly one open task; else the PM reads the message.
      const open = db.prepare(`SELECT a.id AS attempt_id, t.contract_json FROM lane_pilot_task t JOIN lane_pilot_attempt a ON a.task_id=t.id AND a.run_id=t.run_id WHERE t.run_id=? AND a.state IN ('running','queued','spawn_requested','spawn_unknown')`).all(run.id) as Array<{ attempt_id: string; contract_json: string }>;
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
      const known = await bb.storage.kv.get(slot).catch(() => null) as Partial<HandOverStarted> | null;
      if (known && typeof known.id === "string" && (known.via === "phase" || known.via === "issue-quick" || known.via === "issue-batch")) return { started: true, via: known.via, id: known.id };
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
    const { kind, by, path } = await classifyBundle(input.text, null, run.project_id, run.id, settings);
    const text = `${input.origin}\n\n${input.text}`;
    if (kind === "heavy") {
      if (String(settings["phase.rails"] ?? "on") === "off") return { started: false, kind, reason: "phase rails are off" };
      const live = phases.list({ pmThreadId: input.pmThreadId, live: true })[0];
      if (live) return { started: false, kind, reason: `phase ${live.id} is already live in the PM chat` };
      const phase = await phases.open({ projectId: run.project_id, pmThreadId: input.pmThreadId, title: intakeTitle(input.text), goal: text, rails: true });
      ctx.log(`phase intake: hand-over (${input.origin.slice(0, 80)}) is heavy (${by}); phase ${phase.id} opened`);
      await phases.tick().catch(() => 0);
      return { started: true, via: "phase", id: phase.id };
    }
    if ((kind === "small" || kind === "batch") && train && String(settings["phase.train"] ?? "on") !== "off") {
      const id = train.start({ projectId: run.project_id, pmThreadId: input.pmThreadId, runId: run.id, requestId: input.key, text, kind, ...(kind === "small" ? { path } : {}) });
      if (id) { ctx.log(`phase intake: hand-over (${input.origin.slice(0, 80)}) is ${kind} (${by}); ${kind === "batch" ? "issue-batch" : "issue-quick"} ${id} started`); return { started: true, via: kind === "batch" ? "issue-batch" : "issue-quick", id }; }
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
    const record = await take(threadId) ?? await bb.storage.kv.get(KEY(threadId)).catch(() => null) as IntakeRecord | null;
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
      return `This request of the owner went down the small-task graph: Lane Pilot runs it itself (run ${record.wfRunId}: plan, build, report), and the result comes to this chat. Do not dispatch it or start a workflow for it by hand; tell the owner it is under way. If the owner asks for something else, that is a new request.`;
    }
    if (record?.kind !== "heavy" || !record.phaseId) return null;
    const phase = phases.list({ pmThreadId: threadId, live: true }).find((row) => row.id === record.phaseId);
    // A paused or stopped phase still holds the request: only a closed one releases it.
    if (!phase || phase.state === "closed") return null;
    return railsRefusal(phase, phases.status(phase.id).next.text);
  }

  return { take, dispatchRefusal, launchRefusal, classify: (text: string, projectId: string, runId: string | null, settings: Record<string, unknown>, previous: string | null = null) =>
    classifyBundle(text, previous, projectId, runId, settings).then(({ kind, by }) => ({ kind, by })), handOver };
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
