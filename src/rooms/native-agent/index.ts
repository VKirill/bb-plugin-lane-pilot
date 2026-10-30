// Public API of native-agent: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { EMPLOYEES, EMPLOYEE_IDS, RESULT_EXISTS, coreSkillsOf, employeeView, installEmployeeSpecialists, isEmployeeSpecialist, resultExists, stockEmployee } from "./employee-manifest";
export type { EmployeeManifest, MachineAffinity } from "./employee-manifest";
export { SKILL_CATALOG_BLOCK, SKILL_CATALOG_LINE, SKILL_CATALOG_LIMIT } from "./skill-catalog";
export { AFFINITY_HOSTS, chooseEmployeePlace, placeEmployeeOn } from "./employee-place";
export { employeeRoleLines, recordRoleLine, roleLinesKey, withRoleLines } from "./employee-lessons";
export type { EmployeePlace } from "./employee-place";
export { agentPickerLabel } from "./agent-display";
export { applyResourceMode, collectAgentInventory } from "./agent-inventory";
export { MAIN_AGENT_ID, MAIN_AGENT_PROFILE_IDS, agentKind, isStockProfileId, compileEffectiveMainAgent, compileMainAgentProfile, detectCompiledMainAgentCapability, parseOwnedAgents } from "./agent-profile";
export type { AgentKind, CustomAgentMeta } from "./agent-profile";
export { agentListItem, createAgentInputSchema, isCustomAgentId, isReservedAgentId, parseAgentFile, pickableAgent, updateAgentInputSchema } from "./custom-agent";
export type { AgentFailure, AgentListItem } from "./custom-agent";
export { prepareBbShim } from "./bb-shim";
export { ACCESS_GROUPS, ACCESS_SWITCHES, CORE_PROVIDER_GROUPS, HELPER_ROLES, MANDATORY_BB_PLUGINS, MANDATORY_MCP_SERVERS, ROLE_PROFILES, detectRequiredSessionPolicyCapability, effectiveGroup, effectiveSwitch, parseHelperContextSettings, parseRoleAccess, roleAccessKey } from "./helper-context";
export type { ExtraAccess, HelperPolicySnapshot, HelperRole } from "./helper-context";
export { discoverClaudeAgents, prepareNativeClaude } from "./native-claude-host";
export { createClaudeGuardEnv, prepareClaudeGuard } from "./claude-guard-launch";
export { handleNativeDispatch, mentionContext, nativeContributedEnv } from "./native-dispatch";
export { reconcileClaudeLane } from "./native-lane-reconcile";
export { finalizeNativeLaneBinding, nativeRunReady, ownedNativePmRun, writerWorkspaceForPmInstructions } from "./native-run";
export { NATIVE_LP_BRIDGE_PM_TOOLS } from "./native-session-hooks";
export { DEFAULT_NATIVE_AGENT, NATIVE_MENTION_PROVIDER, nativeAgentCliId, nativeSelectionSchema, pendingSwitch } from "./native-session";
export { resolveWriterBinding } from "./project-binding";
export type { ProjectSourceBinding, WriterBindingResolution } from "./project-binding";
export { userVisibleProjects } from "./project-scope";
export type { ListedProject } from "./project-scope";
export { sessionInventory } from "./session-inventory";
export {
  PM_CONTEXT_MAX_CHARS,
  buildPmContextContent,
  compilePmContextFromDb,
  formatPmContextSection,
  getPmContextSummary,
  getStoredPmContext,
  pmContextMorningLine,
  savePmContext,
  type PmContextData,
  type PmContextTask,
  type PmContextRule,
  type PmContextWall,
  type PmContextSummary,
} from "./pm-context";
