import { findOpenNativeRun, listOpenAttempts } from "../../storage";
import { listPhases } from "../../phase";
import { agentKind, compileEffectiveMainAgent } from "../agent-profile";
import { nativeAgentCliId, nativeSelectionSchema, nativeSwitchKey, pendingSwitch, type NativeSelection } from "../native-session";
import { storeNativeSelection } from "./native-profile";
import { stringAt, valueAt } from "../../core/server";
import type { ServerCore } from "../../core/server";

/** A chat whose reply is running (or starting or stopping) keeps its agent until the reply ends. */
const LIVE_STATUSES = new Set(["starting", "active", "stopping"]);

export type ChatAgentReason = "helper" | "provider" | "lane_started" | "specialist_run";
export type ChatAgent = { agentId: string; description: string; pending: boolean };
export type ChatAgentState = { projectId: string; eligible: boolean; reason: ChatAgentReason | null; current: ChatAgent | null };

const REASON_TEXT: Record<ChatAgentReason, string> = {
  helper: "This is a helper chat of a Lane Pilot run; its agent is fixed by the run.",
  provider: "Agents run in Claude Code. This chat uses another provider: start a new Claude Code chat.",
  lane_started: "Lane Pilot started this chat itself, with its agent fixed at the start. Open a new chat to use another.",
  specialist_run: "This chat works inside another chat's run; its agent is fixed by that run.",
};

async function readSelection(ctx: Pick<ServerCore, "bb">, key: string): Promise<NativeSelection | null> {
  const raw = await ctx.bb.storage.kv.get(key).catch(() => null);
  const parsed = raw ? nativeSelectionSchema.safeParse(raw) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Whether a chat's agent is the Lane Pilot PM (the coordinator); every other agent, the owner's own included, is a specialist (agentKind).
 * Lane Pilot's door (the run that the PM chat leads, the project's activation, the notices of its tasks) belongs to a chat only while it runs the PM.
 */
const isPmAgent = (agentId: string): boolean => agentKind(nativeAgentCliId(agentId)) === "coordinator";

/**
 * Whether a chat may be taken for the project's PM chat: one Lane Pilot started itself (no agent binding) or one that runs the PM agent. A chat that runs a
 * specialist has a run of its own (its tools need one) but leads nothing, so the readers of «the PM chat» (a scheduled report, the backlog) skip it.
 */
export async function isPmChat(ctx: Pick<ServerCore, "bb">, threadId: string): Promise<boolean> {
  const bound = await readSelection(ctx, `native-thread:${threadId}`);
  return !bound || isPmAgent(bound.agentId);
}

/** What still works for the PM chat's run, in words; null when nothing does. The move away from the PM waits for it instead of orphaning it. */
function liveWork(db: ServerCore["db"], projectId: string, runId: string, threadId: string): string | null {
  const parts: string[] = [];
  const writers = listOpenAttempts(db).filter((attempt) => attempt.run_id === runId);
  if (writers.length) parts.push(`${writers.length} task${writers.length === 1 ? " is" : "s are"} at work`);
  for (const phase of listPhases(db, { pmThreadId: threadId, projectId, live: true })) parts.push(`phase «${phase.title}» is live`);
  const graphs = (db.prepare("SELECT count(*) AS n FROM lane_pilot_wf_run WHERE link_run_id=? AND parent_run_id IS NULL AND status IN ('running','waiting')").get(runId) as { n: number }).n;
  if (graphs) parts.push(`${graphs} workflow run${graphs === 1 ? " is" : "s are"} going`);
  return parts.length ? `Lane Pilot still works for this chat: ${parts.join("; ")}. Wait until they end or cancel them, then change the agent.` : null;
}

async function describe(ctx: Pick<ServerCore, "ownedAgents">, selection: NativeSelection, pending: boolean): Promise<ChatAgent> {
  const shortId = nativeAgentCliId(selection.agentId);
  let compiled = null;
  try { compiled = compileEffectiveMainAgent(shortId, (await ctx.ownedAgents())[shortId]); } catch { compiled = null; }
  return { agentId: selection.agentId, description: compiled?.description ?? shortId, pending };
}

/** Whether the chat can change its agent, and which agent it runs now (or will on the next message). */
export async function chatAgentState(ctx: Pick<ServerCore, "bb" | "ownedAgents">, threadId: string): Promise<ChatAgentState & { status: string | null }> {
  const { bb } = ctx;
  const thread = await bb.sdk.threads.get({ threadId });
  const projectId = stringAt(thread, "projectId") ?? "";
  const role = valueAt(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null), "role");
  const bound = await readSelection(ctx, `native-thread:${threadId}`);
  const pending = await pendingSwitch(bb.storage.kv, threadId);
  let reason: ChatAgentReason | null = null;
  if (typeof role === "string" && role && role !== "pm") reason = "helper";
  else if (role === "pm" && !bound) reason = "lane_started";
  else if (bound?.parentRunId) reason = "specialist_run";
  else if ((stringAt(thread, "providerId") ?? "claude-code") !== "claude-code") reason = "provider";
  const shown = pending ?? bound;
  return {
    projectId,
    eligible: reason === null,
    reason,
    current: shown ? await describe(ctx, shown, Boolean(pending)) : null,
    status: stringAt(thread, "status"),
  };
}

/**
 * Changes the agent of an existing chat. BB's Claude Code session fixes its launcher (--agent, --agents, the model of the
 * agent) when it is constructed, and a changed environment rebuilds the session with the launcher it already has. What
 * BB documents is `threads.stop`: it releases the thread's loaded runtime, and the next message resumes the same
 * conversation with the launcher contributed for that message. So the switch stores the chosen profile, releases the
 * runtime, and the chat's next message (handleNativeDispatch) binds it, claims the run and prepares the launcher.
 *
 * The PM chat is the one that leads the Lane Pilot run. Moving it to a specialist, or turning the agent off (`agentId: null`), hands that lead back: the run is
 * finished (which closes it and the project's activation), the chat loses its PM role and run marker, and the next message reaches the new agent as in any
 * plain chat. It waits while writers, a phase or a workflow run still work for the chat: the move is refused with what is going, and changes nothing. A move
 * between agents that both lead (or both do not) keeps the run as it was.
 */
export async function switchChatAgent(
  ctx: Pick<ServerCore, "bb" | "db" | "ownedAgents">,
  input: { threadId: string; agentId: string | null },
  finishRun: (projectId: string, runId: string) => Promise<void>,
): Promise<{ agentId: string | null; description: string | null }> {
  const { bb, db } = ctx;
  const { threadId } = input;
  const state = await chatAgentState(ctx, threadId);
  if (!state.eligible) throw new Error(REASON_TEXT[state.reason!]);
  if (LIVE_STATUSES.has(state.status ?? "")) throw new Error("Wait until the reply ends: the agent changes between messages.");
  const bound = await readSelection(ctx, `native-thread:${threadId}`);
  const leavesPm = Boolean(bound) && isPmAgent(bound!.agentId) && (input.agentId === null || !isPmAgent(input.agentId));

  /** Hands the lead back: nothing is erased before the run has gone through, so a refusal leaves the chat as it was (the pending pick, the binding and the run stay). */
  const leavePm = async () => {
    const runId = findOpenNativeRun(db, state.projectId, threadId);
    if (runId) {
      const busy = liveWork(db, state.projectId, runId, threadId);
      if (busy) throw new Error(busy);
      // Finishing the run also stops the chat and refuses while its tasks are at work.
      await finishRun(state.projectId, runId);
    } else await bb.sdk.threads.stop({ threadId });
    await bb.storage.kv.delete(nativeSwitchKey(threadId));
    await bb.sdk.threads.updatePluginMetadata({ threadId, remove: ["role", "lanePilotRunId"] });
    for (const key of ["native-thread", "native-env", "native-agent-type"]) await bb.storage.kv.delete(`${key}:${threadId}`);
  };

  if (input.agentId === null) {
    if (bound) await leavePm();
    else await bb.storage.kv.delete(nativeSwitchKey(threadId));
    return { agentId: null, description: null };
  }

  if (leavesPm) {
    // The pick is stored only after the run has gone through; the chat is already stopped, so the next message binds the specialist.
    await leavePm();
    const { selection, description } = await storeNativeSelection(ctx, { projectId: state.projectId, agentId: input.agentId });
    await bb.storage.kv.set(nativeSwitchKey(threadId), selection.token);
    return { agentId: selection.agentId, description };
  }

  const { selection, description } = await storeNativeSelection(ctx, { projectId: state.projectId, agentId: input.agentId });
  if (bound && !state.current?.pending && bound.agentId === selection.agentId && bound.sourceHash === selection.sourceHash) {
    return { agentId: selection.agentId, description };
  }
  await bb.storage.kv.set(nativeSwitchKey(threadId), selection.token);
  // A chat nothing was sent to has no runtime to release.
  if (state.status !== "pending") await bb.sdk.threads.stop({ threadId });
  return { agentId: selection.agentId, description };
}
