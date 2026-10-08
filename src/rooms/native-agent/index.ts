// Public API of native-agent: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { agentPickerLabel } from "./agent-display";
export { applyResourceMode, collectAgentInventory } from "./agent-inventory";
export { MAIN_AGENT_PROFILE_IDS, compileEffectiveMainAgent, compileMainAgentProfile, detectCompiledMainAgentCapability, parseOwnedAgents } from "./agent-profile";
export { prepareBbShim } from "./bb-shim";
export { ACCESS_GROUPS, ACCESS_SWITCHES, CORE_PROVIDER_GROUPS, HELPER_ROLES, MANDATORY_BB_PLUGINS, MANDATORY_MCP_SERVERS, ROLE_PROFILES, detectRequiredSessionPolicyCapability, effectiveGroup, effectiveSwitch, parseHelperContextSettings, parseRoleAccess, roleAccessKey } from "./helper-context";
export type { ExtraAccess, HelperPolicySnapshot, HelperRole } from "./helper-context";
export { discoverClaudeAgents, prepareNativeClaude } from "./native-claude-host";
export { handleNativeDispatch, mentionContext, nativeContributedEnv } from "./native-dispatch";
export { reconcileClaudeLane } from "./native-lane-reconcile";
export { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun, writerWorkspaceForPmInstructions } from "./native-run";
export { NATIVE_LP_BRIDGE_PM_TOOLS } from "./native-session-hooks";
export { DEFAULT_NATIVE_AGENT, NATIVE_MENTION_PROVIDER, nativeAgentCliId, nativeSelectionSchema } from "./native-session";
export { resolveWriterBinding } from "./project-binding";
export type { ProjectSourceBinding, WriterBindingResolution } from "./project-binding";
export { userVisibleProjects } from "./project-scope";
export type { ListedProject } from "./project-scope";
export { sessionInventory } from "./session-inventory";
