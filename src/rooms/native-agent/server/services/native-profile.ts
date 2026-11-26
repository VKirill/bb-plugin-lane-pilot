import { nativeSelectionKey } from "../../../contracts";
import { MAIN_AGENT_PROFILE_IDS, isLanePmAgent, type ServerCore } from "../../../contracts/server";
import { compileEffectiveMainAgent, compileMainAgentProfile, type CustomAgentMeta } from "../../models/agent-profile";
import { sessionOverrideAgentsJson } from "../../models/native-agent-definition";
import { prepareNativeSessionRecord } from "./native-dispatch";
import { nativeAgentCliId } from "../../../contracts/native-agent-id";
import { type NativeSelection } from "../../../contracts/native-selection";

/**
 * A stored profile selection that turns the next Claude Code send of a thread into the given Lane Pilot agent:
 * the composer's «Enable Lane Pilot» and the PM's specialist threads both start their agents this way.
 * With `parentRunId` the thread belongs to that run instead of opening its own.
 */
export async function storeNativeSelection(ctx: Pick<ServerCore, "bb" | "ownedAgents">, input: { projectId: string; agentId: string; parentRunId?: string }): Promise<{ selection: NativeSelection; description: string; meta?: CustomAgentMeta }> {
  const shortId = nativeAgentCliId(input.agentId);
  const stored = (await ctx.ownedAgents())[shortId];
  if (stored?.compiledCorrupt) throw new Error(`compiled_main_agent_corrupt:${shortId}`);
  let compiled = null;
  try { compiled = compileEffectiveMainAgent(shortId, stored); } catch { compiled = null; }
  const stock = (MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(shortId) ? compileMainAgentProfile(shortId) : null;
  if (!compiled && !stock) throw new Error(`Unknown Lane Pilot profile ${shortId}.`);
  const activeProfile = compiled ?? stock!;
  if (isLanePmAgent(shortId)) {
    ctx.bb.log.debug(`pm prompt chars=${activeProfile.prompt.length} tools=${activeProfile.tools?.length ?? 0}`);
  }
  const record = await prepareNativeSessionRecord({
    projectId: input.projectId,
    agentId: shortId,
    // Stock and edited profiles both start from this compiled JSON. An installed Claude plugin agent is not required.
    profileMode: "session-override",
    agentsJson: sessionOverrideAgentsJson({
      agentId: shortId,
      edited: true,
      compiled: compiled ?? stock!,
      // An owner's agent may name its own model and effort.
      ...(stored?.meta?.model || stored?.meta?.effort ? { extraFields: { ...(stored.meta.model ? { model: stored.meta.model } : {}), ...(stored.meta.effort ? { effort: stored.meta.effort } : {}) } } : {}),
    }),
    sourceHash: compiled?.sourceHash ?? null,
    sourceVersion: compiled?.sourceVersion ?? stock?.sourceVersion ?? null,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  });
  await ctx.bb.storage.kv.set(nativeSelectionKey(record.token), record);
  return { selection: record, description: compiled?.description ?? shortId, ...(stored?.meta ? { meta: stored.meta } : {}) };
}
