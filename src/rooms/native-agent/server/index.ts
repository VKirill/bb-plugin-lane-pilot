// Public API of native-agent/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { agentRegistry } from "./agent-registry";
export type { AgentRegistry, RegistryResult } from "./agent-registry";
export { AGENTS_USAGE, runAgentsCli } from "./agents-cli";
export { createActivation } from "./activation";
export { LANE_WORKTREE_PROVIDER_ID, registerLaneWorktreeProvider } from "./environment-provider";
export { createBbShimEnv, createPmSkillTraceEnv, createRoleMarkerEnv, mountBbShim } from "./helper-bb-shim";
export { storeNativeSelection } from "./native-profile";
export { workspaceProviderRpc } from "./rpc/workspace-provider";
export { chatAgentState, isPmChat, switchChatAgent } from "./chat-agent-switch";
export { PM_SKILLS_USAGE, pmSkillName, pmSkillUseCounts, recordPmSkillUse, runPmSkillUseCli, runPmSkillsCli } from "./pm-skill-use";
export { PROFILE_CHECK_OWNER_KEY, PROFILE_CHECK_SCHEDULE, createProfileCheck, mountProfileCheck } from "./profile-check";
export type { ProfileCheckApi } from "./profile-check";
export type { PmSkillCount } from "./pm-skill-use";
