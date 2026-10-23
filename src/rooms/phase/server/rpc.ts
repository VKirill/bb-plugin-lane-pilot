import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { PhaseApi } from "./driver";

/** Phases over RPC: the list, one phase with its book, and the controls a person has on the screen. */
export function phaseRpc(api: PhaseApi) {
  return {
    phase_list: async ({ projectId, pmThreadId, live }) => api.list({ projectId, pmThreadId, live }).map((phase) => ({ ...phase, next: api.status(phase.id).next })),
    phase_get: async ({ phaseId }) => api.status(phaseId),
    phase_control: async ({ phaseId, action, to, note }) => {
      if (action === "return") {
        if (!to || !note?.trim()) throw new Error("a return names the stage and carries a note");
        return api.status(api.returnTo({ phaseId, to, note, by: "owner" }).id);
      }
      if (action === "stop_wave") return { ...(await api.stopWave({ phaseId, by: "owner" })), status: api.status(phaseId) };
      if (action === "close" && !note?.trim()) throw new Error("closing in words carries the words");
      return api.status(api.setState({ phaseId, state: action, words: note, by: "owner" }).id);
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "phase_list" | "phase_get" | "phase_control">;
}
