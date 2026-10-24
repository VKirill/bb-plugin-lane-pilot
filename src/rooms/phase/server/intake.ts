import { jev, type JevSettings } from "@lane-pilot/jev";
import { getRun, getRunSettingsScopes } from "../../storage";
import type { ServerCore } from "../../core/server";
import { intakeByRules, intakeJudgment, intakeTitle, isMachineMessage, railsRefusal, type IntakeKind } from "../intake";
import type { Phase } from "../logic";

/** What the intake needs of the phase driver (its own type, so the driver can build the intake without a type cycle). */
export type IntakePhases = {
  open(input: { projectId: string; pmThreadId: string; title: string; goal: string }): Promise<Phase>;
  tick(): Promise<number>;
  list(filter: { pmThreadId?: string; live?: boolean }): Phase[];
  status(phaseId: string): { next: { text: string } };
};

/** The last owner request of a PM chat as the intake read it. */
export type IntakeRecord = { requestId: string; kind: IntakeKind; by: "rules" | "jev"; phaseId: string | null; at: number };
const KEY = (threadId: string) => `phase-intake:${threadId}`;

type Deps = Pick<ServerCore, "bb" | "db" | "effectiveProjectSettings" | "log">;

/**
 * Rails by default: when a turn starts in a PM chat, the owner's newest message is read before the PM acts on it. A heavy goal
 * opens a phase (or joins the live one) and the driver wakes the PM with the stage's one step; the dispatch tool then refuses to
 * hand out that request's work by hand. Small jobs, batches, questions and consents keep their own roads. `phase.rails off`
 * turns it off for a project.
 */
export function createPhaseIntake(ctx: Deps, phases: IntakePhases) {
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
        phaseId = live.id;
        // A new heavy message while a phase runs is the owner's correction of it (SMA: the owner may return 4 → 1).
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
          `[Lane Pilot phase] The owner's new message belongs to phase ${live.id} «${live.title}» (stage ${live.stage}). If it changes the goal, report it with lane_pilot_phase revise (goal, note) or return the phase to an earlier stage (return, to, note); a note for the pieces at work goes with correct.` }] } as never).catch(() => undefined);
      } else {
        const phase = await phases.open({ projectId: run.project_id, pmThreadId: threadId, title: intakeTitle(text), goal: text });
        phaseId = phase.id;
        ctx.log(`phase intake: ${threadId} — the owner's request is heavy (${by}); phase ${phase.id} opened`);
        // The driver wakes the PM with the discussion's one step now, not at the next two-minute pass.
        await phases.tick().catch(() => 0);
      }
    }
    const record: IntakeRecord = { requestId, kind, by, phaseId, at: Date.now() };
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

  /**
   * Why the PM may not dispatch by hand now, or null: the owner's newest request was heavy and its phase is live (not paused,
   * not closed). The reading of the newest message is finished first, so a quick dispatch cannot slip past it.
   */
  async function dispatchRefusal(threadId: string): Promise<string | null> {
    const record = await take(threadId) ?? await bb.storage.kv.get(KEY(threadId)).catch(() => null) as IntakeRecord | null;
    if (record?.kind !== "heavy" || !record.phaseId) return null;
    const phase = phases.list({ pmThreadId: threadId, live: true }).find((row) => row.id === record.phaseId);
    if (!phase || phase.state !== "active") return null;
    return railsRefusal(phase, phases.status(phase.id).next.text);
  }

  return { take, dispatchRefusal, classify };
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
