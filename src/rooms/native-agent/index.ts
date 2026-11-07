// Public API of native-agent: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export type { EmployeeManifest } from "../contracts/server";
export { SKILL_CATALOG_BLOCK, SKILL_CATALOG_LINE, SKILL_CATALOG_LIMIT } from "./skill-catalog";
export { affinityHostId, chooseEmployeePlace, placeEmployeeOn } from "./employee-place";
export { employeeRoleLines, recordRoleLine, withRoleLines } from "./employee-lessons";
export type { ListedHost } from "./employee-place"
export { applyResourceMode, collectAgentInventory } from "./agent-inventory";
export { UNLISTED_STOCK_IDS, compileEffectiveMainAgent, compileMainAgentProfile, detectCompiledMainAgentCapability, parseOwnedAgents } from "./agent-profile"
export type { CustomAgentMeta } from "./agent-profile"
export { agentListItem, createAgentInputSchema, parseAgentFile, updateAgentInputSchema } from "./custom-agent"
export type { AgentFailure } from "./custom-agent"
export { prepareBbShim } from "./bb-shim";
export { discoverClaudeAgents, prepareNativeClaude } from "./native-claude-host";
export { createClaudeGuardEnv, prepareClaudeGuard } from "./claude-guard-launch";
export { handleNativeDispatch, mentionContext, nativeContributedEnv } from "./native-dispatch";
export { nativeAgentTypeKey, nativeEnvKey, nativeSelectionKey, nativeThreadKey } from "./native-kv";
export { reconcileClaudeLane } from "./native-lane-reconcile";
export { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun, writerWorkspaceForPmInstructions } from "./native-run";
export { NATIVE_LP_BRIDGE_PM_TOOLS } from "./native-session-hooks";
export { LANE_PILOT_PM_SESSION } from "./native-agent-overlay";
export { pendingSwitch } from "./native-session"
export { resolveWriterBinding } from "./project-binding";
export type { ProjectSourceBinding, WriterBindingResolution } from "./project-binding";
export { sessionInventory } from "./session-inventory";
export { pmSkillName } from "./server/pm-skill-use";
export { PROFILE_CHECK_WINDOW_MS, buildProfileReport, helperThreads, latestProfileCheck, narrowedByCeiling, profileCheckMorningLine, providerVerdicts, rolePolicyCounts, saveProfileCheck } from "./profile-check";
export type { HelperThreadRow, ProfileReport, ProviderVerdict, RolePolicyCount } from "./profile-check";
export { ARCHITECT_LAUNCH, WORKFLOW_ARCHITECT_NAME, WORKFLOW_ARCHITECT_SESSION, WORKFLOW_ARCHITECT_TOOLS } from "./workflow-architect";
export { requestArchitectLaunch, takeArchitectLaunch } from "./architect-launch";
export { agentKind } from "./agent-profile";
