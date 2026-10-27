// Public API of native-agent/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { agentRegistry } from "./agent-registry";
export type { AgentRegistry, RegistryResult } from "./agent-registry";
export { AGENTS_USAGE, runAgentsCli } from "./agents-cli";
export { createActivation } from "./activation";
export { LANE_WORKTREE_PROVIDER_ID, registerLaneWorktreeProvider } from "./environment-provider";
export { createBbShimEnv, createRoleMarkerEnv, mountBbShim } from "./helper-bb-shim";
export { storeNativeSelection } from "./native-profile";
export { workspaceProviderRpc } from "./rpc/workspace-provider";
export { chatAgentState, switchChatAgent } from "./chat-agent-switch";
