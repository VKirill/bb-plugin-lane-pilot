import type { NativeSelection } from "./native-selection";
import type { ComposerSelectionSnapshot } from "./composer-selection";
import type { StoredAgentRow, CompiledMainAgent, CustomAgentMeta } from "./server-core";

export type EmployeePlace =
  | { mode: "inherit" }
  | { mode: "folder"; hostId: string; path: string; created: boolean }
  | { mode: "fallback"; hostId: string; reason: string };

/** The activation call, implemented by src/rooms/native-agent (createActivation). */
export interface ActivationApi {
  activate(projectId: string, sourceThreadId: string | null, kind?: "bb" | "cli", agentId?: string | null, snapshot?: ComposerSelectionSnapshot, options?: { sectionId?: string | null }): Promise<{ threadId:string; runId:string }>;
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

/**
 * The KV keys of a native lane session: the selection a mention token names, the selection a chat is bound to, the env
 * contributed to its provider and the agent id it runs as. The pending composer switch key is `nativeSwitchKey`
 * (native-agent/native-session.ts). tests/native-kv-keys.test.ts pins the strings.
 */
export const nativeSelectionKey = (token: string) => `native-selection:${token}`;
export const nativeThreadKey = (threadId: string) => `native-thread:${threadId}`;
export const nativeEnvKey = (threadId: string) => `native-env:${threadId}`;
export const nativeAgentTypeKey = (threadId: string) => `native-agent-type:${threadId}`;
