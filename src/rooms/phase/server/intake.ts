import { jev, type JevSettings } from "@lane-pilot/jev";
import { getRun, getRunSettingsScopes } from "../../storage";
import { stringAt, type ServerCore } from "../../core/server";
import { intakeByRules, intakeJudgment, intakeTitle, isMachineMessage, processHint, railsRefusal, type IntakeKind } from "../intake";
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
  start(input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch" }): string | null;
  status(wfRunId: string): string | null;
  /** The workflow architect, started with the owner's process as its order; resolves to its chat. */
  startProcess?(input: { projectId: string; pmThreadId: string; text: string }): Promise<string | null>;
};
const KEY = (threadId: string) => `phase-intake:${threadId}`;

type Deps = Pick<ServerCore, "bb" | "db" | "effectiveProjectSettings" | "log">;

/**
 * Rails by default: when a turn starts in a PM chat, the owner's newest message is read before the PM acts on it. A heavy goal
 * opens a phase (or joins the live one) and the driver wakes the PM with the stage's one step; the dispatch tool then refuses to
 * hand out that request's work by hand. Small jobs, batches, questions and consents keep their own roads. `phase.rails off`
 * turns it off for a project.
 */
export function createPhaseIntake(ctx: Deps, phases: IntakePhases, train?: IntakeTrain) {
  const { bb, db } = ctx;
  const pending = new Map<string, Promise<IntakeRecord | null>>();

  async function classify(text: string, projectId: string, runId: string | null, settings: Record<string, unknown>): Promise<{ kind: IntakeKind; by: "rules" | "jev" }> {
    const rules = intakeByRules(text);
    if (rules.confident) return { kind: rules.kind, by: "rules" };
    const instance = jev();
    try {
      if (instance?.enabled(settings as JevSettings)) {
        const verdict = await instance.judge(intakeJudgment, { text }, { projectId, runId, subject: "intake", settings: settings as JevSettings });
        if (verdict.by === "jev") return { kind: verdict.decision.kind, by: "jev" };
      }
    } catch { /* the rules' reading stands */ }
    return { kind: rules.kind, by: "rules" };
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
    const { kind, by } = await classify(text, run.project_id, run.id, settings);
    let phaseId: string | null = null;
    if (kind === "heavy") {
      const live = phases.list({ pmThreadId: threadId, live: true })[0];
      if (live) {
        // A new heavy message while a phase runs is the owner's correction of it (SMA: the owner may return 4 → 1); the PM reads it
        // in this very turn, and the dispatch refusal names the phase if it tries to hand the work out.
        phaseId = live.id;
      } else {
        const phase = await phases.open({ projectId: run.project_id, pmThreadId: threadId, title: intakeTitle(text), goal: text, rails: true });
        phaseId = phase.id;
        ctx.log(`phase intake: ${threadId} — the owner's request is heavy (${by}); phase ${phase.id} opened`);
        // The phase is booked now; the PM gets the discussion's step once its turn ends (the driver pokes an idle PM only).
        await phases.tick().catch(() => 0);
      }
    }
    // A small job or a batch of fixes goes down the small-task graph (issue-quick: triage, plan, build, report), started by the machine:
    // the orchestrator does not choose what runs (Matvey #31782). phase.train off leaves them to the PM as before.
    let wfRunId: string | undefined;
    // Only on the judgment's word: the length rule calls any short line «small», and a remark must not start a build.
    if ((kind === "small" || kind === "batch") && by === "jev" && train && String(settings["phase.train"] ?? "on") !== "off") {
      wfRunId = train.start({ projectId: run.project_id, pmThreadId: threadId, runId: run.id, requestId, text, kind }) ?? undefined;
      if (wfRunId) ctx.log(`phase intake: ${threadId} — the owner's request is ${kind} (${by}); issue-quick ${wfRunId} started`);
    }
    // A new process becomes a small graph: the workflow architect builds, tests and publishes it on the owner's words (Matvey #31916).
    let architectThreadId: string | undefined;
    if (kind === "process" && by === "jev" && train?.startProcess && String(settings["phase.train"] ?? "on") !== "off") {
      architectThreadId = await train.startProcess({ projectId: run.project_id, pmThreadId: threadId, text }).catch(() => null) ?? undefined;
      if (architectThreadId) ctx.log(`phase intake: ${threadId} — the owner's request is a process; the workflow architect builds it in ${architectThreadId}`);
    }
    const record: IntakeRecord = { requestId, kind, by, phaseId, at: Date.now(), ...(wfRunId ? { wfRunId } : {}), ...(architectThreadId ? { architectThreadId } : {}) };
    await bb.storage.kv.set(KEY(threadId), record);
    return record;
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

  return { take, dispatchRefusal, launchRefusal, classify };
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
