// Public API of native-agent/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { room } from "./room";
export { agentRegistry } from "./services/agent-registry";
export type { AgentRegistry, RegistryResult } from "./services/agent-registry";
export { AGENTS_USAGE, runAgentsCli } from "./handlers/agents-cli";
export { createActivation } from "./services/activation";
export { startChildPm } from "./services/child-pm";
export { createRecipientResolver } from "./services/recipient";
export { LANE_WORKTREE_PROVIDER_ID, registerLaneWorktreeProvider } from "./handlers/environment-provider";
export { createBbShimEnv, createPmSkillTraceEnv, createRoleMarkerEnv, mountBbShim, writerPushBlockEnv } from "./services/helper-bb-shim";
export { storeNativeSelection } from "./services/native-profile";
export { workspaceProviderRpc } from "./handlers/workspace-provider-rpc";
export { chatAgentState, isPmChat, switchChatAgent } from "./services/chat-agent-switch";
export { PM_SKILLS_USAGE, pmSkillName, pmSkillUseCounts, recordPmSkillUse } from "./services/pm-skill-use";
export type { PmSkillCount } from "./services/pm-skill-use";
export { runPmSkillUseCli, runPmSkillsCli } from "./handlers/pm-skills-cli";
export { createClaudeGuardEnv } from "./services/claude-guard-env";
export { handleNativeDispatch, nativeContributedEnv } from "./services/native-dispatch";
export { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun } from "./services/native-run";
export { attemptSessionLayers, terminalSessionLayers } from "./services/terminal-parity";
export { handleDirectoryMove, recoverDirectoryMove } from "./services/directory-move";
export {
  STANDALONE_SPECIALIST_SKILL_PACKS,
  createNativeSpecialistSessionPolicy,
  mountNativeSpecialistSessionPolicy,
  specialistProfileAccess,
  type SessionPolicyContextLike,
} from "./services/specialist-session-policy";
