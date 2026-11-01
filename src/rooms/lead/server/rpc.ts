import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { Db } from "./journal";
import { renderRoadTree, roadTree } from "./road";
import type { LeadApi } from "./service";

/** The lead's RPC: the Self-improvement strip reads `lead_state`, the owner's list presses `lead_decide`, the buttons start a tick or the chat. */
export function leadRpc(db: Db, lead: LeadApi) {
  return {
    lead_state: async () => lead.state(),
    lead_road: async ({ projectId, history }) => {
      const nodes = roadTree(db, { ...(projectId !== undefined ? { projectId } : {}), history: history ?? false });
      return { nodes, text: renderRoadTree(nodes) };
    },
    lead_decide: async ({ roadId, decision, text }) => lead.decide(roadId, decision, text, "screen"),
    lead_label: async ({ id, label }) => ({ ok: lead.label(id, label), id, label }),
    lead_tick_now: async () => lead.runTick("manual"),
    lead_set_enabled: async ({ on }) => { lead.setEnabled(on, "screen"); return { ok: true as const, enabled: on }; },
    lead_chat_start: async ({ sectionId }) => lead.chatStart(sectionId ? { sectionId } : {}),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "lead_state" | "lead_road" | "lead_decide" | "lead_label" | "lead_tick_now" | "lead_set_enabled" | "lead_chat_start">;
}
