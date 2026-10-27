import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../contracts";
import { chatAgentState, switchChatAgent } from "../../native-agent/server";
import { finishRunSafely } from "../../runs/server";
import type { ServerCore } from "./core";

/** An existing chat's agent: what it runs now, and the change that applies from its next message. */
export function chatAgentRpc(ctx: ServerCore) {
  return {
    chat_agent_state: async ({ threadId }) => {
      const { status: _status, ...state } = await chatAgentState(ctx, threadId);
      return state;
    },
    switch_chat_agent: ({ threadId, agentId }) =>
      switchChatAgent(ctx, { threadId, agentId }, (projectId, runId) => finishRunSafely(ctx.bb, ctx.db, projectId, runId, "rpc")),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "chat_agent_state" | "switch_chat_agent">;
}
