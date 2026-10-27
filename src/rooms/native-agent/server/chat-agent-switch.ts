import { findOpenNativeRun } from "../../storage";
import { compileEffectiveMainAgent } from "../agent-profile";
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
 * `agentId: null` unbinds: the chat's run is finished and the chat is plain again.
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

  if (input.agentId === null) {
    if (bound) {
      const runId = findOpenNativeRun(db, state.projectId, threadId);
      // Finishing the run also stops the chat and refuses while its tasks are at work: nothing is erased before it has gone through,
      // so a refusal leaves the chat as it was (the pending pick, the binding and the run stay).
      if (runId) await finishRun(state.projectId, runId);
      else await bb.sdk.threads.stop({ threadId });
      await bb.storage.kv.delete(nativeSwitchKey(threadId));
      await bb.sdk.threads.updatePluginMetadata({ threadId, remove: ["role", "lanePilotRunId"] });
      for (const key of ["native-thread", "native-env", "native-agent-type"]) await bb.storage.kv.delete(`${key}:${threadId}`);
    } else await bb.storage.kv.delete(nativeSwitchKey(threadId));
    return { agentId: null, description: null };
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
