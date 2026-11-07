import type { NativeSelection } from "./native-selection";
import type { ComposerSelectionSnapshot } from "./composer-selection";
import type { StoredAgentRow, CompiledMainAgent, CustomAgentMeta } from "./server-core";

export type EmployeePlace =
  | { mode: "inherit" }
  | { mode: "folder"; hostId: string; path: string; created: boolean }
  | { mode: "fallback"; hostId: string; reason: string };

/** The activation call, implemented by src/rooms/native-agent (createActivation). */
export interface ActivationApi {
  activate(projectId: string, sourceThreadId: string | null, kind?: "bb" | "cli", agentId?: string | null, snapshot?: ComposerSelectionSnapshot): Promise<{ threadId:string; runId:string }>;
}

/**
 * The agent-selection surface the runs room calls, implemented by src/rooms/native-agent and wired in server.ts.
 * `bb`/`kv` are bound at the seam, so these signatures carry only the domain arguments.
 */
export interface AgentOpsApi {
  placeEmployeeOn(agentId: string, sources: ReadonlyArray<{ hostId?: string | undefined; path?: string | undefined }>): Promise<EmployeePlace>;
  storeNativeSelection(input: { projectId: string; agentId: string; parentRunId?: string }): Promise<{ selection: NativeSelection; description: string; meta?: CustomAgentMeta }>;
  compileEffectiveMainAgent(id: string, stored?: StoredAgentRow): CompiledMainAgent;
  detectCompiledMainAgentCapability(agents: { experimental_vkCompiledMainAgent?: unknown }): "supported" | "none";
  pendingSwitch(threadId: string): Promise<NativeSelection | null>;
}
