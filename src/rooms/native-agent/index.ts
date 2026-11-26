// Public API of native-agent: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export type { EmployeeManifest } from "../contracts/server";
export { SKILL_CATALOG_BLOCK, SKILL_CATALOG_LINE, SKILL_CATALOG_LIMIT } from "./models/skill-catalog";
export { affinityHostId, chooseEmployeePlace, placeEmployeeOn } from "./models/employee-place";
export type { ListedHost } from "./models/employee-place";
export {
  RESOURCE_KEYS,
  applyResourceMode,
  collectAgentInventory,
  mergeInventoryItems,
  resourceModeOf,
} from "./models/agent-inventory";
export type { InventoryGroup, ResourceKey, ResourceMode } from "./models/agent-inventory";
export { UNLISTED_STOCK_IDS, compileEffectiveMainAgent, compileMainAgentProfile, detectCompiledMainAgentCapability, parseOwnedAgents } from "./models/agent-profile";
export type { CustomAgentMeta } from "./models/agent-profile";
export { agentListItem, createAgentInputSchema, parseAgentFile, updateAgentInputSchema } from "./models/custom-agent";
export type { AgentFailure } from "./models/custom-agent";
export { prepareBbShim } from "./bb-shim";
export { discoverClaudeAgents, prepareNativeClaude } from "./native-claude-host";
export { prepareClaudeGuard } from "./claude-guard-launch";
export { mentionContext } from "./models/native-session";
export { nativeAgentTypeKey, nativeEnvGenerationKey, nativeEnvKey, nativeSelectionKey, nativeThreadKey } from "../contracts";
export { reconcileClaudeLane } from "./native-lane-reconcile";
export { writerWorkspaceForPmInstructions } from "./models/native-dispatch-placement";
export { NATIVE_LP_BRIDGE_PM_TOOLS } from "./models/bridge-tools";
export { LANE_PILOT_PM_SESSION } from "./models/native-agent-overlay";
export { pendingSwitch } from "./models/native-session";
export { resolveWriterBinding } from "./models/project-binding";
export type { ProjectSourceBinding, WriterBindingResolution } from "./models/project-binding";
export { sessionInventory } from "./session-inventory";
export { PARITY_LAYERS, permissionEntries, terminalParity } from "./models/terminal-parity";
export type { ParityLayer, ParityLayerSet, ParityLine } from "./models/terminal-parity";
export { pmSkillName } from "./models/pm-skill";
export { ARCHITECT_LAUNCH, WORKFLOW_ARCHITECT_NAME, WORKFLOW_ARCHITECT_SESSION, WORKFLOW_ARCHITECT_TOOLS } from "./models/workflow-architect";
export { requestArchitectLaunch, takeArchitectLaunch } from "./models/architect-launch";
export { agentKind } from "./models/agent-profile";
export { HELPER_DISALLOWED_TOOLS, WRITER_DISALLOWED_TOOLS, WRITER_MAX_TURNS } from "./models/claude-guard";
